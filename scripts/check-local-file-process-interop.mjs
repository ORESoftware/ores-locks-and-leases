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
const gleamEbinRoot = resolve(gleamRoot, "build/dev/erlang");
const gleamEbinPaths = (await readdir(gleamEbinRoot))
  .sort()
  .map((name) => resolve(gleamEbinRoot, name, "ebin"));
const gleamCodePathArgs = gleamEbinPaths.flatMap((path) => ["-pa", path]);
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
      command: "erl",
      args: [
        "-noshell",
        ...gleamCodePathArgs,
        "-s",
        "local_file_probe",
        "main",
        "-s",
        "init",
        "stop",
        "-extra",
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

async function waitForAcquired(probe, timeoutMs = 20_000) {
  const started = Date.now();
  for (;;) {
    if (probe.stdout.includes("ACQUIRED")) return;
    if (Date.now() - started > timeoutMs) {
      probe.child.kill();
      throw new Error(`timed out waiting for ACQUIRED; stdout=${probe.stdout} stderr=${probe.stderr}`);
    }
    const exited = await Promise.race([
      probe.exit.then((value) => ({ type: "exit", value })),
      new Promise((resolveWait) => setTimeout(() => resolveWait({ type: "tick" }), 20)),
    ]);
    if (exited.type === "exit") {
      throw new Error(`probe exited before ACQUIRED: ${JSON.stringify(exited.value)}`);
    }
  }
}

async function runProbe(runtime, mode, lockPath, owner, holdMs = 0) {
  return startProbe(runtime, mode, lockPath, owner, holdMs).exit;
}

async function assertAbsent(lockPath, message = "lock must be absent") {
  assert.equal((await inspect_local_file_lock(lockPath)).state, "absent", message);
}

function record(name, details = {}) {
  report.push({ name, status: "passed", ...details });
  console.log(`PASS ${name}`);
}

async function proveHolderRotation(root) {
  for (let i = 0; i < runtimes.length; i += 1) {
    const holderRuntime = runtimes[i];
    const lockPath = join(root, `rotation-${holderRuntime}.lock`);
    const holder = startProbe(holderRuntime, "hold", lockPath, `holder-${holderRuntime}`, 8_000);
    await waitForAcquired(holder);

    const contenders = runtimes.filter((runtime) => runtime !== holderRuntime);
    const results = await Promise.all(
      contenders.map((runtime) => runProbe(runtime, "try", lockPath, `contender-${runtime}`)),
    );
    for (let j = 0; j < results.length; j += 1) {
      assert.equal(
        results[j].code,
        10,
        `${contenders[j]} must contend while ${holderRuntime} owns ${lockPath}: ${results[j].stderr}`,
      );
    }
    const holderResult = await holder.exit;
    assert.equal(holderResult.code, 0, `${holderRuntime} holder failed: ${holderResult.stderr}`);

    const nextRuntime = runtimes[(i + 1) % runtimes.length];
    const reacquired = await runProbe(nextRuntime, "try", lockPath, `reacquire-${nextRuntime}`);
    assert.equal(reacquired.code, 0, `${nextRuntime} failed to reacquire after ${holderRuntime}`);
    record(`holder-${holderRuntime}-contends-other-runtimes-and-releases`, {
      holder: holderRuntime,
      contenders,
      reacquirer: nextRuntime,
    });
  }
}

async function oneWinnerRace(runtimeList, lockPath, prefix, holdMs = 2_000, ownerFactory) {
  const probes = runtimeList.map((runtime, index) =>
    startProbe(
      runtime,
      "hold",
      lockPath,
      ownerFactory ? ownerFactory(runtime, index) : `${prefix}-${runtime}-${index}`,
      holdMs,
    ));
  const results = await Promise.all(probes.map((probe) => probe.exit));
  const winners = results.filter((result) => result.code === 0);
  const contenders = results.filter((result) => result.code === 10);
  assert.equal(winners.length, 1, `expected exactly one winner, got ${JSON.stringify(results)}`);
  assert.equal(contenders.length, results.length - 1, `non-winners must be contention: ${JSON.stringify(results)}`);
  await assertAbsent(lockPath, "winner must release cleanly after the race");
}

async function proveExistingProcessBatch(root) {
  const stressCases = [
    ["node-16-one-winner", Array(16).fill("node"), "rust"],
    ["rust-12-one-winner", Array(12).fill("rust"), "go"],
    ["go-12-one-winner", Array(12).fill("go"), "gleam"],
    ["gleam-4-one-winner", Array(4).fill("gleam"), "node"],
    ["mixed-16-one-winner", ["rust", "go", "node", "gleam", "rust", "go", "node", "gleam", "rust", "go", "node", "gleam", "rust", "go", "node", "gleam"], "rust"],
  ];

  for (const [name, runtimeList, reacquirer] of stressCases) {
    const lockPath = join(root, `${name}.lock`);
    await oneWinnerRace(runtimeList, lockPath, name, runtimeList.includes("gleam") ? 6_000 : 2_000);
    record(name, { contenders: runtimeList.length });

    const reacquired = await runProbe(reacquirer, "try", lockPath, `post-${name}-${reacquirer}`);
    assert.equal(reacquired.code, 0, `${reacquirer} must reacquire after ${name}`);
    record(`${name}-post-race-${reacquirer}-reacquire`);
  }

  const crashOwners = new Map();
  for (let i = 0; i < runtimes.length; i += 1) {
    const runtime = runtimes[i];
    const nextRuntime = runtimes[(i + 1) % runtimes.length];
    const lockPath = join(root, `crash-${runtime}.lock`);
    const owner = `crashed-${runtime}-owner`;
    crashOwners.set(runtime, { lockPath, owner });

    const crashed = await runProbe(runtime, "crash", lockPath, owner);
    assert.equal(crashed.code, 30, `${runtime} crash probe must terminate after acquisition`);
    const inspection = await inspect_local_file_lock(lockPath);
    assert.deepEqual(inspection, { state: "held", owner });
    const contender = await runProbe(nextRuntime, "try", lockPath, `after-crash-${nextRuntime}`);
    assert.equal(contender.code, 10, `${nextRuntime} must not steal ${runtime}'s crash-held lock`);
    record(`crash-${runtime}-remains-held-and-not-stealable`, { contender: nextRuntime });
  }

  const rustCrash = crashOwners.get("rust");
  await assert.rejects(
    recover_local_file_lock(rustCrash.lockPath, "wrong-owner", true),
    (error) => error?.kind === "compromised",
  );
  assert.equal((await inspect_local_file_lock(rustCrash.lockPath)).state, "held");
  record("wrong-owner-recovery-preserves-crash-held-lock");

  assert.equal(await recover_local_file_lock(rustCrash.lockPath, rustCrash.owner, true), true);
  const afterRecovery = await runProbe("node", "try", rustCrash.lockPath, "post-recovery-node");
  assert.equal(afterRecovery.code, 0, "different runtime must reacquire after explicit recovery");
  record("expected-owner-recovery-enables-cross-runtime-reacquire");

  for (const runtime of ["go", "node", "gleam"]) {
    const crash = crashOwners.get(runtime);
    assert.equal(await recover_local_file_lock(crash.lockPath, crash.owner, true), true);
  }
}

async function proveFifthOrderProcessBoundaryBatch(root) {
  // 1. Invalid mode must fail before touching the filesystem in every probe.
  for (const runtime of runtimes) {
    const lockPath = join(root, `invalid-mode-${runtime}.lock`);
    const result = await runProbe(runtime, "invalid-mode", lockPath, `owner-${runtime}`);
    assert.equal(result.code, 2, `${runtime} invalid mode must be usage failure`);
    await assertAbsent(lockPath, `${runtime} invalid mode mutated lock state`);
  }
  record("probe-invalid-mode-fails-before-filesystem-mutation");

  // 2. Negative hold durations are rejected before acquisition.
  for (const runtime of runtimes) {
    const lockPath = join(root, `negative-hold-${runtime}.lock`);
    const result = await runProbe(runtime, "hold", lockPath, `owner-${runtime}`, -1);
    assert.equal(result.code, 2, `${runtime} negative hold must be usage failure`);
    await assertAbsent(lockPath, `${runtime} negative hold mutated lock state`);
  }
  record("probe-negative-hold-fails-before-filesystem-mutation");

  // 3. Paths containing spaces survive the executable/argv boundary.
  const spacedPath = join(root, "space directory", "install lock.lock");
  for (const runtime of runtimes) {
    const result = await runProbe(runtime, "try", spacedPath, `space-owner-${runtime}`);
    assert.equal(result.code, 0, `${runtime} failed spaced-path round trip: ${result.stderr}`);
  }
  record("argv-space-path-round-trips-all-runtimes");

  // 4. Unicode paths survive each executable boundary without normalization by the harness.
  const unicodePath = join(root, "锁-ñ", "paquete-😀.lock");
  for (const runtime of runtimes) {
    const result = await runProbe(runtime, "try", unicodePath, `unicode-path-${runtime}`);
    assert.equal(result.code, 0, `${runtime} failed Unicode path round trip: ${result.stderr}`);
  }
  record("argv-unicode-path-round-trips-all-runtimes");

  // 5. Unicode owner identities round-trip through every process implementation.
  const unicodeOwnerPath = join(root, "unicode-owner.lock");
  for (const runtime of runtimes) {
    const result = await runProbe(runtime, "try", unicodeOwnerPath, `owner-${runtime}-λ-😀`);
    assert.equal(result.code, 0, `${runtime} rejected valid Unicode owner: ${result.stderr}`);
  }
  record("argv-unicode-owner-round-trips-all-runtimes");

  // 6. The exact 512-code-point owner boundary is admitted by every process probe.
  const maxOwner = "😀".repeat(512);
  for (const runtime of runtimes) {
    const lockPath = join(root, `max-owner-${runtime}.lock`);
    const result = await runProbe(runtime, "try", lockPath, maxOwner);
    assert.equal(result.code, 0, `${runtime} rejected 512-code-point owner: ${result.stderr}`);
  }
  record("argv-max-owner-boundary-admitted-all-runtimes");

  // 7. A 513-code-point owner is rejected without creating lock state.
  const oversizedOwner = "😀".repeat(513);
  for (const runtime of runtimes) {
    const lockPath = join(root, `oversized-owner-${runtime}.lock`);
    const result = await runProbe(runtime, "try", lockPath, oversizedOwner);
    assert.equal(result.code, 20, `${runtime} must reject oversized owner: ${result.stderr}`);
    await assertAbsent(lockPath, `${runtime} oversized owner mutated lock state`);
  }
  record("argv-oversized-owner-rejected-before-state-all-runtimes");

  // 8. Empty owner is rejected without creating state.
  for (const runtime of runtimes) {
    const lockPath = join(root, `empty-owner-${runtime}.lock`);
    const result = await runProbe(runtime, "try", lockPath, "");
    assert.ok(result.code === 20 || result.code === 2, `${runtime} must reject empty owner: ${JSON.stringify(result)}`);
    await assertAbsent(lockPath, `${runtime} empty owner mutated lock state`);
  }
  record("argv-empty-owner-rejected-before-state-all-runtimes");

  // 9. Equality of owner tokens never grants recursive/cross-process ownership.
  const sameTokenPath = join(root, "same-token-mixed.lock");
  await oneWinnerRace(
    ["rust", "go", "node", "gleam", "rust", "go", "node", "gleam"],
    sameTokenPath,
    "same-token",
    8_000,
    () => "identical-owner-token",
  );
  record("same-owner-token-mixed-process-race-has-one-winner");

  // 10. Higher-pressure mixed-runtime race remains exactly one-winner. Gleam process startup
  // serializes on its build directory on some macOS runners, so keep the first winner alive long
  // enough for every started contender to reach the lock attempt within the same ownership window.
  const mixed32 = Array.from({ length: 32 }, (_, index) => runtimes[index % runtimes.length]);
  await oneWinnerRace(mixed32, join(root, "mixed-32.lock"), "mixed32", 45_000);
  record("mixed-32-process-race-has-one-winner");

  // 11. Four unrelated rendezvous can be held concurrently by four runtimes.
  const independent = runtimes.map((runtime, index) =>
    startProbe(runtime, "hold", join(root, `independent-${index}.lock`), `independent-${runtime}`, 1_500));
  await Promise.all(independent.map((probe) => waitForAcquired(probe)));
  const independentResults = await Promise.all(independent.map((probe) => probe.exit));
  assert.ok(independentResults.every((result) => result.code === 0), JSON.stringify(independentResults));
  record("four-runtimes-hold-four-independent-rendezvous-concurrently");

  // 12. A crash-held rendezvous never creates an accidental process-global lock.
  const crashPath = join(root, "crash-isolation-held.lock");
  const crashResult = await runProbe("rust", "crash", crashPath, "crash-isolation-owner");
  assert.equal(crashResult.code, 30);
  const unrelatedPath = join(root, "crash-isolation-unrelated.lock");
  const unrelatedResult = await runProbe("gleam", "try", unrelatedPath, "unrelated-owner");
  assert.equal(unrelatedResult.code, 0, unrelatedResult.stderr);
  assert.equal(await recover_local_file_lock(crashPath, "crash-isolation-owner", true), true);
  record("crash-held-lock-does-not-block-unrelated-rendezvous");

  // 13. Repeated wrong-owner recovery attempts remain strictly non-destructive.
  const recoveryPath = join(root, "repeated-wrong-recovery.lock");
  const crashedRecovery = await runProbe("go", "crash", recoveryPath, "correct-recovery-owner");
  assert.equal(crashedRecovery.code, 30);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await assert.rejects(
      recover_local_file_lock(recoveryPath, `wrong-owner-${attempt}`, true),
      (error) => error?.kind === "compromised",
    );
    assert.deepEqual(await inspect_local_file_lock(recoveryPath), {
      state: "held",
      owner: "correct-recovery-owner",
    });
  }
  assert.equal(await recover_local_file_lock(recoveryPath, "correct-recovery-owner", true), true);
  record("ten-wrong-owner-recoveries-remain-non-destructive");

  // 14. Twenty full Rust->Go->Node->Gleam handoff cycles leave no residual state.
  const handoffRoot = join(root, "handoff-root");
  await mkdir(handoffRoot, { recursive: true });
  const handoffPath = join(handoffRoot, "handoff.lock");
  for (let cycle = 0; cycle < 20; cycle += 1) {
    for (const runtime of runtimes) {
      const result = await runProbe(runtime, "try", handoffPath, `handoff-${cycle}-${runtime}`);
      assert.equal(result.code, 0, `handoff ${cycle}/${runtime}: ${result.stderr}`);
      await assertAbsent(handoffPath, `handoff ${cycle}/${runtime} left lock state`);
    }
  }
  record("twenty-four-runtime-handoff-cycles-leave-no-lock-residue");

  // 15. Release owns only the rendezvous; the caller-owned parent survives clean and empty.
  assert.deepEqual(await readdir(handoffRoot), [], "handoff parent must survive with no lock artifacts");
  record("caller-owned-parent-survives-clean-handoffs-without-artifacts");
}

const root = await mkdtemp(join(tmpdir(), "ores-local-process-interop-"));
try {
  await proveHolderRotation(root);
  await proveExistingProcessBatch(root);
  const beforeNewBatch = report.length;
  await proveFifthOrderProcessBoundaryBatch(root);
  assert.equal(report.length - beforeNewBatch, 15, "fifth-order batch must execute exactly 15 new checks");
  assert.equal(report.length, 35, `expected 35 total executable process checks, got ${report.length}`);
  console.log(JSON.stringify({ status: "passed", checks: report }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
