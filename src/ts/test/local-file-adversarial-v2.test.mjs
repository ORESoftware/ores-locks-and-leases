import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  LocalFileLockError,
  acquire_local_file_lock,
  generated_local_file_lock_owner,
  inspect_local_file_lock,
  local_file_lock_exists,
  recover_local_file_lock,
  try_acquire_local_file_lock,
} from "../dist/index.js";
import {
  MAX_LOCAL_FILE_LOCK_TIMER_DELAY_MS,
  local_file_lock_sleep_delay_ms,
} from "../dist/local-file.js";

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

test("Node timer scheduling caps huge valid waits without collapsing them", () => {
  assert.equal(
    local_file_lock_sleep_delay_ms(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    MAX_LOCAL_FILE_LOCK_TIMER_DELAY_MS,
  );
  assert.equal(local_file_lock_sleep_delay_ms(50, 7), 7);
  assert.equal(local_file_lock_sleep_delay_ms(5, 500), 5);
});

test("portable path admission rejects empty NUL and lone-surrogate paths", async () => {
  for (const path of ["", "bad\0path", "bad-\ud800-path"]) {
    await assert.rejects(
      try_acquire_local_file_lock(path, "owner-a"),
      (error) => error instanceof LocalFileLockError && error.kind === "invalid_input",
    );
    await assert.rejects(
      local_file_lock_exists(path),
      (error) => error instanceof LocalFileLockError && error.kind === "invalid_input",
    );
    await assert.rejects(
      inspect_local_file_lock(path),
      (error) => error instanceof LocalFileLockError && error.kind === "invalid_input",
    );
    await assert.rejects(
      recover_local_file_lock(path, "owner-a", true),
      (error) => error instanceof LocalFileLockError && error.kind === "invalid_input",
    );
  }
});

test("owner input rejects lone UTF-16 surrogates before persistence", async () => {
  await withTempDir(async (root) => {
    for (const [suffix, owner] of [
      ["high", "owner-\ud800"],
      ["low", "owner-\udc00"],
    ]) {
      await assert.rejects(
        try_acquire_local_file_lock(join(root, `${suffix}.lock`), owner),
        (error) =>
          error instanceof LocalFileLockError &&
          error.kind === "invalid_input" &&
          /Unicode scalar/.test(error.message),
      );
    }
  });
});

test("generated owner identities are fresh, bounded, and usable", async () => {
  await withTempDir(async (root) => {
    const firstOwner = generated_local_file_lock_owner();
    const secondOwner = generated_local_file_lock_owner();
    assert.match(firstOwner, /^ores-locks-[0-9a-f-]{36}$/);
    assert.notEqual(firstOwner, secondOwner);
    assert.ok(Array.from(firstOwner).length <= 512);

    const path = join(root, "generated.lock");
    const lock = await try_acquire_local_file_lock(path, firstOwner);
    assert.ok(lock);
    await lock.release();
  });
});

test("concurrent release calls share one linearized successful transition", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "concurrent-release.lock");
    const lock = await try_acquire_local_file_lock(path, "owner-a");
    assert.ok(lock);
    await Promise.all([lock.release(), lock.release(), lock.release()]);
    assert.equal(lock.released, true);
    assert.equal(lock.release_state, "released");
    await lock.release();
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

test("release bounds owner-marker reads before decoding", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "release-bound.lock");
    const lock = await try_acquire_local_file_lock(path, "owner-a");
    assert.ok(lock);
    await writeFile(join(path, "owner"), "a".repeat(2049), { mode: 0o600 });
    await assert.rejects(
      lock.release(),
      (error) =>
        error instanceof LocalFileLockError &&
        error.kind === "compromised" &&
        /2048-byte/.test(error.message),
    );
  });
});

test("release rejects invalid persisted UTF-8 instead of replacement decoding", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "release-utf8.lock");
    const lock = await try_acquire_local_file_lock(path, "owner-a");
    assert.ok(lock);
    await writeFile(join(path, "owner"), Buffer.from([0xff]), { mode: 0o600 });
    await assert.rejects(
      lock.release(),
      (error) =>
        error instanceof LocalFileLockError &&
        error.kind === "compromised" &&
        /valid UTF-8/.test(error.message),
    );
  });
});

test("empty lock directories are explicit incomplete crash-window state", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "incomplete.lock");
    await mkdir(path, { mode: 0o700 });
    const inspection = await inspect_local_file_lock(path);
    assert.equal(inspection.state, "incomplete");
    assert.match(inspection.message ?? "", /crashed mid-transition/);

    await assert.rejects(
      recover_local_file_lock(path, "owner-a", true),
      (error) =>
        error instanceof LocalFileLockError &&
        error.kind === "compromised" &&
        /incomplete lock state/.test(error.message),
    );
  });
});

test("boolean exists helper fails closed for incomplete state", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "exists-incomplete.lock");
    await mkdir(path, { mode: 0o700 });
    await assert.rejects(
      local_file_lock_exists(path),
      (error) => error instanceof LocalFileLockError && error.kind === "compromised",
    );
  });
});

test("boolean exists helper reports only healthy held state", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "exists-held.lock");
    assert.equal(await local_file_lock_exists(path), false);
    const lock = await try_acquire_local_file_lock(path, "owner-a");
    assert.ok(lock);
    assert.equal(await local_file_lock_exists(path), true);
    await lock.release();
    assert.equal(await local_file_lock_exists(path), false);
  });
});

test("dirty lock directories fail closed after bounded two-entry inspection", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "dirty.lock");
    await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, "owner"), "owner-a", { mode: 0o600 });
    for (let index = 0; index < 50; index += 1) {
      await writeFile(join(path, `junk-${index}`), "x");
    }
    const inspection = await inspect_local_file_lock(path);
    assert.equal(inspection.state, "compromised");
    assert.match(inspection.message ?? "", /exactly one owner marker/);
  });
});
