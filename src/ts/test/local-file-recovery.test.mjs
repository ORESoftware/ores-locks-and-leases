import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  LocalFileLockError,
  inspect_local_file_lock,
  recover_local_file_lock,
  try_acquire_local_file_lock,
} from "../dist/index.js";

async function withTempDir(run) {
  const root = await mkdtemp(join(tmpdir(), "ores-local-recovery-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("inspection distinguishes absent and clean held locks", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "install.lock");
    assert.deepEqual(await inspect_local_file_lock(path), { state: "absent" });
    const lock = await try_acquire_local_file_lock(path, "owner-a");
    assert.ok(lock);
    assert.deepEqual(await inspect_local_file_lock(path), {
      state: "held",
      owner: "owner-a",
    });
    await recover_local_file_lock(path, "owner-a", true);
  });
});

test("inspection marks missing owner and dirty directories compromised", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "install.lock");
    const lock = await try_acquire_local_file_lock(path, "owner-a");
    assert.ok(lock);
    await rm(join(path, "owner"));
    assert.equal((await inspect_local_file_lock(path)).state, "compromised");
    await writeFile(join(path, "unexpected"), "x", "utf8");
    assert.equal((await inspect_local_file_lock(path)).state, "compromised");
  });
});

test("recovery requires confirmation and exact expected owner", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "install.lock");
    const lock = await try_acquire_local_file_lock(path, "owner-a");
    assert.ok(lock);

    await assert.rejects(
      recover_local_file_lock(path, "owner-a", false),
      (error) => error instanceof LocalFileLockError && error.kind === "invalid_input",
    );
    await assert.rejects(
      recover_local_file_lock(path, "owner-b", true),
      (error) => error instanceof LocalFileLockError && error.kind === "compromised",
    );
    assert.equal(await recover_local_file_lock(path, "owner-a", true), true);
    assert.equal(await inspect_local_file_lock(path).then((value) => value.state), "absent");
  });
});

test("absent recovery is idempotent and dirty recovery never recursively deletes", async () => {
  await withTempDir(async (root) => {
    const absent = join(root, "absent.lock");
    assert.equal(await recover_local_file_lock(absent, "owner-a", true), false);

    const path = join(root, "dirty.lock");
    const lock = await try_acquire_local_file_lock(path, "owner-a");
    assert.ok(lock);
    await writeFile(join(path, "unexpected"), "do not delete", "utf8");
    await assert.rejects(
      recover_local_file_lock(path, "owner-a", true),
      (error) => error instanceof LocalFileLockError && error.kind === "compromised",
    );
    assert.equal((await inspect_local_file_lock(path)).state, "compromised");
  });
});
