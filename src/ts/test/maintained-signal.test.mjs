import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LockError,
  lockKey,
  withMaintainedXactLock,
} from "../dist/index.js";

const key = lockKey("tests/maintained-portable-signal");

function pool() {
  const log = [];
  return {
    log,
    async connect() {
      return {
        async query(text) {
          log.push(text);
          if (text === "SELECT pg_try_advisory_xact_lock($1)") {
            return { rows: [{ acquired: true }] };
          }
          return { rows: [] };
        },
        release() {},
      };
    },
  };
}

function lease({ failPeriodic = false } = {}) {
  let renewals = 0;
  return {
    async acquire(acquiredKey, options) {
      return {
        key: acquiredKey,
        holder: "portable-signal-test",
        fencingToken: 77n,
        ttlMs: options.ttlMs,
      };
    },
    async renew(grant, ttlMs) {
      renewals += 1;
      if (failPeriodic && renewals === 1) {
        throw new LockError(
          "lost_lease",
          grant.key,
          "scripted periodic lease loss",
        );
      }
      return { ...grant, ttlMs };
    },
    async release() {
      return true;
    },
  };
}

const acquire = {
  ttlMs: 120,
  waitTimeoutMs: 250,
  retryIntervalMs: 5,
};

test("portable maintained signal is live before commit admission", async () => {
  const database = pool();
  const value = await withMaintainedXactLock(
    key,
    false,
    acquire,
    { renewIntervalMs: 20 },
    lease(),
    database,
    async ({ signal }) => {
      assert.equal(signal.aborted, false);
      assert.doesNotThrow(() => signal.throwIfAborted());
      return "committed";
    },
  );

  assert.equal(value, "committed");
  assert.ok(database.log.includes("COMMIT"));
});

test("portable maintained signal throws the exact renewal-loss reason", async () => {
  const database = pool();
  let observedReason;

  await assert.rejects(
    withMaintainedXactLock(
      key,
      true,
      acquire,
      { renewIntervalMs: 10 },
      lease({ failPeriodic: true }),
      database,
      async ({ signal }) => {
        assert.doesNotThrow(() => signal.throwIfAborted());
        await new Promise((resolve) => {
          signal.addEventListener("abort", resolve, { once: true });
        });
        observedReason = signal.reason;
        assert.ok(observedReason instanceof LockError);
        assert.throws(
          () => signal.throwIfAborted(),
          (error) => error === observedReason,
        );
        throw observedReason;
      },
    ),
    (error) =>
      error instanceof LockError &&
      error.kind === "lost_lease" &&
      error.step === "fiducia.renew",
  );

  assert.ok(observedReason instanceof LockError);
  assert.ok(database.log.includes("ROLLBACK"));
  assert.ok(!database.log.includes("COMMIT"));
});
