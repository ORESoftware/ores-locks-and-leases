import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import {
  LocalFileLock,
  LocalFileLockError,
  acquire_local_file_lock,
  inspect_local_file_lock,
  try_acquire_local_file_lock,
} from "../dist/index.js";

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "ores-local-v10-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("LocalFileLock cannot be forged through its public constructor", () => {
  assert.throws(
    () => new LocalFileLock("forged.lock", "forged-owner"),
    (error) => error instanceof LocalFileLockError && error.kind === "invalid_input",
  );
});

test("acquisition still returns an authenticated LocalFileLock capability", async () => {
  await withRoot(async (root) => {
    const path = join(root, "held.lock");
    const lock = await try_acquire_local_file_lock(path, "owner-a");
    assert.ok(lock instanceof LocalFileLock);
    await lock.release();
  });
});

test("dirty preflight failure is non-destructive and leaves the handle held", async () => {
  await withRoot(async (root) => {
    const path = join(root, "preflight.lock");
    const lock = await try_acquire_local_file_lock(path, "owner-a");
    assert.ok(lock);
    const unexpected = join(path, "unexpected");
    await writeFile(unexpected, "dirty");

    await assert.rejects(
      lock.release(),
      (error) => error instanceof LocalFileLockError && error.kind === "compromised",
    );
    assert.equal(lock.release_state, "held");

    await rm(unexpected);
    await lock.release();
    assert.equal(lock.release_state, "released");
  });
});

test(
  "destructive partial release preserves the original failure for later callers",
  { skip: process.platform === "win32" },
  async () => {
    await withRoot(async (root) => {
      const path = join(root, "partial.lock");
      const lock = await try_acquire_local_file_lock(path, "owner-a");
      assert.ok(lock);

      // Owner removal happens inside the private 0700 lock directory, while
      // removing that directory itself requires write permission on `root`.
      // Tightening the parent therefore deterministically exercises the
      // destructive owner-unlinked / rmdir-failed state on POSIX.
      await chmod(root, 0o500);
      let first;
      try {
        try {
          await lock.release();
          assert.fail("partial release must fail");
        } catch (error) {
          first = error;
        }
      } finally {
        await chmod(root, 0o700);
      }

      assert.ok(first instanceof LocalFileLockError);
      assert.equal(lock.release_state, "partial");
      assert.equal((await inspect_local_file_lock(path)).state, "incomplete");

      let second;
      try {
        await lock.release();
        assert.fail("repeated partial release must return retained failure");
      } catch (error) {
        second = error;
      }
      assert.equal(second, first, "partial handle must retain the original structured error object");
    });
  },
);

test("finite wait budget is end-to-end and includes acquisition attempts", async () => {
  await withRoot(async (root) => {
    const path = join(root, "timeout.lock");
    const holder = await try_acquire_local_file_lock(path, "holder");
    assert.ok(holder);

    const started = performance.now();
    await assert.rejects(
      acquire_local_file_lock(path, "waiter", {
        wait: true,
        wait_timeout_ms: 30,
        retry_interval_ms: 5,
      }),
      (error) => error instanceof LocalFileLockError && error.kind === "timeout",
    );
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 20, `timeout returned implausibly early: ${elapsed}ms`);
    assert.ok(elapsed < 2_000, `timeout exceeded a bounded end-to-end budget: ${elapsed}ms`);
    await holder.release();
  });
});

test("ownerless publication window is modeled as incomplete with a reason code", async () => {
  await withRoot(async (root) => {
    const path = join(root, "publishing.lock");
    await mkdir(path, { mode: 0o700 });
    assert.deepEqual(await inspect_local_file_lock(path), {
      state: "incomplete",
      reason: "owner_marker_missing",
      message: "lock directory has no owner marker; acquisition or release may have crashed mid-transition",
    });
  });
});

test("pending owner publication can never be mistaken for a held owner", async () => {
  await withRoot(async (root) => {
    const path = join(root, "pending.lock");
    await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, "owner.pending"), "syntactically-valid-owner-prefix", { mode: 0o600 });
    assert.deepEqual(await inspect_local_file_lock(path), {
      state: "incomplete",
      reason: "owner_marker_missing",
      message: "owner publication is incomplete; pending owner marker is not ownership authority",
    });
  });
});

test("inspection reason codes remain machine-readable for compromised state", async () => {
  await withRoot(async (root) => {
    const path = join(root, "dirty.lock");
    await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, "unexpected"), "dirty");
    const inspection = await inspect_local_file_lock(path);
    assert.equal(inspection.state, "compromised");
    assert.equal(inspection.reason, "dirty_directory");
  });
});
