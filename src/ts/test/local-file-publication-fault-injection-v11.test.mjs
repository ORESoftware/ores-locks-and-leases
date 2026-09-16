import assert from "node:assert/strict";
import test from "node:test";
import * as realFs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const realExports = {
  lstat: realFs.lstat,
  mkdir: realFs.mkdir,
  open: realFs.open,
  opendir: realFs.opendir,
  rename: realFs.rename,
  rmdir: realFs.rmdir,
  unlink: realFs.unlink,
};

function injectedError(message, code = "EIO") {
  return Object.assign(new Error(message), { code });
}

async function assertAbsent(path) {
  await assert.rejects(realFs.lstat(path), (error) => error?.code === "ENOENT");
}

async function loadFaultedModule(t, name, overrides) {
  const context = t.mock.module("node:fs/promises", {
    exports: { ...realExports, ...overrides },
  });
  const url = new URL(`../dist/local-file.js?v11=${name}-${Date.now()}-${Math.random()}`, import.meta.url);
  const module = await import(url.href);
  return { module, restore: () => context.restore() };
}

async function tempLock(name) {
  const root = await realFs.mkdtemp(join(tmpdir(), `ores-v11-${name}-`));
  return { root, path: join(root, "install.lock") };
}

function pendingHandleWith(base, overrides) {
  return {
    writeFile: (...args) => base.writeFile(...args),
    sync: (...args) => base.sync(...args),
    close: (...args) => base.close(...args),
    ...overrides,
  };
}

test("partial owner publication write rolls back without publishing a truncated holder", async (t) => {
  const { root, path } = await tempLock("short-write");
  const open = async (target, flags, mode) => {
    const handle = await realFs.open(target, flags, mode);
    if (!String(target).endsWith("owner.pending")) return handle;
    return pendingHandleWith(handle, {
      writeFile: async (data) => {
        const bytes = Buffer.from(String(data), "utf8");
        const partial = bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2)));
        await handle.write(partial, 0, partial.length, 0);
        throw injectedError("injected partial owner write");
      },
    });
  };
  const { module, restore } = await loadFaultedModule(t, "short-write", { open });
  try {
    await assert.rejects(
      module.try_acquire_local_file_lock(path, "owner-short-write"),
      (error) => error?.kind === "io" && /publish local lock owner token/.test(error.message),
    );
    await assertAbsent(path);
  } finally {
    restore();
    await realFs.rm(root, { recursive: true, force: true });
  }
});

test("owner publication sync failure rolls back and returns no holder", async (t) => {
  const { root, path } = await tempLock("sync-failure");
  const open = async (target, flags, mode) => {
    const handle = await realFs.open(target, flags, mode);
    if (!String(target).endsWith("owner.pending")) return handle;
    return pendingHandleWith(handle, {
      sync: async () => { throw injectedError("injected owner sync failure"); },
    });
  };
  const { module, restore } = await loadFaultedModule(t, "sync-failure", { open });
  try {
    await assert.rejects(
      module.try_acquire_local_file_lock(path, "owner-sync"),
      (error) => error?.kind === "io",
    );
    await assertAbsent(path);
  } finally {
    restore();
    await realFs.rm(root, { recursive: true, force: true });
  }
});

test("owner publication close failure rolls back and returns no holder", async (t) => {
  const { root, path } = await tempLock("close-failure");
  const open = async (target, flags, mode) => {
    const handle = await realFs.open(target, flags, mode);
    if (!String(target).endsWith("owner.pending")) return handle;
    let firstClose = true;
    return pendingHandleWith(handle, {
      close: async () => {
        if (!firstClose) return;
        firstClose = false;
        await handle.close();
        throw injectedError("injected owner close failure");
      },
    });
  };
  const { module, restore } = await loadFaultedModule(t, "close-failure", { open });
  try {
    await assert.rejects(
      module.try_acquire_local_file_lock(path, "owner-close"),
      (error) => error?.kind === "io",
    );
    await assertAbsent(path);
  } finally {
    restore();
    await realFs.rm(root, { recursive: true, force: true });
  }
});

test("owner publication rename failure rolls back rather than exposing partial held state", async (t) => {
  const { root, path } = await tempLock("rename-failure");
  const rename = async (from, to) => {
    if (String(from).endsWith("owner.pending") && String(to).endsWith("owner")) {
      throw injectedError("injected owner rename failure");
    }
    return realFs.rename(from, to);
  };
  const { module, restore } = await loadFaultedModule(t, "rename-failure", { rename });
  try {
    await assert.rejects(
      module.try_acquire_local_file_lock(path, "owner-rename"),
      (error) => error?.kind === "io",
    );
    await assertAbsent(path);
  } finally {
    restore();
    await realFs.rm(root, { recursive: true, force: true });
  }
});

test("rmdir failure after owner removal is a sticky terminal partial release", async (t) => {
  const { root, path } = await tempLock("partial-release");
  const rmdir = async (target) => {
    if (String(target) === path) throw injectedError("injected release rmdir failure", "EACCES");
    return realFs.rmdir(target);
  };
  const { module, restore } = await loadFaultedModule(t, "partial-release", { rmdir });
  try {
    const lock = await module.try_acquire_local_file_lock(path, "owner-release");
    assert.ok(lock);
    let first;
    await assert.rejects(lock.release(), (error) => {
      first = error;
      return error?.kind === "io";
    });
    await assert.rejects(lock.release(), (error) => error === first);
    assert.equal(lock.release_state, "partial");
    await assert.rejects(realFs.lstat(join(path, "owner")), (error) => error?.code === "ENOENT");
    await realFs.lstat(path);
  } finally {
    restore();
    await realFs.rm(root, { recursive: true, force: true });
  }
});
