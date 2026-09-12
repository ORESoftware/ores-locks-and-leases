import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LockError,
  lockKey,
  withMaintainedXactLock,
} from "../dist/index.js";

const key = lockKey("tests/maintained-effective-ttl");
const acquire = {
  ttlMs: 120,
  waitTimeoutMs: 250,
  retryIntervalMs: 5,
};
const maintenance = { renewIntervalMs: 20 };

function grant(overrides = {}) {
  return {
    key,
    holder: "holder-a",
    fencingToken: 99n,
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

test("acquired effective TTL drift is released before PostgreSQL", async () => {
  const db = database();
  let releases = 0;
  const lease = {
    async acquire() {
      return grant({ ttlMs: 119 });
    },
    async renew() {
      throw new Error("unreachable");
    },
    async release(received) {
      releases += 1;
      assert.equal(received.ttlMs, 119);
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
      async () => undefined,
    ),
    (error) =>
      error instanceof LockError &&
      error.kind === "lost_lease" &&
      error.step === "fiducia.try_acquire" &&
      error.message.includes("TTL"),
  );
  assert.equal(releases, 1);
  assert.equal(db.connects, 0);
});

test("caller-selected holder drift is released before PostgreSQL", async () => {
  const db = database();
  let releases = 0;
  const lease = {
    async acquire() {
      return grant({ holder: "holder-b" });
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
    withMaintainedXactLock(
      key,
      true,
      { ...acquire, holder: "holder-a" },
      maintenance,
      lease,
      db,
      async () => undefined,
    ),
    (error) =>
      error instanceof LockError &&
      error.kind === "lost_lease" &&
      error.step === "fiducia.acquire",
  );
  assert.equal(releases, 1);
  assert.equal(db.connects, 0);
});

test("final renewal effective TTL drift rolls back and blocks commit", async () => {
  const db = database();
  let releases = 0;
  const lease = {
    async acquire() {
      return grant();
    },
    async renew(previous) {
      return { ...previous, ttlMs: 119 };
    },
    async release() {
      releases += 1;
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
      async () => "must-not-commit",
    ),
    (error) =>
      error instanceof LockError &&
      error.kind === "lost_lease" &&
      error.step === "fiducia.renew" &&
      error.message.includes("TTL"),
  );
  assert.ok(db.log.includes("ROLLBACK"));
  assert.ok(!db.log.includes("COMMIT"));
  assert.equal(releases, 1);
});
