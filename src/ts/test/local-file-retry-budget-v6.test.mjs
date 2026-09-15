import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquire_local_file_lock,
  local_file_lock_sleep_delay_ms,
  try_acquire_local_file_lock,
} from "../dist/local-file.js";

test("retry sleep is capped to the remaining finite wait budget", async () => {
  assert.equal(local_file_lock_sleep_delay_ms(5_000, 40), 40);

  const root = await mkdtemp(join(tmpdir(), "ores-retry-budget-ts-v6-"));
  const path = join(root, "retry-budget.lock");
  const holder = await try_acquire_local_file_lock(path, "owner-a");
  assert.ok(holder);
  try {
    const started = performance.now();
    await assert.rejects(
      acquire_local_file_lock(path, "owner-b", {
        wait: true,
        wait_timeout_ms: 40,
        retry_interval_ms: 5_000,
      }),
      (error) => error?.kind === "timeout",
    );
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 1_000, `retry interval leaked past finite budget: ${elapsed}ms`);
  } finally {
    await holder.release();
    await rm(root, { recursive: true, force: true });
  }
});
