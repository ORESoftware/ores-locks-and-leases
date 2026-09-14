import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  LocalFileLockError,
  acquire_local_file_lock,
  inspect_local_file_lock,
  try_acquire_local_file_lock,
} from "../dist/index.js";

async function withTempDir(run) {
  const root = await mkdtemp(join(tmpdir(), "ores-local-lock-v2-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("waiting contender acquires after release within remaining monotonic budget", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "install.lock");
    const first = await try_acquire_local_file_lock(path, "owner-a");
    assert.ok(first);

    const delayedRelease = new Promise((resolve, reject) => {
      setTimeout(() => first.release().then(resolve, reject), 25);
    });

    const second = await acquire_local_file_lock(path, "owner-b", {
      wait: true,
      wait_timeout_ms: 500,
      retry_interval_ms: 5,
    });
    assert.equal(second.owner, "owner-b");
    await second.release();
    await delayedRelease;
  });
});

test("millisecond options reject values outside JavaScript safe integer range", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "install.lock");
    for (const options of [
      { wait: true, wait_timeout_ms: Number.MAX_SAFE_INTEGER + 1, retry_interval_ms: 1 },
      { wait: true, wait_timeout_ms: 100, retry_interval_ms: Number.MAX_SAFE_INTEGER + 1 },
      { wait: true, wait_timeout_ms: 1.5, retry_interval_ms: 1 },
      { wait: true, wait_timeout_ms: 100, retry_interval_ms: 1.5 },
    ]) {
      await assert.rejects(
        acquire_local_file_lock(path, "owner-a", options),
        (error) => error instanceof LocalFileLockError && error.kind === "invalid_input",
      );
    }
  });
});

test("inspection classifies invalid UTF-8 owner bytes as compromised", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "install.lock");
    await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, "owner"), Buffer.from([0xff]), { mode: 0o600 });
    const inspection = await inspect_local_file_lock(path);
    assert.equal(inspection.state, "compromised");
    assert.match(inspection.message ?? "", /valid UTF-8/);
  });
});

test("inspection bounds owner-marker reads before decoding", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "install.lock");
    await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, "owner"), "a".repeat(2049), { mode: 0o600 });
    const inspection = await inspect_local_file_lock(path);
    assert.equal(inspection.state, "compromised");
    assert.match(inspection.message ?? "", /2048-byte/);
  });
});


test("release bounds persisted owner-marker reads", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "install.lock");
    const lock = await try_acquire_local_file_lock(path, "owner-a");
    assert.ok(lock);
    await writeFile(join(path, "owner"), "a".repeat(2049), { mode: 0o600 });
    await assert.rejects(
      lock.release(),
      (error) => error instanceof LocalFileLockError
        && error.kind === "compromised"
        && /2048-byte/.test(error.message),
    );
  });
});

test("owner input rejects lone UTF-16 surrogates", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "install.lock");
    for (const owner of ["\ud800", "\udfff", "a\ud800b"]) {
      await assert.rejects(
        try_acquire_local_file_lock(path, owner),
        (error) => error instanceof LocalFileLockError && error.kind === "invalid_input",
      );
    }
  });
});
