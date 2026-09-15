import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { try_acquire_local_file_lock } from "../dist/index.js";

test("release preserves auto-created parent and removes only rendezvous", async () => {
  const root = await mkdtemp(join(tmpdir(), "ores-parent-lifecycle-ts-v6-"));
  const parent = join(root, "auto-created-parent");
  const path = join(parent, "install.lock");
  try {
    await assert.rejects(stat(parent), (error) => error?.code === "ENOENT");
    const lock = await try_acquire_local_file_lock(path, "owner-a");
    assert.ok(lock);
    await lock.release();

    assert.equal((await stat(parent)).isDirectory(), true);
    assert.deepEqual(await readdir(parent), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
