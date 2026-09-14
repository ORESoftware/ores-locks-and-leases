import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_LOCAL_FILE_LOCK_OPTIONS,
  LocalFileLockError,
  ScopedLocalFileLockError,
  generated_local_file_lock_owner,
  inspect_local_file_lock,
  local_file_lock_exists,
  recover_local_file_lock,
  try_acquire_local_file_lock,
  with_local_file_lock,
} from "../dist/index.js";
import {
  MAX_LOCAL_FILE_LOCK_TIMER_DELAY_MS,
  local_file_lock_sleep_delay_ms,
} from "../dist/local-file.js";

async function withTempDir(run) {
  const root = await mkdtemp(join(tmpdir(), "ores-local-lock-v5-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("Node retry delays are capped below timer overflow", () => {
  assert.equal(
    local_file_lock_sleep_delay_ms(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    MAX_LOCAL_FILE_LOCK_TIMER_DELAY_MS,
  );
  assert.equal(local_file_lock_sleep_delay_ms(50, 12), 12);
});

test("same-owner reacquisition is contention, not reentrancy", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "same-owner.lock");
    const first = await try_acquire_local_file_lock(path, "owner-a");
    assert.ok(first);
    assert.equal(await try_acquire_local_file_lock(path, "owner-a"), null);
    await first.release();
  });
});

test("owner identity is exact Unicode, not normalization-equivalent", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "unicode-owner.lock");
    const lock = await try_acquire_local_file_lock(path, "owner-é");
    assert.ok(lock);
    await writeFile(join(path, "owner"), "owner-e\u0301", "utf8");
    await assert.rejects(
      lock.release(),
      (error) => error instanceof LocalFileLockError && error.kind === "compromised",
    );
  });
});

test("scoped thrown work is preserved and the lock is released", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "scoped-throw.lock");
    const marker = new Error("work-boom");
    await assert.rejects(
      with_local_file_lock(path, "owner-a", DEFAULT_LOCAL_FILE_LOCK_OPTIONS, () => {
        throw marker;
      }),
      (error) =>
        error instanceof ScopedLocalFileLockError &&
        error.kind === "work" &&
        error.work_error === marker,
    );
    assert.equal(await local_file_lock_exists(path), false);
  });
});

// Fourth-order queue: 15 new executable probes.
test("same owner token may hold two independent rendezvous paths", async () => {
  await withTempDir(async (root) => {
    const first = await try_acquire_local_file_lock(join(root, "a.lock"), "owner-a");
    const second = await try_acquire_local_file_lock(join(root, "b.lock"), "owner-a");
    assert.ok(first);
    assert.ok(second);
    await first.release();
    await second.release();
  });
});

test("contention on one rendezvous does not block an unrelated rendezvous", async () => {
  await withTempDir(async (root) => {
    const held = await try_acquire_local_file_lock(join(root, "held.lock"), "owner-a");
    assert.ok(held);
    const unrelated = await try_acquire_local_file_lock(join(root, "other.lock"), "owner-b");
    assert.ok(unrelated);
    await unrelated.release();
    await held.release();
  });
});

test("wrong-owner recovery fails closed and preserves a healthy lock", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "wrong-recovery.lock");
    const lock = await try_acquire_local_file_lock(path, "owner-a");
    assert.ok(lock);
    await assert.rejects(
      recover_local_file_lock(path, "owner-b", true),
      (error) => error instanceof LocalFileLockError && error.kind === "compromised",
    );
    assert.equal((await inspect_local_file_lock(path)).owner, "owner-a");
    await lock.release();
  });
});

test("recovery without explicit inactivity confirmation is non-destructive", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "unconfirmed.lock");
    const lock = await try_acquire_local_file_lock(path, "owner-a");
    assert.ok(lock);
    await assert.rejects(
      recover_local_file_lock(path, "owner-a", false),
      (error) => error instanceof LocalFileLockError && error.kind === "invalid_input",
    );
    assert.equal(await local_file_lock_exists(path), true);
    await lock.release();
  });
});

test("recovery of an absent lock is an idempotent false/no-op", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "absent.lock");
    assert.equal(await recover_local_file_lock(path, "owner-a", true), false);
    assert.equal(await local_file_lock_exists(path), false);
  });
});

test("successful recovery removes the lock and a second recovery is a no-op", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "recover.lock");
    const lock = await try_acquire_local_file_lock(path, "owner-a");
    assert.ok(lock);
    assert.equal(await recover_local_file_lock(path, "owner-a", true), true);
    assert.equal(await recover_local_file_lock(path, "owner-a", true), false);
  });
});

test("concurrent healthy inspections report one stable owner", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "inspect-concurrent.lock");
    const lock = await try_acquire_local_file_lock(path, "owner-a");
    assert.ok(lock);
    const results = await Promise.all(Array.from({ length: 32 }, () => inspect_local_file_lock(path)));
    for (const result of results) {
      assert.equal(result.state, "held");
      assert.equal(result.owner, "owner-a");
    }
    await lock.release();
  });
});

test("concurrent healthy exists probes remain true without mutation", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "exists-concurrent.lock");
    const lock = await try_acquire_local_file_lock(path, "owner-a");
    assert.ok(lock);
    const results = await Promise.all(Array.from({ length: 32 }, () => local_file_lock_exists(path)));
    assert.deepEqual(new Set(results), new Set([true]));
    await lock.release();
  });
});

test("non-destructive owner mismatch keeps handle held and allows repair plus retry", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "repair-release.lock");
    const lock = await try_acquire_local_file_lock(path, "owner-a");
    assert.ok(lock);
    await writeFile(join(path, "owner"), "owner-b", "utf8");
    await assert.rejects(lock.release(), (error) => error instanceof LocalFileLockError);
    assert.equal(lock.release_state, "held");
    await writeFile(join(path, "owner"), "owner-a", "utf8");
    await lock.release();
    assert.equal(lock.release_state, "released");
  });
});

test("concurrent failing releases share fail-closed semantics without false success", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "concurrent-failure.lock");
    const lock = await try_acquire_local_file_lock(path, "owner-a");
    assert.ok(lock);
    await writeFile(join(path, "owner"), "owner-b", "utf8");
    const settled = await Promise.allSettled([lock.release(), lock.release(), lock.release()]);
    assert.equal(settled.every((entry) => entry.status === "rejected"), true);
    assert.equal(lock.release_state, "held");
    await writeFile(join(path, "owner"), "owner-a", "utf8");
    await lock.release();
  });
});

test("generated owner identity round-trips through inspection", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "generated-owner.lock");
    const owner = generated_local_file_lock_owner();
    const lock = await try_acquire_local_file_lock(path, owner);
    assert.ok(lock);
    assert.equal((await inspect_local_file_lock(path)).owner, owner);
    await lock.release();
  });
});

test("control characters in owner identity round-trip exactly without affecting release", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "control-owner.lock");
    const owner = "owner-line1\nline2\tend";
    const lock = await try_acquire_local_file_lock(path, owner);
    assert.ok(lock);
    assert.equal((await inspect_local_file_lock(path)).owner, owner);
    await lock.release();
  });
});

test("sequential distinct owners can reuse one rendezvous without residue", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "reuse.lock");
    for (const owner of ["owner-a", "owner-b", "owner-c"]) {
      const lock = await try_acquire_local_file_lock(path, owner);
      assert.ok(lock);
      await lock.release();
      assert.equal(await local_file_lock_exists(path), false);
    }
  });
});

test("repeated acquire-release cycles leave no residual lock state", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "soak.lock");
    for (let index = 0; index < 100; index += 1) {
      const lock = await try_acquire_local_file_lock(path, `owner-${index}`);
      assert.ok(lock);
      await lock.release();
    }
    assert.equal(await local_file_lock_exists(path), false);
  });
});

test("read-only diagnostics do not mutate the held handle lifecycle", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "diagnostics-state.lock");
    const lock = await try_acquire_local_file_lock(path, "owner-a");
    assert.ok(lock);
    assert.equal(lock.release_state, "held");
    assert.equal((await inspect_local_file_lock(path)).state, "held");
    assert.equal(await local_file_lock_exists(path), true);
    assert.equal(lock.release_state, "held");
    await lock.release();
  });
});
