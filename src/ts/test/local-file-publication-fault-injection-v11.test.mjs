import assert from "node:assert/strict";
import test from "node:test";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { try_acquire_local_file_lock } from "../dist/local-file.js";
import {
  clear_local_file_test_faults,
  set_local_file_test_faults,
} from "../dist/local-file-test-faults.js";

async function tempLock(name) {
  const root = await mkdtemp(join(tmpdir(), `ores-v11-${name}-`));
  return { root, path: join(root, "install.lock") };
}

async function assertAbsent(path) {
  await assert.rejects(lstat(path), (error) => error?.code === "ENOENT");
}

async function withFaults(points, fn) {
  set_local_file_test_faults(points);
  try {
    return await fn();
  } finally {
    clear_local_file_test_faults();
  }
}

test("partial owner publication write rolls back without publishing a truncated holder", async () => {
  const { root, path } = await tempLock("short-write");
  try {
    await assert.rejects(
      withFaults(["owner_short_write"], () =>
        try_acquire_local_file_lock(path, "owner-short-write")),
      (error) => error?.kind === "io" && /publish local lock owner token/.test(error.message),
    );
    await assertAbsent(path);
  } finally {
    clear_local_file_test_faults();
    await rm(root, { recursive: true, force: true });
  }
});

test("owner publication sync failure rolls back and returns no holder", async () => {
  const { root, path } = await tempLock("sync-failure");
  try {
    await assert.rejects(
      withFaults(["owner_sync_failure"], () => try_acquire_local_file_lock(path, "owner-sync")),
      (error) => error?.kind === "io",
    );
    await assertAbsent(path);
  } finally {
    clear_local_file_test_faults();
    await rm(root, { recursive: true, force: true });
  }
});

test("owner publication close failure rolls back and returns no holder", async () => {
  const { root, path } = await tempLock("close-failure");
  try {
    await assert.rejects(
      withFaults(["owner_close_failure"], () => try_acquire_local_file_lock(path, "owner-close")),
      (error) => error?.kind === "io",
    );
    await assertAbsent(path);
  } finally {
    clear_local_file_test_faults();
    await rm(root, { recursive: true, force: true });
  }
});

test("owner publication rename failure rolls back rather than exposing partial held state", async () => {
  const { root, path } = await tempLock("rename-failure");
  try {
    await assert.rejects(
      withFaults(["owner_rename_failure"], () => try_acquire_local_file_lock(path, "owner-rename")),
      (error) => error?.kind === "io",
    );
    await assertAbsent(path);
  } finally {
    clear_local_file_test_faults();
    await rm(root, { recursive: true, force: true });
  }
});

test("rmdir failure after owner removal is a sticky terminal partial release", async () => {
  const { root, path } = await tempLock("partial-release");
  try {
    const lock = await try_acquire_local_file_lock(path, "owner-release");
    assert.ok(lock);
    let first;
    await assert.rejects(
      withFaults(["release_rmdir_failure"], () => lock.release()),
      (error) => {
        first = error;
        return error?.kind === "io";
      },
    );
    await assert.rejects(lock.release(), (error) => error === first);
    assert.equal(lock.release_state, "partial");
    await assert.rejects(lstat(join(path, "owner")), (error) => error?.code === "ENOENT");
    await lstat(path);
  } finally {
    clear_local_file_test_faults();
    await rm(root, { recursive: true, force: true });
  }
});
