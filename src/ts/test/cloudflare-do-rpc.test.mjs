import assert from "node:assert/strict";
import test from "node:test";

import {
  CloudflareDurableObjectRpcLease,
  LockError,
  lockKey,
} from "../dist/index.js";

const opts = {
  ttlMs: 60_000,
  waitTimeoutMs: 50,
  retryIntervalMs: 1,
  holder: "worker-a",
};

test("Durable Object RPC adapter calls typed stub methods without an HTTP hop", async () => {
  const names = [];
  const calls = [];
  const stub = {
    async acquire(input) {
      calls.push(["acquire", input]);
      return {
        acquired: true,
        fencing_token: "7",
        lease_expires_ms: 2_000_000_060_000,
        ttl_ms: 60_000,
        renewed: false,
        replayed: false,
      };
    },
    async renew(input) {
      calls.push(["renew", input]);
      return { renewed: true, lease_expires_ms: 2_000_000_090_000, ttl_ms: 30_000 };
    },
    async release(input) {
      calls.push(["release", input]);
      return { released: true };
    },
  };
  const lease = new CloudflareDurableObjectRpcLease({
    namespace: {
      getByName(name) {
        names.push(name);
        return stub;
      },
    },
    generateRequestId: () => "attempt-rpc-1",
  });
  const key = lockKey("zed-pkg/registry/rpc");

  const grant = await lease.acquire(key, opts, false);
  assert.equal(grant.fencingToken, 7n);
  assert.equal(grant.leaseExpiresMs, 2_000_000_060_000);
  const renewed = await lease.renew(grant, 30_000);
  assert.equal(renewed.leaseExpiresMs, 2_000_000_090_000);
  assert.equal(await lease.release(renewed), true);

  assert.deepEqual(names, [key, key, key]);
  assert.deepEqual(calls, [
    ["acquire", { holder: "worker-a", ttl_ms: 60_000, request_id: "attempt-rpc-1" }],
    ["renew", { holder: "worker-a", fencing_token: "7", ttl_ms: 30_000 }],
    ["release", { holder: "worker-a", fencing_token: "7" }],
  ]);
});

test("Durable Object RPC replay is token-renewed before the grant is exposed", async () => {
  const calls = [];
  const lease = new CloudflareDurableObjectRpcLease({
    namespace: {
      getByName() {
        return {
          async acquire(input) {
            calls.push(["acquire", input]);
            return {
              acquired: true,
              fencing_token: "11",
              lease_expires_ms: 2_000_000_001_000,
              renewed: false,
              replayed: true,
            };
          },
          async renew(input) {
            calls.push(["renew", input]);
            return { renewed: true, lease_expires_ms: 2_000_000_060_000, ttl_ms: 60_000 };
          },
          async release() {
            return { released: true };
          },
        };
      },
    },
    generateRequestId: () => "stable-logical-attempt",
  });

  const grant = await lease.acquire(lockKey("shared-auth/session/rpc-replay"), opts, false);
  assert.equal(grant.fencingToken, 11n);
  assert.equal(grant.leaseExpiresMs, 2_000_000_060_000);
  assert.equal(calls[0][1].request_id, "stable-logical-attempt");
  assert.equal(calls[1][1].fencing_token, "11");
});

test("Durable Object RPC exceptions stay transport failures, never contention", async () => {
  const lease = new CloudflareDurableObjectRpcLease({
    namespace: {
      getByName() {
        return {
          async acquire() { throw new Error("rpc disconnected"); },
          async renew() { throw new Error("unused"); },
          async release() { throw new Error("unused"); },
        };
      },
    },
  });

  await assert.rejects(
    () => lease.acquire(lockKey("quaestor-ledger/rpc/ambiguous"), opts, false),
    (error) => error instanceof LockError && error.kind === "transport" && error.step === "fiducia.try_acquire",
  );
});
