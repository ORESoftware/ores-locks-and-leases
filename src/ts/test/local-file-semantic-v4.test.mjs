import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  LocalFileLockError,
  acquire_local_file_lock,
  inspect_local_file_lock,
  local_file_lock_exists,
  recover_local_file_lock,
  try_acquire_local_file_lock,
} from "../dist/index.js";

async function withTempDir(run) {
  const root = await mkdtemp(join(tmpdir(), "ores-local-lock-v4-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function isInvalidInput(error) {
  return error instanceof LocalFileLockError && error.kind === "invalid_input";
}

test("concurrent TypeScript release calls are linearizable and idempotent", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "concurrent-release.lock");
    const lock = await try_acquire_local_file_lock(path, "owner-a");
    assert.ok(lock);
    await Promise.all([lock.release(), lock.release(), lock.release()]);
    assert.equal(lock.release_state, "released");
    await lock.release();
    assert.equal(await local_file_lock_exists(path), false);
  });
});

test("empty paths are invalid_input at every TypeScript runtime entry point", async () => {
  await assert.rejects(try_acquire_local_file_lock("", "owner-a"), isInvalidInput);
  await assert.rejects(acquire_local_file_lock("", "owner-a", { wait: false }), isInvalidInput);
  await assert.rejects(local_file_lock_exists(""), isInvalidInput);
  await assert.rejects(inspect_local_file_lock(""), isInvalidInput);
  await assert.rejects(recover_local_file_lock("", "owner-a", true), isInvalidInput);
});

test("embedded NUL paths are rejected before filesystem mutation", async () => {
  const path = "bad\0path.lock";
  await assert.rejects(try_acquire_local_file_lock(path, "owner-a"), isInvalidInput);
  await assert.rejects(local_file_lock_exists(path), isInvalidInput);
  await assert.rejects(inspect_local_file_lock(path), isInvalidInput);
  await assert.rejects(recover_local_file_lock(path, "owner-a", true), isInvalidInput);
});

test("TypeScript paths reject lone UTF-16 surrogates to match Unicode wire strings", async () => {
  await assert.rejects(try_acquire_local_file_lock("bad-\ud800.lock", "owner-a"), isInvalidInput);
  await assert.rejects(inspect_local_file_lock("bad-\udc00.lock"), isInvalidInput);
});

test("recovery reuses owner admission including Unicode-scalar validation", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "recovery-owner.lock");
    await assert.rejects(recover_local_file_lock(path, "owner-\ud800", true), isInvalidInput);
  });
});

test("acquisition creates missing immediate parents as an explicit TypeScript guarantee", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "missing", "parents", "install.lock");
    const lock = await try_acquire_local_file_lock(path, "owner-a");
    assert.ok(lock);
    assert.equal(await local_file_lock_exists(path), true);
    await lock.release();
  });
});

test("POSIX acquisition rejects a group/world-writable immediate parent", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows ACL policy is intentionally separate from POSIX mode bits");
    return;
  }
  await withTempDir(async (root) => {
    const parent = join(root, "unsafe-parent");
    await mkdir(parent, { mode: 0o700 });
    await chmod(parent, 0o777);
    await assert.rejects(
      try_acquire_local_file_lock(join(parent, "install.lock"), "owner-a"),
      (error) => error instanceof LocalFileLockError && error.kind === "compromised",
    );
  });
});

test("POSIX owner permission widening is compromised for exists and release", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows ACL policy is intentionally separate from POSIX mode bits");
    return;
  }
  await withTempDir(async (root) => {
    const path = join(root, "owner-permissions.lock");
    const lock = await try_acquire_local_file_lock(path, "owner-a");
    assert.ok(lock);
    await chmod(join(path, "owner"), 0o644);
    await assert.rejects(
      local_file_lock_exists(path),
      (error) => error instanceof LocalFileLockError && error.kind === "compromised",
    );
    await assert.rejects(
      lock.release(),
      (error) => error instanceof LocalFileLockError && error.kind === "compromised",
    );
  });
});

test("POSIX lock-directory permission widening is compromised before destructive release", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows ACL policy is intentionally separate from POSIX mode bits");
    return;
  }
  await withTempDir(async (root) => {
    const path = join(root, "directory-permissions.lock");
    const lock = await try_acquire_local_file_lock(path, "owner-a");
    assert.ok(lock);
    await chmod(path, 0o755);
    await assert.rejects(
      lock.release(),
      (error) => error instanceof LocalFileLockError && error.kind === "compromised",
    );
    assert.equal(lock.release_state, "held");
  });
});

test("owner values are never interpolated into mismatch diagnostics", async () => {
  await withTempDir(async (root) => {
    const secret = "sensitive-owner-token-DO-NOT-LOG";
    const path = join(root, "redaction.lock");
    const lock = await try_acquire_local_file_lock(path, secret);
    assert.ok(lock);
    await rm(join(path, "owner"));
    await assert.rejects(lock.release(), (error) => {
      assert.equal(error instanceof LocalFileLockError, true);
      assert.equal(String(error).includes(secret), false);
      return true;
    });
  });
});
