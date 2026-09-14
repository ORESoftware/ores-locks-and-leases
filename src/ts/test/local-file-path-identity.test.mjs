import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  LocalFileLockError,
  local_file_lock_exists,
  try_acquire_local_file_lock,
} from "../dist/index.js";

async function withTempDir(run) {
  const root = await mkdtemp(join(tmpdir(), "ores-local-path-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function symlinkUnavailable(error) {
  return error && typeof error === "object" && ["EPERM", "EACCES", "ENOSYS"].includes(error.code);
}

async function makeDirectoryAlias(target, link) {
  await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
}

test("rendezvous symlink or junction is compromised", async (t) => {
  await withTempDir(async (root) => {
    const target = join(root, "target");
    const link = join(root, "install.lock");
    await mkdir(target);
    try {
      await makeDirectoryAlias(target, link);
    } catch (error) {
      if (symlinkUnavailable(error)) return t.skip(`link unavailable: ${error.code}`);
      throw error;
    }

    await assert.rejects(
      try_acquire_local_file_lock(link, "owner-a"),
      (error) => error instanceof LocalFileLockError && error.kind === "compromised",
    );
    await assert.rejects(
      local_file_lock_exists(link),
      (error) => error instanceof LocalFileLockError && error.kind === "compromised",
    );
  });
});

test("immediate parent symlink or junction is compromised", async (t) => {
  await withTempDir(async (root) => {
    const targetParent = join(root, "real-parent");
    const aliasParent = join(root, "alias-parent");
    await mkdir(targetParent);
    try {
      await makeDirectoryAlias(targetParent, aliasParent);
    } catch (error) {
      if (symlinkUnavailable(error)) return t.skip(`link unavailable: ${error.code}`);
      throw error;
    }

    await assert.rejects(
      try_acquire_local_file_lock(join(aliasParent, "install.lock"), "owner-a"),
      (error) => error instanceof LocalFileLockError && error.kind === "compromised",
    );
  });
});

test("owner marker symlink is compromised on release", async (t) => {
  await withTempDir(async (root) => {
    const path = join(root, "install.lock");
    const externalOwner = join(root, "external-owner");
    const lock = await try_acquire_local_file_lock(path, "owner-a");
    assert.ok(lock);
    await unlink(join(path, "owner"));
    await writeFile(externalOwner, "owner-a", "utf8");
    try {
      await symlink(externalOwner, join(path, "owner"), "file");
    } catch (error) {
      if (symlinkUnavailable(error)) {
        await writeFile(join(path, "owner"), "owner-a", "utf8");
        await lock.release();
        return t.skip(`file symlink unavailable: ${error.code}`);
      }
      throw error;
    }

    await assert.rejects(
      lock.release(),
      (error) => error instanceof LocalFileLockError && error.kind === "compromised",
    );
  });
});

test("case aliases contend when the filesystem is case-insensitive", async () => {
  await withTempDir(async (root) => {
    const upper = join(root, "Install.lock");
    const lower = join(root, "install.lock");
    const first = await try_acquire_local_file_lock(upper, "owner-a");
    assert.ok(first);

    let aliases = false;
    try {
      aliases = (await realpath(lower)) === (await realpath(upper));
    } catch {
      // Case-sensitive filesystem: the conditional conformance case does not apply.
    }
    if (aliases) {
      assert.equal(await try_acquire_local_file_lock(lower, "owner-b"), null);
    }
    await first.release();
  });
});

test("Unicode normalization aliases contend when the filesystem normalizes names", async () => {
  await withTempDir(async (root) => {
    const composed = join(root, "café.lock");
    const decomposed = join(root, "cafe\u0301.lock");
    const first = await try_acquire_local_file_lock(composed, "owner-a");
    assert.ok(first);

    let aliases = false;
    try {
      aliases = (await realpath(decomposed)) === (await realpath(composed));
    } catch {
      // Filesystem preserves the two Unicode spellings as distinct names.
    }
    if (aliases) {
      assert.equal(await try_acquire_local_file_lock(decomposed, "owner-b"), null);
    }
    await first.release();
  });
});
