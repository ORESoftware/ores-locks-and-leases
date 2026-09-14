import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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

async function oneWinnerRace(runtimeList, lockPath, prefix, holdMs = 2_000) {
  const probes = runtimeList.map((runtime, index) =>
    startProbe(runtime, "hold", lockPath, `${prefix}-${runtime}-${index}`, holdMs));
  const results = await Promise.all(probes.map((probe) => probe.exit));
  const winners = results.filter((result) => result.code === 0);
  const contenders = results.filter((result) => result.code === 10);
  assert.equal(winners.length, 1, `expected exactly one winner, got ${JSON.stringify(results)}`);
  assert.equal(contenders.length, results.length - 1, `non-winners must be contention: ${JSON.stringify(results)}`);
  const inspection = await inspect_local_file_lock(lockPath);
  assert.equal(inspection.state, "absent", "winner must release cleanly after the race");
}

async function proveNewProcessBatch(root) {
  const stressCases = [
    ["node-16-one-winner", Array(16).fill("node"), "rust"],
    ["rust-12-one-winner", Array(12).fill("rust"), "go"],
    ["go-12-one-winner", Array(12).fill("go"), "gleam"],
    ["gleam-4-one-winner", Array(4).fill("gleam"), "node"],
    ["mixed-16-one-winner", ["rust", "go", "node", "gleam", "rust", "go", "node", "gleam", "rust", "go", "node", "gleam", "rust", "go", "node", "gleam"], "rust"],
  ];

  for (const [name, runtimeList, reacquirer] of stressCases) {
    const lockPath = join(root, `${name}.lock`);
    await oneWinnerRace(runtimeList, lockPath, name);
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

const root = await mkdtemp(join(tmpdir(), "ores-local-process-interop-"));
try {
  await proveHolderRotation(root);
  await proveNewProcessBatch(root);
  assert.equal(report.length, 20, `expected 20 executable process checks, got ${report.length}`);
  console.log(JSON.stringify({ status: "passed", checks: report }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
