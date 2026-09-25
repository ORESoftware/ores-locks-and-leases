import assert from "node:assert/strict";
import test from "node:test";

import { FencedRedlockLease, lockKey } from "../dist/index.js";

class FakeHandle {
  constructor(events, expiration = 10_000) {
    this.events = events;
    this.expiration = expiration;
    this.released = false;
  }

  async extend(ttlMs) {
    this.events.push(["extend", ttlMs]);
    return new FakeHandle(this.events, this.expiration + ttlMs);
  }

  async release() {
    this.events.push(["release"]);
    this.released = true;
  }
}

function options(overrides = {}) {
  return {
    ttlMs: 1_000,
    waitTimeoutMs: 100,
    retryIntervalMs: 10,
    holder: "worker-a",
    requestId: "request-1",
    ...overrides,
  };
}

test("Redlock quorum is acquired before a fencing token is minted", async () => {
  const events = [];
  let next = 40n;
  const lease = new FencedRedlockLease({
    redlock: {
      async acquire(resources, ttlMs) {
        events.push(["acquire", resources, ttlMs]);
        return new FakeHandle(events);
      },
    },
    fencing: {
      async nextFencingToken(key, holder, requestId) {
        events.push(["fence", key.toString(), holder, requestId]);
        next += 1n;
        return next;
      },
    },
    now: () => 1_000,
  });

  const key = lockKey("redlock/test");
  const grant = await lease.acquire(key, options(), false);
  assert.equal(grant.fencingToken, 41n);
  assert.deepEqual(events.slice(0, 2), [
    ["acquire", ["redlock/test"], 1_000],
    ["fence", "redlock/test", "worker-a", "request-1"],
  ]);

  const renewed = await lease.renew(grant, 2_000);
  assert.equal(renewed.fencingToken, 41n, "renewal must preserve the fencing token");
  assert.deepEqual(events.at(-1), ["extend", 2_000]);

  assert.equal(await lease.release(renewed), true);
  assert.equal(await lease.release(renewed), false, "release is idempotent after local grant removal");
});

test("fencing mint failure releases Redlock and returns no grant", async () => {
  const events = [];
  const lease = new FencedRedlockLease({
    redlock: {
      async acquire() {
        events.push(["acquire"]);
        return new FakeHandle(events);
      },
    },
    fencing: {
      async nextFencingToken() {
        events.push(["fence"]);
        throw new Error("token authority unavailable");
      },
    },
    now: () => 1_000,
  });

  await assert.rejects(
    lease.acquire(lockKey("redlock/fence-failure"), options(), false),
    (error) => error?.kind === "transport",
  );
  assert.deepEqual(events, [["acquire"], ["fence"], ["release"]]);
});

test("grant is refused if Redlock expires while the fencing token is minted", async () => {
  const events = [];
  let now = 1_000;
  const lease = new FencedRedlockLease({
    redlock: {
      async acquire() {
        events.push(["acquire"]);
        return new FakeHandle(events, 1_500);
      },
    },
    fencing: {
      async nextFencingToken() {
        events.push(["fence"]);
        now = 1_500;
        return 8n;
      },
    },
    now: () => now,
  });

  await assert.rejects(
    lease.acquire(lockKey("redlock/expired-during-fence"), options(), false),
    (error) => error?.kind === "lost_lease",
  );
  assert.deepEqual(events, [["acquire"], ["fence"], ["release"]]);
});

test("renewal failure is fail-closed as lost_lease", async () => {
  const lease = new FencedRedlockLease({
    redlock: {
      async acquire() {
        return {
          expiration: 2_000,
          async extend() {
            throw new Error("quorum lost");
          },
          async release() {},
        };
      },
    },
    fencing: {
      async nextFencingToken() {
        return 7n;
      },
    },
    now: () => 1_000,
  });

  const grant = await lease.acquire(lockKey("redlock/lost"), options(), false);
  await assert.rejects(
    lease.renew(grant, 1_000),
    (error) => error?.kind === "lost_lease",
  );
});