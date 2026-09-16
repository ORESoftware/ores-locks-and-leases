import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

import {
  LocalFileLockError,
  inspect_local_file_lock,
  recover_local_file_lock,
  try_acquire_local_file_lock,
} from "../src/ts/dist/index.js";

const repoRoot = process.cwd();
const nodeProbe = resolve(repoRoot, "src/ts/test/local-file-process-probe.mjs");
const report = [];

function record(name, details = {}) {
  report.push({ name, status: "passed", ...details });
  console.log(`PASS ${name}`);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function startNodeProbe(mode, lockPath, owner, holdMs = 0) {
  const child = spawn(process.execPath, [nodeProbe, mode, lockPath, owner, String(holdMs)], {
    cwd: repoRoot,
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

async function waitForAcquired(probe, timeoutMs = 15_000) {
  const started = Date.now();
  for (;;) {
    if (probe.stdout.includes("ACQUIRED")) return;
    if (Date.now() - started > timeoutMs) {
      probe.child.kill();
      throw new Error(`timed out waiting for ACQUIRED: ${probe.stdout} ${probe.stderr}`);
    }
    const outcome = await Promise.race([
      probe.exit.then((value) => ({ type: "exit", value })),
      sleep(10).then(() => ({ type: "tick" })),
    ]);
    if (outcome.type === "exit") {
      throw new Error(`probe exited before ACQUIRED: ${JSON.stringify(outcome.value)}`);
    }
  }
}

async function assertRecoveryRejected(path, owner) {
  await assert.rejects(
    recover_local_file_lock(path, owner, true),
    (error) => error instanceof LocalFileLockError && error.kind === "compromised",
  );
}

async function run(root) {
  // 1. Crash after pending-file creation but before the first owner write.
  {
    const path = join(root, "pending-empty.lock");
    await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, "owner.pending"), "", { mode: 0o600 });
    const inspection = await inspect_local_file_lock(path);
    assert.equal(inspection.state, "incomplete");
    assert.equal(inspection.reason, "owner_marker_missing");
    await assertRecoveryRejected(path, "owner-a");
  }
  record("pending-created-before-first-write-is-incomplete");

  // 2. Crash after a complete pending write but before atomic publication.
  {
    const path = join(root, "pending-complete.lock");
    await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, "owner.pending"), "owner-complete", { mode: 0o600 });
    const inspection = await inspect_local_file_lock(path);
    assert.equal(inspection.state, "incomplete");
    assert.equal(inspection.reason, "owner_marker_missing");
    await assertRecoveryRejected(path, "owner-complete");
  }
  record("fully-written-pending-owner-is-never-authority");

  // 3. Crash immediately after the atomic rename is a valid held state.
  {
    const path = join(root, "post-rename.lock");
    await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, "owner.pending"), "post-rename-owner", { mode: 0o600 });
    await rename(join(path, "owner.pending"), join(path, "owner"));
    assert.deepEqual(await inspect_local_file_lock(path), {
      state: "held",
      owner: "post-rename-owner",
    });
    await assert.rejects(
      recover_local_file_lock(path, "wrong-owner", true),
      (error) => error instanceof LocalFileLockError && error.kind === "compromised",
    );
    assert.equal(await recover_local_file_lock(path, "post-rename-owner", true), true);
  }
  record("post-rename-pre-return-state-is-held-and-owner-authenticated");

  // 4. A canonical and provisional owner marker together are structural corruption.
  {
    const path = join(root, "dual-owner-markers.lock");
    await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, "owner"), "owner-a", { mode: 0o600 });
    await writeFile(join(path, "owner.pending"), "owner-a", { mode: 0o600 });
    const inspection = await inspect_local_file_lock(path);
    assert.equal(inspection.state, "compromised");
    assert.equal(inspection.reason, "dirty_directory");
  }
  record("canonical-plus-pending-owner-markers-fail-closed");

  // 5. Owner removal before rmdir is explicitly incomplete and never auto-recovered.
  {
    const path = join(root, "release-window.lock");
    await mkdir(path, { mode: 0o700 });
    const inspection = await inspect_local_file_lock(path);
    assert.equal(inspection.state, "incomplete");
    assert.equal(inspection.reason, "owner_marker_missing");
    await assertRecoveryRejected(path, "owner-a");
  }
  record("owner-removed-before-rmdir-remains-incomplete");

  // 6. POSIX widened lock-directory permissions are machine-readable corruption.
  if (process.platform !== "win32") {
    const path = join(root, "widened-directory.lock");
    await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, "owner"), "owner-a", { mode: 0o600 });
    await chmod(path, 0o755);
    const inspection = await inspect_local_file_lock(path);
    assert.equal(inspection.state, "compromised");
    assert.equal(inspection.reason, "permissions_widened");
    await chmod(path, 0o700);
  }
  record("widened-directory-permissions-fail-closed", { platform: process.platform });

  // 7. A directory named `owner` can never authenticate ownership.
  {
    const path = join(root, "owner-directory.lock");
    await mkdir(path, { mode: 0o700 });
    await mkdir(join(path, "owner"), { mode: 0o700 });
    const inspection = await inspect_local_file_lock(path);
    assert.equal(inspection.state, "compromised");
    assert.equal(inspection.reason, "owner_not_regular_file");
  }
  record("owner-directory-is-not-an-owner-marker");

  // 8. Persisted owner bytes are bounded before decode.
  {
    const path = join(root, "owner-too-large.lock");
    await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, "owner"), "a".repeat(2049), { mode: 0o600 });
    const inspection = await inspect_local_file_lock(path);
    assert.equal(inspection.state, "compromised");
    assert.equal(inspection.reason, "owner_too_large");
  }
  record("oversized-owner-marker-has-machine-readable-reason");

  // 9. Persisted owner bytes must be valid UTF-8.
  {
    const path = join(root, "owner-invalid-utf8.lock");
    await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, "owner"), Buffer.from([0xff]), { mode: 0o600 });
    const inspection = await inspect_local_file_lock(path);
    assert.equal(inspection.state, "compromised");
    assert.equal(inspection.reason, "owner_invalid_utf8");
  }
  record("invalid-utf8-owner-marker-has-machine-readable-reason");

  // 10. Owner-marker case aliases are not accepted as canonical spelling.
  {
    const path = join(root, "owner-case-alias.lock");
    await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, "Owner"), "owner-a", { mode: 0o600 });
    const inspection = await inspect_local_file_lock(path);
    assert.equal(inspection.state, "compromised");
    assert.equal(inspection.reason, "dirty_directory");
  }
  record("owner-marker-case-alias-fails-closed");

  // 11. Wrong-owner recovery stays non-destructive.
  {
    const path = join(root, "wrong-owner-recovery.lock");
    const lock = await try_acquire_local_file_lock(path, "owner-a");
    assert.ok(lock);
    await assert.rejects(
      recover_local_file_lock(path, "owner-b", true),
      (error) => error instanceof LocalFileLockError && error.kind === "compromised",
    );
    assert.deepEqual(await inspect_local_file_lock(path), { state: "held", owner: "owner-a" });
    await lock.release();
  }
  record("wrong-owner-recovery-is-non-destructive");

  // 12. Same-token ABA: a stale handle from the pre-recovery acquisition must
  // not release a later acquisition even when the caller deliberately reuses
  // the exact same owner text.
  {
    const path = join(root, "same-token-aba.lock");
    const owner = "reused-owner-text";
    const stale = await try_acquire_local_file_lock(path, owner);
    assert.ok(stale);
    assert.equal(await recover_local_file_lock(path, owner, true), true);
    const replacement = await try_acquire_local_file_lock(path, owner);
    assert.ok(replacement);
    await assert.rejects(
      stale.release(),
      (error) => error instanceof LocalFileLockError && error.kind === "compromised",
    );
    assert.deepEqual(await inspect_local_file_lock(path), { state: "held", owner });
    await replacement.release();
  }
  record("same-token-aba-stale-handle-cannot-release-later-acquisition");

  // 13. Live observers see only modeled states through an ordinary release transition.
  {
    const path = join(root, "observer-transition.lock");
    const holder = startNodeProbe("hold", path, "observer-owner", 250);
    await waitForAcquired(holder);
    const observations = await Promise.all(
      Array.from({ length: 64 }, async (_, index) => {
        await sleep(index * 5);
        return inspect_local_file_lock(path);
      }),
    );
    for (const observation of observations) {
      assert.ok(
        observation.state === "held" || observation.state === "incomplete" || observation.state === "absent",
        `unexpected live transition state: ${JSON.stringify(observation)}`,
      );
    }
    assert.equal((await holder.exit).code, 0);
  }
  record("sixty-four-live-observers-see-only-modeled-transition-states");

  // 14. Concurrent wrong-owner recovery attempts cannot destroy a live holder.
  {
    const path = join(root, "recovery-wave.lock");
    const holder = startNodeProbe("hold", path, "wave-owner", 500);
    await waitForAcquired(holder);
    const results = await Promise.allSettled(
      Array.from({ length: 32 }, (_, index) =>
        recover_local_file_lock(path, `wrong-${index}`, true),
      ),
    );
    assert.ok(results.every((entry) => entry.status === "rejected"));
    assert.deepEqual(await inspect_local_file_lock(path), { state: "held", owner: "wave-owner" });
    assert.equal((await holder.exit).code, 0);
  }
  record("thirty-two-wrong-owner-recoveries-remain-non-destructive");

  // 15. Independent sibling rendezvous can occupy different fault/healthy states without cross-talk.
  {
    const pending = join(root, "isolated-pending.lock");
    const held = join(root, "isolated-held.lock");
    const dirty = join(root, "isolated-dirty.lock");
    await mkdir(pending, { mode: 0o700 });
    await writeFile(join(pending, "owner.pending"), "pending-owner", { mode: 0o600 });
    const holder = await try_acquire_local_file_lock(held, "held-owner");
    assert.ok(holder);
    await mkdir(dirty, { mode: 0o700 });
    await writeFile(join(dirty, "unexpected"), "dirty", { mode: 0o600 });

    const [pendingState, heldState, dirtyState] = await Promise.all([
      inspect_local_file_lock(pending),
      inspect_local_file_lock(held),
      inspect_local_file_lock(dirty),
    ]);
    assert.equal(pendingState.state, "incomplete");
    assert.deepEqual(heldState, { state: "held", owner: "held-owner" });
    assert.equal(dirtyState.state, "compromised");
    await holder.release();
  }
  record("sibling-rendezvous-fault-states-remain-isolated");
}

const root = await mkdtemp(join(tmpdir(), "ores-local-v11-"));
try {
  await run(root);
  console.log(JSON.stringify({ schema: "ores.local-file.eleventh-order.v1", tasks: report }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
