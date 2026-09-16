import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import {
  LocalFileLockError,
  inspect_local_file_lock,
  recover_local_file_lock,
  try_acquire_local_file_lock,
} from "../src/ts/dist/index.js";
import { validate_local_file_lock_path } from "../src/ts/dist/local-file.js";
import {
  LocalFileTestCrash,
  clear_local_file_test_faults,
  set_local_file_test_faults,
} from "../src/ts/dist/local-file-test-faults.js";

const report = [];

function record(task, name, details = {}) {
  report.push({ task, name, status: "passed", ...details });
  console.log(`PASS ${task} ${name}`);
}

function lockError(error, kind = "io") {
  return error instanceof LocalFileLockError && error.kind === kind;
}

async function withFaults(faults, fn) {
  set_local_file_test_faults(faults);
  try {
    return await fn();
  } finally {
    clear_local_file_test_faults();
  }
}

async function simulateCrash(path, owner, point) {
  await assert.rejects(
    withFaults([point], () => try_acquire_local_file_lock(path, owner)),
    (error) => error instanceof LocalFileTestCrash && error.point === point,
  );
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
  {
    const path = join(root, "t01-pending-created.lock");
    await simulateCrash(path, "owner-a", "after_pending_create_crash");
    const inspection = await inspect_local_file_lock(path);
    assert.equal(inspection.state, "incomplete");
    assert.equal(inspection.reason, "owner_marker_missing");
    await rm(path, { recursive: true, force: true });
  }
  record(1, "pending-create crash is incomplete, never held");

  {
    const path = join(root, "t02-pending-synced.lock");
    await simulateCrash(path, "owner-b", "after_pending_sync_crash");
    const inspection = await inspect_local_file_lock(path);
    assert.equal(inspection.state, "incomplete");
    await assert.rejects(
      recover_local_file_lock(path, "owner-b", true),
      (error) => lockError(error, "compromised"),
    );
    await rm(path, { recursive: true, force: true });
  }
  record(2, "synced pending owner stays non-authoritative");

  {
    const path = join(root, "t03-after-rename.lock");
    await simulateCrash(path, "owner-c", "after_owner_rename_crash");
    assert.deepEqual(await inspect_local_file_lock(path), { state: "held", owner: "owner-c" });
    await assert.rejects(
      recover_local_file_lock(path, "wrong-owner", true),
      (error) => lockError(error, "compromised"),
    );
    assert.equal(await recover_local_file_lock(path, "owner-c", true), true);
  }
  record(3, "post-rename crash is valid held state with exact-owner recovery");

  {
    const path = join(root, "t04-short-write.lock");
    await assert.rejects(
      withFaults(["owner_short_write"], () => try_acquire_local_file_lock(path, "owner-short-write")),
      (error) => lockError(error),
    );
    assert.equal(await pathAbsent(path), true);
  }
  record(4, "short owner write rolls back without truncated publication");

  {
    const path = join(root, "t05-sync-failure.lock");
    await assert.rejects(
      withFaults(["owner_sync_failure"], () => try_acquire_local_file_lock(path, "owner-sync")),
      (error) => lockError(error) && error.message.includes("publish local lock owner token"),
    );
    assert.equal(await pathAbsent(path), true);
  }
  record(5, "sync failure is observable and rolls back");

  {
    const path = join(root, "t06-close-failure.lock");
    await assert.rejects(
      withFaults(["owner_close_failure"], () => try_acquire_local_file_lock(path, "owner-close")),
      (error) => lockError(error),
    );
    assert.equal(await pathAbsent(path), true);
  }
  record(6, "close failure prevents holder publication");

  {
    const path = join(root, "t07-rename-failure.lock");
    await assert.rejects(
      withFaults(["owner_rename_failure"], () => try_acquire_local_file_lock(path, "owner-rename")),
      (error) => lockError(error),
    );
    assert.equal(await pathAbsent(path), true);
  }
  record(7, "rename failure rolls provisional state back");

  {
    const path = join(root, "t08-partial-release.lock");
    const lock = await try_acquire_local_file_lock(path, "owner-release");
    assert.ok(lock);
    let firstError;
    await assert.rejects(
      withFaults(["release_rmdir_failure"], () => lock.release()),
      (error) => {
        firstError = error;
        return lockError(error);
      },
    );
    assert.equal(lock.release_state, "partial");
    await assert.rejects(lock.release(), (error) => error === firstError);
    assert.equal((await inspect_local_file_lock(path)).state, "incomplete");
    await rmdir(path);
  }
  record(8, "partial release retains original terminal cleanup error");

  {
    const path = join(root, "t09-rollback-failure.lock");
    await assert.rejects(
      withFaults(["owner_sync_failure", "rollback_rmdir_failure"], () =>
        try_acquire_local_file_lock(path, "owner-rollback")),
      (error) => {
        assert.ok(error instanceof LocalFileLockError);
        assert.equal(error.kind, "compromised");
        assert.match(error.message, /owner publication failed:/);
        assert.match(error.message, /rollback also failed:/);
        assert.ok(error.cause && typeof error.cause === "object");
        assert.ok("primary_error" in error.cause);
        assert.ok("rollback_error" in error.cause);
        return true;
      },
    );
    assert.equal((await inspect_local_file_lock(path)).state, "incomplete");
    await rmdir(path);
  }
  record(9, "rollback failure retains structured primary and cleanup context");

  {
    const parent = join(root, "t10-readonly-parent");
    const path = join(parent, "child.lock");
    await assert.rejects(
      withFaults(["parent_prepare_ero_fs"], () => try_acquire_local_file_lock(path, "owner-ro")),
      (error) => lockError(error),
    );
    assert.equal(await pathAbsent(parent), true);
  }
  record(10, "EROFS parent preparation is non-mutating IO");

  {
    const path = join(root, "t11-owner-permission.lock");
    const lock = await try_acquire_local_file_lock(path, "owner-permission");
    assert.ok(lock);
    await assert.rejects(
      withFaults(["owner_read_permission"], () => lock.release()),
      (error) => lockError(error),
    );
    await assert.rejects(
      withFaults(["owner_read_permission"], () =>
        recover_local_file_lock(path, "owner-permission", true)),
      (error) => lockError(error),
    );
    assert.deepEqual(await inspect_local_file_lock(path), { state: "held", owner: "owner-permission" });
    await lock.release();
  }
  record(11, "EACCES owner reads keep release and recovery non-destructive");

  {
    const path = join(root, "t12-same-token-aba.lock");
    const first = await try_acquire_local_file_lock(path, "reused-owner");
    assert.ok(first);
    assert.equal(await recover_local_file_lock(path, "reused-owner", true), true);
    const second = await try_acquire_local_file_lock(path, "reused-owner");
    assert.ok(second);
    await assert.rejects(first.release(), (error) => lockError(error, "compromised"));
    assert.deepEqual(await inspect_local_file_lock(path), { state: "held", owner: "reused-owner" });
    await second.release();
  }
  record(12, "same-token ABA stale handle is rejected by marker identity");

  if (process.platform === "win32") {
    for (const alias of ["Owner", "OWNER", "oWnEr"]) {
      const path = join(root, `t13-${alias}.lock`);
      await mkdir(path, { mode: 0o700 });
      await writeFile(join(path, alias), "owner-alias", { mode: 0o600 });
      const inspection = await inspect_local_file_lock(path);
      assert.equal(inspection.state, "compromised");
      assert.equal(inspection.reason, "dirty_directory");
      await rm(path, { recursive: true, force: true });
    }
  }
  record(13, "Windows owner-marker case aliases fail closed", { platform: process.platform });

  if (process.platform === "win32") {
    assert.doesNotThrow(() => validate_local_file_lock_path("C:\\locks\\ordinary.lock"));
    assert.doesNotThrow(() => validate_local_file_lock_path("\\\\server\\share\\locks\\ordinary.lock"));
    for (const rejected of [
      "C:relative\\ordinary.lock",
      "\\\\?\\C:\\locks\\ordinary.lock",
      "\\\\.\\PIPE\\ordinary",
      "\\??\\C:\\locks\\ordinary.lock",
    ]) {
      assert.throws(
        () => validate_local_file_lock_path(rejected),
        (error) => lockError(error, "invalid_input"),
      );
    }
  }
  record(14, "Windows UNC and drive path policy is explicit", { platform: process.platform });

  for (const [fault, owner, expectedState] of [
    ["after_pending_create_crash", "observer-a", "incomplete"],
    ["after_pending_sync_crash", "observer-b", "incomplete"],
    ["after_owner_rename_crash", "observer-c", "held"],
  ]) {
    const path = join(root, `t15-${fault}.lock`);
    await simulateCrash(path, owner, fault);
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

const root = await mkdtemp(join(tmpdir(), "ores-local-v11-faults-"));
try {
  await run(root);
  assert.equal(report.length, 15);
  console.log(JSON.stringify({ schema: "ores.local-file.eleventh-order.faults.v1", tasks: report }, null, 2));
} finally {
  clear_local_file_test_faults();
  await rm(root, { recursive: true, force: true });
}
