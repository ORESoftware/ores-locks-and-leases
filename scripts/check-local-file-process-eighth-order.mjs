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

async function holdAndInspectEveryRuntime(root, label, owner) {
  assert.equal([...owner].length, 512, `${label} owner must be exactly 512 Unicode scalars`);
  for (const runtime of runtimes) {
    const lockPath = join(root, `${label}-${runtime}.lock`);
    const holder = startProbe(runtime, "hold", lockPath, owner, 1_500);
    await waitForAcquired(holder);
    await assertHeld(lockPath, owner);
    const result = await holder.exit;
    assert.equal(result.code, 0, `${runtime} ${label} holder failed: ${result.stderr}`);
    await assertAbsent(lockPath);
  }
}

async function proveEighthOrder(root) {
  // 1. Mixed-width UTF-8 at the exact scalar bound stays exact while live.
  const mixedWidthOwner = "aé中😀".repeat(128);
  await holdAndInspectEveryRuntime(root, "mixed-width-512", mixedWidthOwner);
  record("mixed-width-512-scalar-owner-live-readback-all-runtimes");

  // 2. Grapheme-heavy input must still be counted by Unicode scalars, not graphemes/UTF-16 units.
  const graphemeHeavyOwner = "👩‍💻".repeat(170) + "e\u0301";
  await holdAndInspectEveryRuntime(root, "grapheme-heavy-512", graphemeHeavyOwner);
  record("grapheme-heavy-512-scalar-owner-live-readback-all-runtimes");

  // 3. Bidi controls are identity bytes/scalars, not normalization instructions.
  for (const runtime of runtimes) {
    const lockPath = join(root, `bidi-owner-${runtime}.lock`);
    const owner = `owner-${runtime}-\u2066segment\u2069-\u202Eend`;
    const holder = startProbe(runtime, "hold", lockPath, owner, 1_000);
    await waitForAcquired(holder);
    await assertHeld(lockPath, owner);
    const result = await holder.exit;
    assert.equal(result.code, 0, `${runtime} bidi owner failed: ${result.stderr}`);
  }
  record("bidi-control-owner-live-readback-is-exact-all-runtimes");

  // 4. ZWJ-bearing identity is preserved exactly.
  for (const runtime of runtimes) {
    const lockPath = join(root, `zwj-owner-${runtime}.lock`);
    const owner = `owner-${runtime}-a\u200Db`;
    const holder = startProbe(runtime, "hold", lockPath, owner, 1_000);
    await waitForAcquired(holder);
    await assertHeld(lockPath, owner);
    const result = await holder.exit;
    assert.equal(result.code, 0, `${runtime} ZWJ owner failed: ${result.stderr}`);
  }
  record("zero-width-joiner-owner-live-readback-is-exact-all-runtimes");

  // 5. Leading hyphens remain argv data rather than probe options.
  for (const runtime of runtimes) {
    const lockPath = join(root, `leading-hyphen-owner-${runtime}.lock`);
    const result = await runProbe(runtime, "try", lockPath, `--owner-${runtime}`);
    assert.equal(result.code, 0, `${runtime} leading-hyphen owner failed: ${result.stderr}`);
    await assertAbsent(lockPath);
  }
  record("leading-hyphen-owner-is-argv-data-all-runtimes");

  // 6. A final path component beginning with '-' is literal filesystem data.
  for (const runtime of runtimes) {
    const lockPath = join(root, `-${runtime}-literal.lock`);
    const result = await runProbe(runtime, "try", lockPath, `hyphen-path-${runtime}`);
    assert.equal(result.code, 0, `${runtime} leading-hyphen path failed: ${result.stderr}`);
    await assertAbsent(lockPath);
  }
  record("leading-hyphen-lock-name-round-trips-all-runtimes");

  // 7. Punctuation deliberately excludes Windows-reserved characters <>:\"/\\|?*.
  const punctuationPath = join(root, "literal-#%&=+@,;!()-path.lock");
  for (const runtime of runtimes) {
    const result = await runProbe(runtime, "try", punctuationPath, `punctuation-${runtime}`);
    assert.equal(result.code, 0, `${runtime} punctuation path failed: ${result.stderr}`);
    await assertAbsent(punctuationPath);
  }
  record("windows-safe-punctuation-path-round-trips-all-runtimes");

  // 8. Same basename in unrelated parents must not become a process-global key.
  const sameBasenameHolders = runtimes.map((runtime, index) => {
    const lockPath = join(root, `same-basename-parent-${index}`, "shared.lock");
    return {
      runtime,
      lockPath,
      owner: `same-basename-${runtime}`,
      probe: startProbe(runtime, "hold", lockPath, `same-basename-${runtime}`, 5_000),
    };
  });
  await Promise.all(sameBasenameHolders.map(({ probe }) => waitForAcquired(probe)));
  for (const { lockPath, owner } of sameBasenameHolders) await assertHeld(lockPath, owner);
  const sameBasenameResults = await Promise.all(sameBasenameHolders.map(({ probe }) => probe.exit));
  assert.ok(sameBasenameResults.every((result) => result.code === 0), JSON.stringify(sameBasenameResults));
  record("same-basename-distinct-parents-hold-concurrently-across-runtimes");

  // 9. Crash state is rendezvous-local even within the same runtime implementation.
  for (const runtime of runtimes) {
    const crashPath = join(root, `same-runtime-crash-${runtime}-a.lock`);
    const siblingPath = join(root, `same-runtime-crash-${runtime}-b.lock`);
    const owner = `same-runtime-crash-owner-${runtime}`;
    const crashed = await runProbe(runtime, "crash", crashPath, owner);
    assert.equal(crashed.code, 30, `${runtime} crash setup failed: ${crashed.stderr}`);
    const sibling = await runProbe(runtime, "try", siblingPath, `sibling-${runtime}`);
    assert.equal(sibling.code, 0, `${runtime} sibling lock was blocked by unrelated crash state: ${sibling.stderr}`);
    await assertHeld(crashPath, owner);
    assert.equal(await recover_local_file_lock(crashPath, owner, true), true);
  }
  record("same-runtime-crash-held-lock-does-not-block-sibling-rendezvous");

  // 10. Explicit crash recovery owns only the rendezvous, not caller directories.
  // Windows rejects trailing-space path components by contract. Keep the
  // stronger surrounding-whitespace spelling on POSIX while Windows still
  // exercises Unicode and embedded spaces with a portable parent component.
  for (const runtime of runtimes) {
    const parent = join(
      root,
      isWindows ? `caller parent-${runtime}-λ` : ` caller-parent-${runtime}-λ `,
      "nested 子",
    );
    await mkdir(parent, { recursive: true });
    const lockPath = join(parent, "crash-recovery.lock");
    const owner = `parent-recovery-${runtime}`;
    const crashed = await runProbe(runtime, "crash", lockPath, owner);
    assert.equal(crashed.code, 30, `${runtime} parent crash setup failed: ${crashed.stderr}`);
    assert.equal(await recover_local_file_lock(lockPath, owner, true), true);
    assert.deepEqual(await readdir(parent), [], `${runtime} recovery removed or dirtied caller parent`);
  }
  record("crash-recovery-preserves-unicode-caller-parent-all-runtimes");

  // 11. Parallel wrong-owner recovery must remain read-only/fail-closed.
  {
    const lockPath = join(root, "parallel-wrong-recovery.lock");
    const owner = "parallel-correct-owner";
    const crashed = await runProbe("rust", "crash", lockPath, owner);
    assert.equal(crashed.code, 30);
    const attempts = await Promise.allSettled(
      Array.from({ length: 32 }, (_, index) =>
        recover_local_file_lock(lockPath, `parallel-wrong-${index}`, true)),
    );
    assert.ok(
      attempts.every((attempt) => attempt.status === "rejected" && attempt.reason?.kind === "compromised"),
      JSON.stringify(attempts),
    );
    await assertHeld(lockPath, owner);
    assert.equal(await recover_local_file_lock(lockPath, owner, true), true);
  }
  record("thirty-two-parallel-wrong-owner-recoveries-are-nondestructive");

  // 12. Crash-held diagnostics remain stable under parallel readers.
  {
    const lockPath = join(root, "parallel-crash-inspection.lock");
    const owner = "parallel-crash-inspection-owner";
    const crashed = await runProbe("go", "crash", lockPath, owner);
    assert.equal(crashed.code, 30);
    const inspections = await Promise.all(
      Array.from({ length: 32 }, () => inspect_local_file_lock(lockPath)),
    );
    assert.ok(
      inspections.every((inspection) => inspection.state === "held" && inspection.owner === owner),
      JSON.stringify(inspections),
    );
    await assertHeld(lockPath, owner);
    assert.equal(await recover_local_file_lock(lockPath, owner, true), true);
  }
  record("thirty-two-parallel-crash-held-inspections-remain-held");

  // 13. Recovery erases producer-runtime identity; the next runtime can reacquire cleanly.
  for (let index = 0; index < runtimes.length; index += 1) {
    const producer = runtimes[index];
    const consumer = runtimes[(index + 1) % runtimes.length];
    const lockPath = join(root, `cross-runtime-recovery-${producer}-to-${consumer}.lock`);
    const owner = `cross-runtime-crash-${producer}`;
    const crashed = await runProbe(producer, "crash", lockPath, owner);
    assert.equal(crashed.code, 30, `${producer} crash setup failed: ${crashed.stderr}`);
    await assertHeld(lockPath, owner);
    assert.equal(await recover_local_file_lock(lockPath, owner, true), true);
    const reacquired = await runProbe(consumer, "try", lockPath, `post-recovery-${consumer}`);
    assert.equal(reacquired.code, 0, `${consumer} failed to reacquire after ${producer}: ${reacquired.stderr}`);
    await assertAbsent(lockPath);
  }
  record("all-crash-producers-recover-then-different-runtime-reacquires");

  // 14. Zero-width insertion creates a different recovery identity.
  {
    const lockPath = join(root, "zwj-recovery-identity.lock");
    const owner = "exact-recovery-owner";
    const crashed = await runProbe("node", "crash", lockPath, owner);
    assert.equal(crashed.code, 30);
    await assert.rejects(
      recover_local_file_lock(lockPath, "exact-recovery-\u200Downer", true),
      (error) => error?.kind === "compromised",
    );
    await assertHeld(lockPath, owner);
    assert.equal(await recover_local_file_lock(lockPath, owner, true), true);
  }
  record("zero-width-insertion-cannot-authorize-recovery");

  // 15. Bidi-control insertion likewise remains a distinct recovery identity.
  {
    const lockPath = join(root, "bidi-recovery-identity.lock");
    const owner = "bidi-recovery-owner";
    const crashed = await runProbe("gleam", "crash", lockPath, owner);
    assert.equal(crashed.code, 30);
    await assert.rejects(
      recover_local_file_lock(lockPath, "bidi-\u2066recovery-owner", true),
      (error) => error?.kind === "compromised",
    );
    await assertHeld(lockPath, owner);
    assert.equal(await recover_local_file_lock(lockPath, owner, true), true);
  }
  record("bidi-control-insertion-cannot-authorize-recovery");
}

const root = await mkdtemp(join(tmpdir(), "ores-local-process-eighth-order-"));
try {
  await proveEighthOrder(root);
  assert.equal(report.length, 15, `eighth-order batch must execute exactly 15 checks, got ${report.length}`);
  console.log(JSON.stringify({ status: "passed", checks: report }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}