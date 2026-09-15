import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";

import {
  inspect_local_file_lock,
  recover_local_file_lock,
} from "../src/ts/dist/index.js";

const repoRoot = process.cwd();
const isWindows = process.platform === "win32";
const exe = isWindows ? ".exe" : "";
const rustProbe = resolve(repoRoot, `src/rust/target/debug/examples/local_file_probe${exe}`);
const goProbe = resolve(repoRoot, `tmp/local-file-go-probe${exe}`);
const nodeProbe = resolve(repoRoot, "src/ts/test/local-file-process-probe.mjs");
const gleamRoot = resolve(repoRoot, "src/gleam");
const runtimes = ["rust", "go", "node", "gleam"];
const report = [];

function commandFor(runtime, mode, lockPath, owner, holdMs = 0) {
  if (runtime === "rust") {
    return { command: rustProbe, args: [mode, lockPath, owner, String(holdMs)], cwd: repoRoot };
  }
  if (runtime === "go") {
    return { command: goProbe, args: [mode, lockPath, owner, String(holdMs)], cwd: repoRoot };
  }
  if (runtime === "node") {
    return {
      command: process.execPath,
      args: [nodeProbe, mode, lockPath, owner, String(holdMs)],
      cwd: repoRoot,
    };
  }
  if (runtime === "gleam") {
    return {
      command: "gleam",
      args: [
        "run",
        "-m",
        "local_file_probe",
        "--",
        mode,
        dirname(lockPath),
        basename(lockPath),
        owner,
        String(holdMs),
      ],
      cwd: gleamRoot,
    };
  }
  throw new Error(`unknown runtime ${runtime}`);
}

function startProbe(runtime, mode, lockPath, owner, holdMs = 0) {
  const spec = commandFor(runtime, mode, lockPath, owner, holdMs);
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exit = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal, stdout, stderr }));
  });
  return { child, exit, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

async function runProbe(runtime, mode, lockPath, owner, holdMs = 0) {
  return startProbe(runtime, mode, lockPath, owner, holdMs).exit;
}

async function waitForAcquired(probe, timeoutMs = 20_000) {
  const started = Date.now();
  for (;;) {
    if (probe.stdout.includes("ACQUIRED")) return;
    if (Date.now() - started > timeoutMs) {
      probe.child.kill();
      throw new Error(`timed out waiting for ACQUIRED; stdout=${probe.stdout} stderr=${probe.stderr}`);
    }
    const outcome = await Promise.race([
      probe.exit.then((value) => ({ type: "exit", value })),
      new Promise((resolveWait) => setTimeout(() => resolveWait({ type: "tick" }), 20)),
    ]);
    if (outcome.type === "exit") {
      throw new Error(`probe exited before ACQUIRED: ${JSON.stringify(outcome.value)}`);
    }
  }
}

async function assertHeld(lockPath, owner) {
  assert.deepEqual(await inspect_local_file_lock(lockPath), { state: "held", owner });
}

async function assertAbsent(lockPath) {
  assert.equal((await inspect_local_file_lock(lockPath)).state, "absent");
}

function record(name, details = {}) {
  report.push({ name, status: "passed", ...details });
  console.log(`PASS ${name}`);
}

async function expectRecoveryRefusal(lockPath, expectedOwner, confirmedInactive, actualOwner) {
  await assert.rejects(
    recover_local_file_lock(lockPath, expectedOwner, confirmedInactive),
    (error) => error?.kind === "compromised" || error?.kind === "invalid_input",
  );
  await assertHeld(lockPath, actualOwner);
}

async function proveSixthOrder(root) {
  // 8. Whitespace-bearing path components survive direct argv boundaries.
  for (const runtime of runtimes) {
    const lockPath = join(root, " leading-space", `trailing-space -${runtime}.lock`);
    const result = await runProbe(runtime, "try", lockPath, `whitespace-path-${runtime}`);
    assert.equal(result.code, 0, `${runtime} whitespace path failed: ${result.stderr}`);
    await assertAbsent(lockPath);
  }
  record("argv-whitespace-path-components-round-trip-all-runtimes");

  // 9. Safe shell metacharacters must remain argv data; spawn never enables a shell.
  const metacharPath = join(root, "argv-[literal]-$-!-{x}.lock");
  for (const runtime of runtimes) {
    const result = await runProbe(runtime, "try", metacharPath, `metachar-owner-${runtime}`);
    assert.equal(result.code, 0, `${runtime} metachar path failed: ${result.stderr}`);
  }
  record("argv-shell-metacharacters-are-never-shell-interpreted");

  // 10. Owner identity preserves surrounding whitespace exactly.
  for (const runtime of runtimes) {
    const lockPath = join(root, `owner-whitespace-${runtime}.lock`);
    const owner = `  owner-${runtime}  `;
    const holder = startProbe(runtime, "hold", lockPath, owner, 1_000);
    await waitForAcquired(holder);
    await assertHeld(lockPath, owner);
    const result = await holder.exit;
    assert.equal(result.code, 0, `${runtime} whitespace owner holder failed: ${result.stderr}`);
  }
  record("owner-surrounding-whitespace-is-exact-all-runtimes");

  // 11. Tabs/newlines are valid identity bytes and survive the process boundary.
  for (const runtime of runtimes) {
    const lockPath = join(root, `owner-control-${runtime}.lock`);
    const owner = `owner\t${runtime}\nline-2`;
    const holder = startProbe(runtime, "hold", lockPath, owner, 1_000);
    await waitForAcquired(holder);
    await assertHeld(lockPath, owner);
    const result = await holder.exit;
    assert.equal(result.code, 0, `${runtime} control-character owner failed: ${result.stderr}`);
  }
  record("owner-tab-newline-identity-round-trips-all-runtimes");

  // 12. Unicode normalization-equivalent owner spellings are not recovery aliases.
  {
    const lockPath = join(root, "owner-normalization-recovery.lock");
    const actualOwner = "caf\u00e9-owner";
    const normalizedAlias = "cafe\u0301-owner";
    const crashed = await runProbe("rust", "crash", lockPath, actualOwner);
    assert.equal(crashed.code, 30);
    await expectRecoveryRefusal(lockPath, normalizedAlias, true, actualOwner);
    assert.equal(await recover_local_file_lock(lockPath, actualOwner, true), true);
  }
  record("normalization-equivalent-owner-cannot-authorize-recovery");

  // 13. Owner identity is case-sensitive during recovery.
  {
    const lockPath = join(root, "owner-case-recovery.lock");
    const actualOwner = "Owner-Case-Sensitive";
    const crashed = await runProbe("go", "crash", lockPath, actualOwner);
    assert.equal(crashed.code, 30);
    await expectRecoveryRefusal(lockPath, actualOwner.toLowerCase(), true, actualOwner);
    assert.equal(await recover_local_file_lock(lockPath, actualOwner, true), true);
  }
  record("case-different-owner-cannot-authorize-recovery");

  // 14. Operator confirmation is mandatory and refusal is non-destructive.
  {
    const lockPath = join(root, "recovery-confirmation-required.lock");
    const owner = "confirmation-owner";
    const crashed = await runProbe("node", "crash", lockPath, owner);
    assert.equal(crashed.code, 30);
    await expectRecoveryRefusal(lockPath, owner, false, owner);
    assert.equal(await recover_local_file_lock(lockPath, owner, true), true);
  }
  record("recovery-without-inactive-confirmation-is-nondestructive");

  // 15. Empty expected recovery owner is rejected before mutation.
  {
    const lockPath = join(root, "recovery-empty-owner.lock");
    const owner = "nonempty-owner";
    const crashed = await runProbe("gleam", "crash", lockPath, owner);
    assert.equal(crashed.code, 30);
    await expectRecoveryRefusal(lockPath, "", true, owner);
    assert.equal(await recover_local_file_lock(lockPath, owner, true), true);
  }
  record("empty-recovery-owner-is-nondestructive");

  // 16. Oversized expected recovery owner is rejected before mutation.
  {
    const lockPath = join(root, "recovery-oversized-owner.lock");
    const owner = "bounded-owner";
    const crashed = await runProbe("rust", "crash", lockPath, owner);
    assert.equal(crashed.code, 30);
    await expectRecoveryRefusal(lockPath, "x".repeat(513), true, owner);
    assert.equal(await recover_local_file_lock(lockPath, owner, true), true);
  }
  record("oversized-recovery-owner-is-nondestructive");

  // 17. Diagnostics are non-mutating while each runtime holds ownership.
  for (const runtime of runtimes) {
    const lockPath = join(root, `diagnostic-holder-${runtime}.lock`);
    const owner = `diagnostic-${runtime}`;
    const holder = startProbe(runtime, "hold", lockPath, owner, 1_500);
    await waitForAcquired(holder);
    const inspections = await Promise.all(
      Array.from({ length: 16 }, () => inspect_local_file_lock(lockPath)),
    );
    assert.ok(
      inspections.every((inspection) => inspection.state === "held" && inspection.owner === owner),
      `${runtime} diagnostics drifted: ${JSON.stringify(inspections)}`,
    );
    const result = await holder.exit;
    assert.equal(result.code, 0, `${runtime} holder failed after diagnostics: ${result.stderr}`);
  }
  record("concurrent-diagnostics-are-nondestructive-for-each-runtime-holder");

  // 18. Heavy diagnostics during a mixed contender wave never clear the holder.
  {
    const lockPath = join(root, "diagnostic-contender-wave.lock");
    const owner = "diagnostic-wave-holder";
    const holder = startProbe("node", "hold", lockPath, owner, 3_000);
    await waitForAcquired(holder);
    const contenders = Array.from({ length: 16 }, (_, index) =>
      runProbe(runtimes[index % runtimes.length], "try", lockPath, `wave-${index}`));
    const inspections = Array.from({ length: 64 }, () => inspect_local_file_lock(lockPath));
    const [contenderResults, inspectionResults] = await Promise.all([
      Promise.all(contenders),
      Promise.all(inspections),
    ]);
    assert.ok(contenderResults.every((result) => result.code === 10), JSON.stringify(contenderResults));
    assert.ok(
      inspectionResults.every((inspection) => inspection.state === "held" && inspection.owner === owner),
      JSON.stringify(inspectionResults),
    );
    const holderResult = await holder.exit;
    assert.equal(holderResult.code, 0, holderResult.stderr);
  }
  record("sixty-four-inspections-during-mixed-contender-wave-remain-held");

  // 19. Every runtime's crash state can be explicitly recovered then reacquired by that runtime.
  for (const runtime of runtimes) {
    const lockPath = join(root, `same-runtime-recovery-${runtime}.lock`);
    const owner = `crash-owner-${runtime}`;
    const crashed = await runProbe(runtime, "crash", lockPath, owner);
    assert.equal(crashed.code, 30, `${runtime} crash failed: ${crashed.stderr}`);
    await assertHeld(lockPath, owner);
    assert.equal(await recover_local_file_lock(lockPath, owner, true), true);
    const reacquired = await runProbe(runtime, "try", lockPath, `reacquired-${runtime}`);
    assert.equal(reacquired.code, 0, `${runtime} failed same-runtime reacquire: ${reacquired.stderr}`);
    await assertAbsent(lockPath);
  }
  record("all-runtimes-crash-recover-and-same-runtime-reacquire");

  // 20. Nested caller-owned parent with Unicode/spaces survives the four-runtime handoff.
  {
    const parent = join(root, " caller parent λ ", "nested 子 directory");
    await mkdir(parent, { recursive: true });
    const lockPath = join(parent, "handoff.lock");
    for (const runtime of runtimes) {
      const result = await runProbe(runtime, "try", lockPath, `nested-parent-${runtime}`);
      assert.equal(result.code, 0, `${runtime} nested-parent handoff failed: ${result.stderr}`);
      await assertAbsent(lockPath);
    }
    assert.deepEqual(await readdir(parent), [], "caller-owned nested parent must remain empty");
  }
  record("unicode-space-caller-parent-survives-four-runtime-handoff");
}

const root = await mkdtemp(join(tmpdir(), "ores-local-sixth-order-"));
try {
  await proveSixthOrder(root);
  assert.equal(report.length, 13, `sixth-order batch must execute exactly 13 checks; got ${report.length}`);
  console.log(JSON.stringify({ status: "passed", checks: report }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
