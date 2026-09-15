import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
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

function cwdFor(runtime) {
  return runtime === "gleam" ? gleamRoot : repoRoot;
}

function relativePathFor(runtime, absolutePath) {
  const value = relative(cwdFor(runtime), absolutePath);
  assert.ok(value.length > 0, `${runtime} relative path unexpectedly empty`);
  return value;
}

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

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
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

async function assertContended(result, label) {
  assert.equal(result.code, 10, `${label}: ${result.stderr}`);
  assert.match(result.stdout, /CONTENDED/, label);
}

async function proveNinthOrder(root) {
  // 1. Stable-CWD relative paths are ordinary filesystem paths in every probe.
  for (const runtime of runtimes) {
    const absolutePath = join(root, `relative-${runtime}.lock`);
    const relativePath = relativePathFor(runtime, absolutePath);
    const result = await runProbe(runtime, "try", relativePath, `relative-${runtime}`);
    assert.equal(result.code, 0, `${runtime} relative path failed: ${result.stderr}`);
    await assertAbsent(absolutePath);
  }
  record("stable-cwd-relative-path-acquire-release-all-runtimes");

  // 2. Absolute holder and relative contender name the same rendezvous.
  {
    const lockPath = join(root, "absolute-holder-relative-contender.lock");
    const holder = startProbe("rust", "hold", lockPath, "absolute-holder", 1_200);
    await waitForAcquired(holder);
    await assertContended(
      await runProbe("go", "try", relativePathFor("go", lockPath), "relative-contender"),
      "absolute holder vs relative contender",
    );
    assert.equal((await holder.exit).code, 0);
  }
  record("absolute-holder-relative-contender-aliases-same-rendezvous");

  // 3. Relative holder and absolute contender also alias the same rendezvous.
  {
    const lockPath = join(root, "relative-holder-absolute-contender.lock");
    const holder = startProbe(
      "node",
      "hold",
      relativePathFor("node", lockPath),
      "relative-holder",
      1_200,
    );
    await waitForAcquired(holder);
    await assertContended(
      await runProbe("gleam", "try", lockPath, "absolute-contender"),
      "relative holder vs absolute contender",
    );
    assert.equal((await holder.exit).code, 0);
  }
  record("relative-holder-absolute-contender-aliases-same-rendezvous");

  // 4. Explicit ./ segments do not create a second filesystem identity.
  {
    const lockPath = join(root, "dot-segment.lock");
    const alias = `${dirname(lockPath)}${sep}.${sep}${basename(lockPath)}`;
    const holder = startProbe("rust", "hold", lockPath, "dot-holder", 1_000);
    await waitForAcquired(holder);
    await assertContended(await runProbe("node", "try", alias, "dot-contender"), "dot segment alias");
    assert.equal((await holder.exit).code, 0);
  }
  record("dot-segment-path-alias-contends-with-canonical-path");

  // 5. Existing child/../ traversal resolves to the same rendezvous.
  {
    const aliasChild = join(root, "alias-child");
    await mkdir(aliasChild, { recursive: true });
    const lockPath = join(root, "dotdot-segment.lock");
    const alias = `${aliasChild}${sep}..${sep}${basename(lockPath)}`;
    const holder = startProbe("go", "hold", lockPath, "dotdot-holder", 1_000);
    await waitForAcquired(holder);
    await assertContended(await runProbe("node", "try", alias, "dotdot-contender"), "dotdot alias");
    assert.equal((await holder.exit).code, 0);
  }
  record("dotdot-segment-path-alias-contends-with-canonical-path");

  // 6. Repeated internal separators are host aliases, not independent locks.
  {
    const lockPath = join(root, "repeated-separator.lock");
    const alias = `${dirname(lockPath)}${sep}${sep}${basename(lockPath)}`;
    const holder = startProbe("node", "hold", lockPath, "separator-holder", 1_000);
    await waitForAcquired(holder);
    await assertContended(
      await runProbe("rust", "try", alias, "separator-contender"),
      "repeated separator alias",
    );
    assert.equal((await holder.exit).code, 0);
  }
  record("repeated-internal-separator-alias-contends-with-canonical-path");

  // 7. Filesystem paths are not URL-decoded.
  for (const runtime of runtimes) {
    const lockPath = join(root, `literal-%2e-%2f-${runtime}.lock`);
    const result = await runProbe(runtime, "try", lockPath, `percent-${runtime}`);
    assert.equal(result.code, 0, `${runtime} literal percent path failed: ${result.stderr}`);
    await assertAbsent(lockPath);
  }
  record("percent-encoded-looking-path-text-remains-literal-all-runtimes");

  // 8. Unicode spaces at path-component edges are literal and are not trimmed.
  for (const runtime of runtimes) {
    const lockPath = join(root, `\u2003edge-${runtime}\u2002.lock`);
    const result = await runProbe(runtime, "try", lockPath, `unicode-space-${runtime}`);
    assert.equal(result.code, 0, `${runtime} Unicode-space path failed: ${result.stderr}`);
    await assertAbsent(lockPath);
  }
  record("unicode-space-path-component-edges-are-preserved-all-runtimes");

  // 9. Distinct basenames under one parent must not serialize globally.
  {
    const sharedParent = join(root, "shared-parent");
    await mkdir(sharedParent, { recursive: true });
    const holders = runtimes.map((runtime, index) => {
      const lockPath = join(sharedParent, `independent-${index}.lock`);
      const owner = `shared-parent-${runtime}`;
      return { lockPath, owner, probe: startProbe(runtime, "hold", lockPath, owner, 1_500) };
    });
    await Promise.all(holders.map(({ probe }) => waitForAcquired(probe)));
    for (const { lockPath, owner } of holders) await assertHeld(lockPath, owner);
    const results = await Promise.all(holders.map(({ probe }) => probe.exit));
    assert.ok(results.every((result) => result.code === 0), JSON.stringify(results));
  }
  record("distinct-basenames-one-parent-hold-concurrently-across-runtimes");

  // 10. Stagger inspections across the live -> released transition.
  for (const runtime of runtimes) {
    const lockPath = join(root, `transition-${runtime}.lock`);
    const owner = `transition-${runtime}`;
    const holder = startProbe(runtime, "hold", lockPath, owner, 300);
    await waitForAcquired(holder);
    const observations = await Promise.all(
      Array.from({ length: 48 }, async (_, index) => {
        await sleep(index * 10);
        return inspect_local_file_lock(lockPath);
      }),
    );
    for (const observation of observations) {
      assert.ok(
        observation.state === "held" || observation.state === "incomplete" || observation.state === "absent",
        `${runtime} produced unmodeled transition state ${JSON.stringify(observation)}`,
      );
      if (observation.state === "held") assert.equal(observation.owner, owner);
    }
    assert.equal((await holder.exit).code, 0);
    await assertAbsent(lockPath);
  }
  record("staggered-live-release-inspections-stay-within-modeled-state-set");

  // 11. Exact-owner recovery races linearize to at most one destructive success.
  {
    const lockPath = join(root, "parallel-exact-recovery.lock");
    const owner = "parallel-exact-owner";
    const crashed = await runProbe("rust", "crash", lockPath, owner);
    assert.equal(crashed.code, 30, crashed.stderr);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 32 }, () => recover_local_file_lock(lockPath, owner, true)),
    );
    const destructiveSuccesses = outcomes.filter(
      (outcome) => outcome.status === "fulfilled" && outcome.value === true,
    ).length;
    assert.equal(destructiveSuccesses, 1, JSON.stringify(outcomes));
    for (const outcome of outcomes) {
      if (outcome.status === "fulfilled") {
        assert.ok(outcome.value === true || outcome.value === false, JSON.stringify(outcome));
      } else {
        assert.ok(
          outcome.reason?.kind === "io" || outcome.reason?.kind === "compromised",
          JSON.stringify(outcome),
        );
      }
    }
    await assertAbsent(lockPath);
  }
  record("thirty-two-exact-owner-recoveries-have-one-destructive-success");

  // 12. Wrong-owner attempts racing exact recovery never gain destructive authority.
  {
    const lockPath = join(root, "mixed-recovery-race.lock");
    const owner = "mixed-recovery-exact-owner";
    const crashed = await runProbe("go", "crash", lockPath, owner);
    assert.equal(crashed.code, 30, crashed.stderr);
    const wrongPromises = Array.from({ length: 31 }, (_, index) =>
      recover_local_file_lock(lockPath, `wrong-race-${index}`, true));
    const [exact, ...wrong] = await Promise.allSettled([
      recover_local_file_lock(lockPath, owner, true),
      ...wrongPromises,
    ]);
    assert.equal(exact.status, "fulfilled", JSON.stringify(exact));
    assert.equal(exact.value, true, JSON.stringify(exact));
    for (const outcome of wrong) {
      if (outcome.status === "fulfilled") assert.equal(outcome.value, false, JSON.stringify(outcome));
      else assert.equal(outcome.reason?.kind, "compromised", JSON.stringify(outcome));
    }
    await assertAbsent(lockPath);
  }
  record("wrong-owner-recovery-race-never-reports-destructive-success");

  // 13. Recovering one crash-held sibling leaves the other crash-held sibling untouched.
  {
    const parent = join(root, "crash-siblings");
    const a = join(parent, "a.lock");
    const b = join(parent, "b.lock");
    const ownerA = "crash-sibling-a";
    const ownerB = "crash-sibling-b";
    assert.equal((await runProbe("node", "crash", a, ownerA)).code, 30);
    assert.equal((await runProbe("gleam", "crash", b, ownerB)).code, 30);
    assert.equal(await recover_local_file_lock(a, ownerA, true), true);
    await assertAbsent(a);
    await assertHeld(b, ownerB);
    assert.equal(await recover_local_file_lock(b, ownerB, true), true);
  }
  record("recovering-one-crash-sibling-preserves-other-crash-sibling");

  // 14. Crash recovery on A must not disturb a live holder on sibling B.
  {
    const parent = join(root, "live-crash-siblings");
    const crashPath = join(parent, "crash.lock");
    const livePath = join(parent, "live.lock");
    const crashOwner = "crash-sibling-owner";
    const liveOwner = "live-sibling-owner";
    assert.equal((await runProbe("rust", "crash", crashPath, crashOwner)).code, 30);
    const live = startProbe("go", "hold", livePath, liveOwner, 1_200);
    await waitForAcquired(live);
    assert.equal(await recover_local_file_lock(crashPath, crashOwner, true), true);
    await assertHeld(livePath, liveOwner);
    assert.equal((await live.exit).code, 0);
    await assertAbsent(livePath);
  }
  record("crash-sibling-recovery-does-not-disturb-live-sibling-holder");

  // 15. Fresh owner identities make stale recovery authority fail closed after reacquisition.
  {
    const lockPath = join(root, "fresh-owner-aba.lock");
    const oldOwner = "aba-owner-old";
    const freshOwner = "aba-owner-fresh";
    assert.equal((await runProbe("rust", "crash", lockPath, oldOwner)).code, 30);
    assert.equal(await recover_local_file_lock(lockPath, oldOwner, true), true);
    assert.equal((await runProbe("go", "crash", lockPath, freshOwner)).code, 30);
    await assert.rejects(
      recover_local_file_lock(lockPath, oldOwner, true),
      (error) => error?.kind === "compromised",
    );
    await assertHeld(lockPath, freshOwner);
    assert.equal(await recover_local_file_lock(lockPath, freshOwner, true), true);
  }
  record("fresh-owner-identity-defeats-stale-recovery-aba-authority");
}

await mkdir(join(repoRoot, "tmp"), { recursive: true });
const root = await mkdtemp(join(repoRoot, "tmp", "local-file-ninth-order-"));
try {
  await proveNinthOrder(root);
  assert.equal(report.length, 15, `expected exactly 15 ninth-order checks, got ${report.length}`);
  console.log(JSON.stringify({ status: "passed", checks: report.length, report }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
