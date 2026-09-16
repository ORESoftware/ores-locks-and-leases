import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

import {
  LocalFileLockError,
  inspect_local_file_lock,
  recover_local_file_lock,
  try_acquire_local_file_lock,
} from "../src/ts/dist/index.js";
import { validate_local_file_lock_path } from "../src/ts/dist/local-file.js";

const repoRoot = process.cwd();
const nodeProbe = resolve(repoRoot, "src/ts/test/local-file-process-probe.mjs");
const report = [];

function record(task, name, details = {}) {
  report.push({ task, name, status: "passed", ...details });
  console.log(`PASS ${task} ${name}`);
}

function faultError(error, kind = "io") {
  return error instanceof LocalFileLockError && error.kind === kind;
}

async function withFaults(faults, fn) {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousFaults = process.env.ORES_LOCAL_FILE_TEST_FAULTS;
  process.env.NODE_ENV = "test";
  process.env.ORES_LOCAL_FILE_TEST_FAULTS = faults.join(",");
  try {
    return await fn();
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousFaults === undefined) delete process.env.ORES_LOCAL_FILE_TEST_FAULTS;
    else process.env.ORES_LOCAL_FILE_TEST_FAULTS = previousFaults;
  }
}

async function faultingProbe(lockPath, owner, fault) {
  const child = spawn(process.execPath, [nodeProbe, "try", lockPath, owner, "0"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: "test",
      ORES_LOCAL_FILE_TEST_FAULTS: fault,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return await new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal, stdout, stderr }));
  });
}

async function pathAbsent(path) {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

async function run(root) {
  // 1. Crash after owner.pending creation but before the first write.
  {
    const path = join(root, "t01-pending-created.lock");
    const exit = await faultingProbe(path, "owner-a", "after_pending_create_crash");
    assert.equal(exit.code, 81);
    const inspection = await inspect_local_file_lock(path);
    assert.equal(inspection.state, "incomplete");
    assert.equal(inspection.reason, "owner_marker_missing");
    await rm(path, { recursive: true, force: true });
  }
  record(1, "pending-create crash is incomplete, never held");

  // 2. Crash after full pending write/sync/close but before atomic rename.
  {
    const path = join(root, "t02-pending-synced.lock");
    const exit = await faultingProbe(path, "owner-b", "after_pending_sync_crash");
    assert.equal(exit.code, 82);
    const inspection = await inspect_local_file_lock(path);
    assert.equal(inspection.state, "incomplete");
    await assert.rejects(
      recover_local_file_lock(path, "owner-b", true),
      (error) => faultError(error, "compromised"),
    );
    await rm(path, { recursive: true, force: true });
  }
  record(2, "synced pending owner stays non-authoritative");

  // 3. Crash immediately after atomic rename but before acquisition returns.
  {
    const path = join(root, "t03-after-rename.lock");
    const exit = await faultingProbe(path, "owner-c", "after_owner_rename_crash");
    assert.equal(exit.code, 83);
    assert.deepEqual(await inspect_local_file_lock(path), { state: "held", owner: "owner-c" });
    await assert.rejects(
      recover_local_file_lock(path, "wrong-owner", true),
      (error) => faultError(error, "compromised"),
    );
    assert.equal(await recover_local_file_lock(path, "owner-c", true), true);
  }
  record(3, "post-rename crash is valid held state with exact-owner recovery");

  // 4. Partial owner write must never publish truncated authority.
  {
    const path = join(root, "t04-short-write.lock");
    await withFaults(["owner_short_write"], async () => {
      await assert.rejects(try_acquire_local_file_lock(path, "owner-short-write"), (error) => faultError(error));
    });
    assert.equal(await pathAbsent(path), true);
  }
  record(4, "short owner write rolls back without truncated publication");

  // 5. Publication sync failure rolls back and preserves the primary IO failure.
  {
    const path = join(root, "t05-sync-failure.lock");
    await withFaults(["owner_sync_failure"], async () => {
      await assert.rejects(
        try_acquire_local_file_lock(path, "owner-sync"),
        (error) => faultError(error) && error.message.includes("publish local lock owner token"),
      );
    });
    assert.equal(await pathAbsent(path), true);
  }
  record(5, "sync failure is observable and rolls back");

  // 6. Observable close failure must not return a holder.
  {
    const path = join(root, "t06-close-failure.lock");
    await withFaults(["owner_close_failure"], async () => {
      await assert.rejects(try_acquire_local_file_lock(path, "owner-close"), (error) => faultError(error));
    });
    assert.equal(await pathAbsent(path), true);
  }
  record(6, "close failure prevents holder publication");

  // 7. Publication rename failure leaves no false healthy holder.
  {
    const path = join(root, "t07-rename-failure.lock");
    await withFaults(["owner_rename_failure"], async () => {
      await assert.rejects(try_acquire_local_file_lock(path, "owner-rename"), (error) => faultError(error));
    });
    assert.equal(await pathAbsent(path), true);
  }
  record(7, "rename failure rolls provisional state back");

  // 8. Directory-removal failure after owner removal is sticky terminal partial release.
  {
    const path = join(root, "t08-partial-release.lock");
    const lock = await try_acquire_local_file_lock(path, "owner-release");
    assert.ok(lock);
    let firstError;
    await withFaults(["release_rmdir_failure"], async () => {
      await assert.rejects(lock.release(), (error) => {
        firstError = error;
        return faultError(error);
      });
    });
    assert.equal(lock.release_state, "partial");
    await assert.rejects(lock.release(), (error) => error === firstError);
    const inspection = await inspect_local_file_lock(path);
    assert.equal(inspection.state, "incomplete");
    await rmdir(path);
  }
  record(8, "partial release retains original terminal cleanup error");

  // 9. Rollback-cleanup failure preserves both primary and cleanup context.
  {
    const path = join(root, "t09-rollback-failure.lock");
    await withFaults(["owner_sync_failure", "rollback_rmdir_failure"], async () => {
      await assert.rejects(try_acquire_local_file_lock(path, "owner-rollback"), (error) => {
        assert.ok(error instanceof LocalFileLockError);
        assert.equal(error.kind, "compromised");
        assert.match(error.message, /owner publication failed:/);
        assert.match(error.message, /rollback also failed:/);
        assert.ok(error.cause && typeof error.cause === "object");
        assert.ok("primary_error" in error.cause);
        assert.ok("rollback_error" in error.cause);
        return true;
      });
    });
    const inspection = await inspect_local_file_lock(path);
    assert.equal(inspection.state, "incomplete");
    await rmdir(path);
  }
  record(9, "rollback failure retains structured primary and cleanup context");

  // 10. Read-only parent classification is IO and does not mutate the nested parent.
  {
    const parent = join(root, "t10-readonly-parent");
    const path = join(parent, "child.lock");
    await withFaults(["parent_prepare_ero_fs"], async () => {
      await assert.rejects(try_acquire_local_file_lock(path, "owner-ro"), (error) => faultError(error));
    });
    assert.equal(await pathAbsent(parent), true);
  }
  record(10, "EROFS parent preparation is non-mutating IO");

  // 11. Permission-denied owner read blocks release/recovery without destructive mutation.
  {
    const path = join(root, "t11-owner-permission.lock");
    const lock = await try_acquire_local_file_lock(path, "owner-permission");
    assert.ok(lock);
    await withFaults(["owner_read_permission"], async () => {
      await assert.rejects(lock.release(), (error) => faultError(error));
      await assert.rejects(
        recover_local_file_lock(path, "owner-permission", true),
        (error) => faultError(error),
      );
    });
    assert.deepEqual(await inspect_local_file_lock(path), { state: "held", owner: "owner-permission" });
    await lock.release();
  }
  record(11, "EACCES owner reads keep release and recovery non-destructive");

  // 12. Same-token ABA: stale handle cannot release a later reacquisition.
  {
    const path = join(root, "t12-same-token-aba.lock");
    const first = await try_acquire_local_file_lock(path, "reused-owner");
    assert.ok(first);
    assert.equal(await recover_local_file_lock(path, "reused-owner", true), true);
    const second = await try_acquire_local_file_lock(path, "reused-owner");
    assert.ok(second);
    await assert.rejects(first.release(), (error) => faultError(error, "compromised"));
    assert.deepEqual(await inspect_local_file_lock(path), { state: "held", owner: "reused-owner" });
    await second.release();
  }
  record(12, "same-token ABA stale handle is rejected by marker identity");

  // 13. Windows case-insensitive owner aliases/collisions fail closed.
  if (process.platform === "win32") {
    for (const alias of ["Owner", "OWNER", "oWnEr"]) {
      const path = join(root, `t13-${alias}.lock`);
      await mkdir(path, { mode: 0o700 });
      await writeFile(join(path, alias), "owner-alias", { mode: 0o600 });
      const inspection = await inspect_local_file_lock(path);
      assert.equal(inspection.state, "compromised");
      assert.equal(inspection.reason, "dirty_directory");
    }
  }
  record(13, "Windows owner-marker case aliases fail closed", { platform: process.platform });

  // 14. Windows ordinary UNC/drive-absolute policy is distinct from device and drive-relative forms.
  if (process.platform === "win32") {
    assert.doesNotThrow(() => validate_local_file_lock_path("C:\\locks\\ordinary.lock"));
    assert.doesNotThrow(() => validate_local_file_lock_path("\\\\server\\share\\locks\\ordinary.lock"));
    for (const rejected of [
      "C:relative\\ordinary.lock",
      "\\\\?\\C:\\locks\\ordinary.lock",
      "\\\\.\\PIPE\\ordinary",
      "\\??\\C:\\locks\\ordinary.lock",
    ]) {
      assert.throws(() => validate_local_file_lock_path(rejected), (error) => faultError(error, "invalid_input"));
    }
  }
  record(14, "Windows UNC and drive path policy is explicit", { platform: process.platform });

  // 15. High-contention observers across crash points see only modeled states/reasons.
  for (const [fault, owner, exitCode, expectedState] of [
    ["after_pending_create_crash", "observer-a", 81, "incomplete"],
    ["after_pending_sync_crash", "observer-b", 82, "incomplete"],
    ["after_owner_rename_crash", "observer-c", 83, "held"],
  ]) {
    const path = join(root, `t15-${fault}.lock`);
    const exit = await faultingProbe(path, owner, fault);
    assert.equal(exit.code, exitCode);
    const observations = await Promise.all(
      Array.from({ length: 64 }, () => inspect_local_file_lock(path)),
    );
    for (const observation of observations) {
      assert.ok(["absent", "held", "incomplete", "compromised"].includes(observation.state));
      assert.equal(observation.state, expectedState);
      if (observation.state === "incomplete" || observation.state === "compromised") {
        assert.equal(typeof observation.reason, "string");
      }
    }
    if (expectedState === "held") {
      assert.equal(await recover_local_file_lock(path, owner, true), true);
    } else {
      await rm(path, { recursive: true, force: true });
    }
  }
  record(15, "observer stress across publication crash points yields only modeled states");
}

const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(join(tmpdir(), "ores-local-v11-faults-")));
try {
  await run(root);
  console.log(JSON.stringify({ schema: "ores.local-file.eleventh-order.faults.v1", tasks: report }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
