import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_LOCAL_FILE_LOCK_OPTIONS,
  MAX_LOCAL_FILE_LOCK_TIMER_DELAY_MS,
  LocalFileLockError,
  acquire_local_file_lock,
  generated_local_file_lock_owner,
  inspect_local_file_lock,
  local_file_lock_exists,
  try_acquire_local_file_lock,
} from "../dist/index.js";
import {
  local_file_lock_sleep_delay_ms,
  read_local_file_lock_entry_names_bounded,
} from "../dist/local-file.js";

async function withTempDir(run) {
  const root = await mkdtemp(join(tmpdir(), "ores-local-lock-v3-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("1 defaults are immutable fleet policy", () => {
  assert.equal(Object.isFrozen(DEFAULT_LOCAL_FILE_LOCK_OPTIONS), true);
  assert.throws(() => {
    DEFAULT_LOCAL_FILE_LOCK_OPTIONS.wait = false;
  }, TypeError);
  assert.deepEqual(DEFAULT_LOCAL_FILE_LOCK_OPTIONS, {
    wait: true,
    wait_timeout_ms: 30_000,
    retry_interval_ms: 50,
  });
});

test("2 huge valid waits never submit a Node timer above its supported ceiling", () => {
  assert.equal(MAX_LOCAL_FILE_LOCK_TIMER_DELAY_MS, 2_147_483_647);
  assert.equal(
    local_file_lock_sleep_delay_ms(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    MAX_LOCAL_FILE_LOCK_TIMER_DELAY_MS,
  );
});

test("3 sleep policy respects retry interval when retry is the smallest bound", () => {
  assert.equal(local_file_lock_sleep_delay_ms(25, 500), 25);
});

test("4 sleep policy respects remaining wait budget when it is smaller", () => {
  assert.equal(local_file_lock_sleep_delay_ms(500, 25), 25);
});

test("5 sleep policy never returns a negative delay", () => {
  assert.equal(local_file_lock_sleep_delay_ms(50, -1), 0);
});

test("6 acquisition does not mutate a caller-owned options object", async () => {
  await withTempDir(async (root) => {
    const options = { wait: false, wait_timeout_ms: 17, retry_interval_ms: 0 };
    const before = structuredClone(options);
    const lock = await acquire_local_file_lock(join(root, "options.lock"), "owner-a", options);
    assert.deepEqual(options, before);
    await lock.release();
  });
});

test("7 zero timeout still succeeds when the lock is uncontended", async () => {
  await withTempDir(async (root) => {
    const lock = await acquire_local_file_lock(join(root, "zero.lock"), "owner-a", {
      wait: true,
      wait_timeout_ms: 0,
      retry_interval_ms: 1,
    });
    await lock.release();
  });
});

test("8 CSPRNG owner helper produces a collision-free sample", () => {
  const owners = new Set(Array.from({ length: 256 }, () => generated_local_file_lock_owner()));
  assert.equal(owners.size, 256);
});

test("9 generated owners remain inside the portable owner contract", () => {
  for (let index = 0; index < 32; index += 1) {
    const owner = generated_local_file_lock_owner();
    assert.match(owner, /^ores-locks-[0-9a-f-]{36}$/);
    assert.ok(Array.from(owner).length > 0);
    assert.ok(Array.from(owner).length <= 512);
  }
});

test("10 dirty release preflight is non-destructive", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "dirty-release.lock");
    const lock = await try_acquire_local_file_lock(path, "owner-a");
    assert.ok(lock);
    await writeFile(join(path, "unexpected"), "keep-me", "utf8");

    await assert.rejects(
      lock.release(),
      (error) => error instanceof LocalFileLockError && error.kind === "compromised",
    );
    assert.equal(await readFile(join(path, "owner"), "utf8"), "owner-a");
    assert.equal(await readFile(join(path, "unexpected"), "utf8"), "keep-me");
    assert.equal((await inspect_local_file_lock(path)).state, "compromised");
  });
});

test("11 boolean exists fails closed for dirty lock directories", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "dirty-exists.lock");
    const lock = await try_acquire_local_file_lock(path, "owner-a");
    assert.ok(lock);
    await writeFile(join(path, "unexpected"), "x", "utf8");
    await assert.rejects(
      local_file_lock_exists(path),
      (error) => error instanceof LocalFileLockError && error.kind === "compromised",
    );
  });
});

test("12 boolean exists rejects an oversized persisted owner marker", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "oversize.lock");
    await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, "owner"), "a".repeat(2049), { mode: 0o600 });
    await assert.rejects(
      local_file_lock_exists(path),
      (error) =>
        error instanceof LocalFileLockError &&
        error.kind === "compromised" &&
        /2048-byte/.test(error.message),
    );
  });
});

test("13 boolean exists rejects invalid persisted UTF-8", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "invalid-utf8.lock");
    await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, "owner"), Buffer.from([0xff]), { mode: 0o600 });
    await assert.rejects(
      local_file_lock_exists(path),
      (error) =>
        error instanceof LocalFileLockError &&
        error.kind === "compromised" &&
        /valid UTF-8/.test(error.message),
    );
  });
});

test("14 successful release remains idempotent", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "idempotent.lock");
    const lock = await try_acquire_local_file_lock(path, "owner-a");
    assert.ok(lock);
    await lock.release();
    await lock.release();
    assert.equal(lock.released, true);
    assert.equal(await local_file_lock_exists(path), false);
  });
});

test("15 bounded directory inspection reads no more than two names", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "bounded-directory.lock");
    await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, "owner"), "owner-a", { mode: 0o600 });
    for (let index = 0; index < 100; index += 1) {
      await writeFile(join(path, `junk-${index}`), "x", "utf8");
    }
    const names = await read_local_file_lock_entry_names_bounded(path);
    assert.equal(names.length, 2);
  });
});
