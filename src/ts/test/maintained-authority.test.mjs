import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LockError,
  lockKey,
  validateLeaseMaintenanceOptions,
  withMaintainedXactLock,
} from "../dist/index.js";

const key = lockKey("tests/maintained-authority-snapshots");

function grant(overrides = {}) {
  return {
    key,
    holder: "holder-a",
    fencingToken: 18_446_744_073_709_551_615n,
    ttlMs: 120,
    ...overrides,
  };
}

function database() {
  const log = [];
  let connects = 0;
  return {
    log,
    get connects() {
      return connects;
    },
    async connect() {
      connects += 1;
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

const acquire = {
  ttlMs: 120,
  waitTimeoutMs: 250,
  retryIntervalMs: 5,
};
const maintenance = { renewIntervalMs: 20 };

test("maintained option admission is closed and never executes accessors", async () => {
  let getterCalls = 0;
  const accessorOptions = {
    waitTimeoutMs: 250,
    retryIntervalMs: 5,
    get ttlMs() {
      getterCalls += 1;
      return 120;
    },
  };

  assert.throws(
    () => validateLeaseMaintenanceOptions(key, accessorOptions, maintenance, true),
    (error) => error instanceof LockError && error.kind === "invalid_plan",
  );
  assert.equal(getterCalls, 0);

  assert.throws(
    () => validateLeaseMaintenanceOptions(
      key,
      { ...acquire, unexpected: true },
      maintenance,
      true,
    ),
    (error) => error instanceof LockError && error.kind === "invalid_plan",
  );

  const proxy = new Proxy({}, {
    ownKeys() {
      throw new Error("descriptor trap");
    },
  });
  assert.throws(
    () => validateLeaseMaintenanceOptions(key, acquire, proxy, true),
    (error) =>
      error instanceof LockError &&
      error.kind === "invalid_plan" &&
      error.cause instanceof Error &&
      error.cause.message === "descriptor trap",
  );
});

test("maintained execution snapshots mutable options and acquired authority", async () => {
  const acquireInput = { ...acquire };
  const maintenanceInput = { ...maintenance };
  const acquired = grant();
  const db = database();
  let optionsSeen;
  let renewals = 0;
  let releases = 0;

  const lease = {
    async acquire(_key, options) {
      optionsSeen = options;
      assert.equal(Object.isFrozen(options), true);
      await Promise.resolve();
      return acquired;
    },
    async renew(previous, ttlMs) {
      renewals += 1;
      assert.equal(Object.isFrozen(previous), true);
      assert.equal(previous.holder, "holder-a");
      assert.equal(previous.fencingToken, 18_446_744_073_709_551_615n);
      assert.equal(ttlMs, 120);
      return { ...previous };
    },
    async release(previous) {
      releases += 1;
      assert.equal(Object.isFrozen(previous), true);
      assert.equal(previous.holder, "holder-a");
      return true;
    },
  };

  const result = withMaintainedXactLock(
    key,
    false,
    acquireInput,
    maintenanceInput,
    lease,
    db,
    async ({ grant: retained, signal }) => {
      acquired.holder = "mutated-source";
      acquired.fencingToken = 1n;
      assert.equal(Object.isFrozen(retained), true);
      assert.equal(retained.holder, "holder-a");
      assert.equal(retained.fencingToken, 18_446_744_073_709_551_615n);
      assert.equal(signal.aborted, false);
      return "committed";
    },
  );

  acquireInput.ttlMs = 1;
  acquireInput.waitTimeoutMs = 0;
  maintenanceInput.renewIntervalMs = 999;

  assert.equal(await result, "committed");
  assert.equal(optionsSeen.ttlMs, 120);
  assert.equal(optionsSeen.waitTimeoutMs, 250);
  assert.equal(renewals, 1);
  assert.equal(releases, 1);
  assert.ok(db.log.includes("COMMIT"));
});

test("malformed acquired grants fail before PostgreSQL and without invoking getters", async () => {
  let getterCalls = 0;
  const malformed = grant();
  Object.defineProperty(malformed, "holder", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "holder-a";
    },
  });
  const db = database();
  let releases = 0;
  const lease = {
    async acquire() {
      return malformed;
    },
    async renew() {
      throw new Error("unreachable");
    },
    async release() {
      releases += 1;
      return true;
    },
  };

  await assert.rejects(
    withMaintainedXactLock(key, false, acquire, maintenance, lease, db, async () => undefined),
    (error) =>
      error instanceof LockError &&
      error.kind === "transport" &&
      error.step === "fiducia.try_acquire",
  );
  assert.equal(getterCalls, 0);
  assert.equal(db.connects, 0);
  assert.equal(releases, 0);
});

test("renewal adapters cannot rewrite the retained fencing baseline", async () => {
  const db = database();
  let releases = 0;
  const lease = {
    async acquire() {
      return grant();
    },
    async renew(previous) {
      previous.fencingToken = 1n;
      return previous;
    },
    async release(previous) {
      releases += 1;
      assert.equal(previous.fencingToken, 18_446_744_073_709_551_615n);
      return true;
    },
  };

  await assert.rejects(
    withMaintainedXactLock(
      key,
      false,
      acquire,
      maintenance,
      lease,
      db,
      async ({ grant: retained }) => {
        assert.equal(Object.isFrozen(retained), true);
      },
    ),
    (error) =>
      error instanceof LockError &&
      error.kind === "transport" &&
      error.step === "fiducia.renew",
  );
  assert.ok(db.log.includes("ROLLBACK"));
  assert.ok(!db.log.includes("COMMIT"));
  assert.equal(releases, 1);
});

test("closed renewal responses reject extra authority fields", async () => {
  const db = database();
  const lease = {
    async acquire() {
      return grant();
    },
    async renew(previous) {
      return { ...previous, unexpected: true };
    },
    async release() {
      return true;
    },
  };

  await assert.rejects(
    withMaintainedXactLock(key, false, acquire, maintenance, lease, db, async () => undefined),
    (error) =>
      error instanceof LockError &&
      error.kind === "lost_lease" &&
      error.step === "fiducia.renew",
  );
  assert.ok(db.log.includes("ROLLBACK"));
  assert.ok(!db.log.includes("COMMIT"));
});
