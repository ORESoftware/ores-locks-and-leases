import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  LocalFileLockError,
  ScopedLocalFileLockError,
  try_acquire_local_file_lock,
  with_local_file_lock,
} from "../dist/index.js";

async function withTempDir(run) {
  const root = await mkdtemp(join(tmpdir(), "ores-local-scoped-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("scoped helper does not run work when acquisition fails", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "install.lock");
    const first = await try_acquire_local_file_lock(path, "owner-a");
    assert.ok(first);
    let calls = 0;

    await assert.rejects(
      with_local_file_lock(path, "owner-b", { wait: false }, async () => {
        calls += 1;
      }),
      (error) =>
        error instanceof ScopedLocalFileLockError &&
        error.kind === "lock" &&
        error.lock_error instanceof LocalFileLockError &&
        error.lock_error.kind === "contention",
    );
    assert.equal(calls, 0);
    await first.release();
  });
});

test("scoped helper preserves work failure when release succeeds", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "install.lock");
    const workError = new Error("work failed");
    await assert.rejects(
      with_local_file_lock(path, "owner-a", {}, async () => {
        throw workError;
      }),
      (error) =>
        error instanceof ScopedLocalFileLockError &&
        error.kind === "work" &&
        error.work_error === workError &&
        error.lock_error === undefined,
    );
  });
});

test("scoped helper reports release failure after successful work", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "install.lock");
    await assert.rejects(
      with_local_file_lock(path, "owner-a", {}, async (lock) => {
        await writeFile(join(lock.path, "owner"), "owner-b", "utf8");
        return 42;
      }),
      (error) =>
        error instanceof ScopedLocalFileLockError &&
        error.kind === "lock" &&
        error.lock_error instanceof LocalFileLockError &&
        error.lock_error.kind === "compromised",
    );
  });
});

test("scoped helper preserves both work and release failures", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "install.lock");
    const workError = new Error("work failed");
    await assert.rejects(
      with_local_file_lock(path, "owner-a", {}, async (lock) => {
        await writeFile(join(lock.path, "owner"), "owner-b", "utf8");
        throw workError;
      }),
      (error) =>
        error instanceof ScopedLocalFileLockError &&
        error.kind === "work_and_release" &&
        error.work_error === workError &&
        error.lock_error instanceof LocalFileLockError &&
        error.lock_error.kind === "compromised",
    );
  });
});
