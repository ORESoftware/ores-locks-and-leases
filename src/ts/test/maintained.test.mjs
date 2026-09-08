import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LockError,
  lockKey,
  validateLeaseMaintenanceOptions,
  withMaintainedXactLock,
} from "../dist/index.js";

const key = lockKey("tests/maintained-xact");

function scriptedLease({ failRenewal, mutateRenewal } = {}) {
  const state = {
    held: false,
    renewals: 0,
    releases: 0,
    log: [],
  };
  return {
    state,
    async acquire(acquiredKey, opts, wait) {
      state.log.push(wait ? "fiducia.acquire" : "fiducia.try_acquire");
      state.held = true;
      return {
        key: acquiredKey,
        holder: "holder-a",
        fencingToken: 41n,
        ttlMs: opts.ttlMs,
      };
    },
    async renew(grant, ttlMs) {
      state.renewals += 1;
      state.log.push("fiducia.renew");
      if (state.renewals === failRenewal) {
        throw new LockError(
          "lost_lease",
          grant.key,
          `scripted lease loss on renewal ${state.renewals}`,
        );
      }
      const renewed = { ...grant, ttlMs };
      return mutateRenewal ? mutateRenewal(renewed, state.renewals) : renewed;
    },
    async release() {
      state.releases += 1;
      state.log.push("fiducia.release");
      state.held = false;
      return true;
    },
  };
}

function fakePool({ acquireAfter = 1 } = {}) {
  const state = {
    attempts: 0,
    log: [],
    released: [],
  };
  return {
    state,
    async connect() {
      state.log.push("CONNECT");
      return {
        async query(text) {
          state.log.push(text);
          if (text === "SELECT pg_try_advisory_xact_lock($1)") {
            state.attempts += 1;
            return { rows: [{ acquired: state.attempts >= acquireAfter }] };
          }
          return { rows: [] };
        },
        release(poisoned) {
          state.released.push(poisoned ?? false);
        },
      };
    },
  };
}

const acquire = {
  ttlMs: 120,
  waitTimeoutMs: 250,
  retryIntervalMs: 5,
  holder: "holder-a",
};
const maintenance = { renewIntervalMs: 20 };

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("maintenance options fail before Fiducia or PostgreSQL acquisition", async () => {
  const lease = scriptedLease();
  const pool = fakePool();

  assert.throws(
    () => validateLeaseMaintenanceOptions(key, { ...acquire, ttlMs: 100 }, { renewIntervalMs: 51 }, true),
    (error) => error instanceof LockError && error.kind === "invalid_plan",
  );
  await assert.rejects(
    withMaintainedXactLock(
      key,
      true,
      { ...acquire, ttlMs: 100 },
      { renewIntervalMs: 51 },
      lease,
      pool,
      async () => assert.fail("work ran"),
    ),
    (error) => error instanceof LockError && error.kind === "invalid_plan",
  );
  assert.deepEqual(lease.state.log, []);
  assert.deepEqual(pool.state.log, []);
});

test("periodic and final renewals admit the commit", async () => {
  const lease = scriptedLease();
  const pool = fakePool();

  const value = await withMaintainedXactLock(
    key,
    true,
    acquire,
    maintenance,
    lease,
    pool,
    async (guarded) => {
      assert.equal(guarded.grant.fencingToken, 41n);
      assert.equal(guarded.signal.aborted, false);
      pool.state.log.push("WORK");
      await delay(65);
      return "committed";
    },
  );

  assert.equal(value, "committed");
  assert.ok(lease.state.renewals >= 2, "expected a periodic renewal plus final commit admission");
  assert.deepEqual(
    pool.state.log.slice(0, 4),
    ["CONNECT", "BEGIN", "SELECT pg_try_advisory_xact_lock($1)", "WORK"],
  );
  assert.equal(pool.state.log.at(-1), "COMMIT");
  assert.ok(!pool.state.log.includes("ROLLBACK"));
  assert.deepEqual(pool.state.released, [false]);
  assert.equal(lease.state.releases, 1);
  assert.equal(lease.state.held, false);
});

test("Fiducia remains renewed while the PostgreSQL advisory lock is contended", async () => {
  const lease = scriptedLease();
  const pool = fakePool({ acquireAfter: 8 });

  await withMaintainedXactLock(
    key,
    true,
    acquire,
    { renewIntervalMs: 10 },
    lease,
    pool,
    async () => "eventually acquired",
  );

  assert.equal(pool.state.attempts, 8);
  assert.ok(lease.state.renewals >= 2, "waiting should renew before final commit admission");
  assert.equal(pool.state.log.at(-1), "COMMIT");
});

test("failed final renewal rolls back instead of committing", async () => {
  const lease = scriptedLease({ failRenewal: 1 });
  const pool = fakePool();

  await assert.rejects(
    withMaintainedXactLock(
      key,
      false,
      { ...acquire, ttlMs: 3000 },
      { renewIntervalMs: 1000 },
      lease,
      pool,
      async () => "must not commit",
    ),
    (error) => error instanceof LockError
      && error.kind === "lost_lease"
      && error.step === "fiducia.renew",
  );

  assert.ok(pool.state.log.includes("ROLLBACK"));
  assert.ok(!pool.state.log.includes("COMMIT"));
  assert.deepEqual(pool.state.released, [true]);
  assert.equal(lease.state.releases, 1);
});

test("periodic renewal loss aborts cooperative work and rolls back", async () => {
  const lease = scriptedLease({ failRenewal: 1 });
  const pool = fakePool();
  const started = Date.now();

  await assert.rejects(
    withMaintainedXactLock(
      key,
      true,
      acquire,
      { renewIntervalMs: 10 },
      lease,
      pool,
      async ({ signal }) => new Promise((resolve, reject) => {
        const rejectAborted = () => reject(signal.reason ?? new Error("maintenance aborted"));
        if (signal.aborted) rejectAborted();
        else signal.addEventListener("abort", rejectAborted, { once: true });
      }),
    ),
    (error) => error instanceof LockError
      && error.kind === "lost_lease"
      && error.step === "fiducia.renew"
      && error.message.includes("guarded operation also failed"),
  );

  assert.ok(Date.now() - started < 1000, "cooperative work should stop promptly");
  assert.ok(pool.state.log.includes("ROLLBACK"));
  assert.ok(!pool.state.log.includes("COMMIT"));
  assert.equal(lease.state.releases, 1);
});

test("a renewal that changes fenced identity is rejected", async () => {
  const lease = scriptedLease({
    mutateRenewal: (grant) => ({ ...grant, fencingToken: grant.fencingToken + 1n }),
  });
  const pool = fakePool();

  await assert.rejects(
    withMaintainedXactLock(
      key,
      false,
      { ...acquire, ttlMs: 3000 },
      { renewIntervalMs: 1000 },
      lease,
      pool,
      async () => "must not commit",
    ),
    (error) => error instanceof LockError
      && error.kind === "lost_lease"
      && error.step === "fiducia.renew"
      && error.message.includes("fencing token"),
  );
  assert.ok(pool.state.log.includes("ROLLBACK"));
  assert.ok(!pool.state.log.includes("COMMIT"));
});

test("nonblocking PostgreSQL contention rolls back and releases Fiducia", async () => {
  const lease = scriptedLease();
  const pool = fakePool({ acquireAfter: Number.POSITIVE_INFINITY });

  await assert.rejects(
    withMaintainedXactLock(
      key,
      false,
      acquire,
      maintenance,
      lease,
      pool,
      async () => assert.fail("work ran"),
    ),
    (error) => error instanceof LockError
      && error.kind === "contention"
      && error.step === "pg.try_advisory_xact_lock",
  );
  assert.ok(pool.state.log.includes("ROLLBACK"));
  assert.ok(!pool.state.log.includes("COMMIT"));
  assert.equal(lease.state.releases, 1);
  assert.equal(lease.state.held, false);
});
