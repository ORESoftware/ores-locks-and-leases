import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  LocalFileLockError,
  acquire_local_file_lock,
  local_file_lock_exists,
  try_acquire_local_file_lock,
} from "../dist/index.js";

async function withTempDir(run) {
  const root = await mkdtemp(join(tmpdir(), "ores-local-lock-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("portable local lock contends, releases, and reacquires", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "locks", "install.lock");
    const first = await try_acquire_local_file_lock(path, "owner-a");
    assert.ok(first);
    assert.equal(await try_acquire_local_file_lock(path, "owner-b"), null);
    await first.release();

    const second = await try_acquire_local_file_lock(path, "owner-b");
    assert.ok(second);
    await second.release();
    assert.equal(await local_file_lock_exists(path), false);
  });
});

test("portable local lock no-wait reports contention", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "install.lock");
    const first = await try_acquire_local_file_lock(path, "owner-a");
    assert.ok(first);
    await assert.rejects(
      acquire_local_file_lock(path, "owner-b", { wait: false }),
      (error) => error instanceof LocalFileLockError && error.kind === "contention",
    );
    await first.release();
  });
});

test("portable local lock finite wait times out", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "install.lock");
    const first = await try_acquire_local_file_lock(path, "owner-a");
    assert.ok(first);
    await assert.rejects(
      acquire_local_file_lock(path, "owner-b", {
        wait: true,
        wait_timeout_ms: 20,
        retry_interval_ms: 5,
      }),
      (error) => error instanceof LocalFileLockError && error.kind === "timeout",
    );
    await first.release();
  });
});

test("portable local lock zero timeout fails immediately under contention", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "install.lock");
    const first = await try_acquire_local_file_lock(path, "owner-a");
    assert.ok(first);
    await assert.rejects(
      acquire_local_file_lock(path, "owner-b", {
        wait: true,
        wait_timeout_ms: 0,
        retry_interval_ms: 50,
      }),
      (error) => error instanceof LocalFileLockError && error.kind === "timeout",
    );
    await first.release();
  });
});

test("portable local lock rejects an empty owner", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "install.lock");
    await assert.rejects(
      try_acquire_local_file_lock(path, ""),
      (error) => error instanceof LocalFileLockError && error.kind === "invalid_input",
    );
  });
});

test("portable local lock accepts exactly 512 Unicode code points", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "install.lock");
    const owner = "😀".repeat(512);
    const lock = await try_acquire_local_file_lock(path, owner);
    assert.ok(lock);
    assert.equal(Array.from(lock.owner).length, 512);
    await lock.release();
  });
});

test("portable local lock rejects owners over 512 Unicode code points", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "install.lock");
    await assert.rejects(
      try_acquire_local_file_lock(path, "😀".repeat(513)),
      (error) => error instanceof LocalFileLockError && error.kind === "invalid_input",
    );
  });
});

test("portable local lock rejects negative retry even when wait is false", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "install.lock");
    await assert.rejects(
      acquire_local_file_lock(path, "owner-a", {
        wait: false,
        wait_timeout_ms: 30_000,
        retry_interval_ms: -1,
      }),
      (error) => error instanceof LocalFileLockError && error.kind === "invalid_input",
    );
  });
});

test("portable local lock allows zero retry when wait is false", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "install.lock");
    const lock = await acquire_local_file_lock(path, "owner-a", {
      wait: false,
      wait_timeout_ms: 30_000,
      retry_interval_ms: 0,
    });
    await lock.release();
  });
});

test("portable local lock owner marker is private on POSIX", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX mode bits are not the Windows ownership primitive");
    return;
  }
  await withTempDir(async (root) => {
    const path = join(root, "install.lock");
    const lock = await try_acquire_local_file_lock(path, "owner-a");
    assert.ok(lock);
    const metadata = await stat(join(path, "owner"));
    assert.equal(metadata.mode & 0o077, 0);
    await lock.release();
  });
});

test("portable local lock treats a regular file at the lock path as compromised", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "install.lock");
    await writeFile(path, "not a lock directory", "utf8");
    await assert.rejects(
      try_acquire_local_file_lock(path, "owner-a"),
      (error) => error instanceof LocalFileLockError && error.kind === "compromised",
    );
  });
});

test("portable local lock owner-token mismatch fails closed", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "install.lock");
    const lock = await try_acquire_local_file_lock(path, "owner-a");
    assert.ok(lock);
    await writeFile(join(path, "owner"), "owner-b", "utf8");
    await assert.rejects(
      lock.release(),
      (error) => error instanceof LocalFileLockError && error.kind === "compromised",
    );
  });
});

test("portable local lock missing owner marker fails closed", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "install.lock");
    const lock = await try_acquire_local_file_lock(path, "owner-a");
    assert.ok(lock);
    await rm(join(path, "owner"));
    await assert.rejects(
      lock.release(),
      (error) => error instanceof LocalFileLockError && error.kind === "compromised",
    );
  });
});

test("portable local lock refuses recursive cleanup of unexpected entries", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "install.lock");
    const lock = await try_acquire_local_file_lock(path, "owner-a");
    assert.ok(lock);
    const unexpected = join(path, "unexpected");
    await writeFile(unexpected, "do not delete", "utf8");

    await assert.rejects(
      lock.release(),
      (error) => error instanceof LocalFileLockError && error.kind === "compromised",
    );
    assert.equal(await local_file_lock_exists(path), true);
  });
});

test("portable local lock supports nested unicode paths and owner tokens", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "locks", "锁", "paquete-ñ.lock");
    const lock = await try_acquire_local_file_lock(path, "owner-λ");
    assert.ok(lock);
    assert.equal(lock.owner, "owner-λ");
    await lock.release();
    assert.equal(await local_file_lock_exists(path), false);
  });
});
