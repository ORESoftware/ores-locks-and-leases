import assert from "node:assert/strict";
import test from "node:test";

import {
  CloudflareDurableObjectLease,
  LockError,
  UpstashRedisLease,
  lockKey,
} from "../dist/index.js";

function response(body, status = 200) {
  return { status, async text() { return JSON.stringify(body); } };
}

const opts = {
  ttlMs: 60_000,
  waitTimeoutMs: 50,
  retryIntervalMs: 1,
  holder: "worker-a",
};

const MAX_SAFE_FENCING_TOKEN = "9007199254740991";
const ABOVE_MAX_SAFE_FENCING_TOKEN = "9007199254740992";

test("Cloudflare Durable Object client preserves the largest exact JSON fencing token", async () => {
  const calls = [];
  const outputs = [
    { acquired: true, fencing_token: MAX_SAFE_FENCING_TOKEN, lease_expires_ms: 2_000_000_000_000 },
    { renewed: true, lease_expires_ms: 2_000_000_060_000 },
    { released: true },
  ];
  const lease = new CloudflareDurableObjectLease({
    baseUrl: "https://locks.example.test",
    apiToken: "secret",
    generateHolder: () => "generated-not-used",
    fetch: async (url, init) => {
      calls.push({ url, init });
      return response(outputs.shift());
    },
  });
  const key = lockKey("zed-pkg/registry/publish");

  const grant = await lease.acquire(key, opts, false);
  assert.equal(grant.fencingToken, BigInt(MAX_SAFE_FENCING_TOKEN));
  assert.equal(grant.holder, "worker-a");

  const renewed = await lease.renew(grant, 60_000);
  assert.equal(renewed.fencingToken, grant.fencingToken);
  assert.equal(renewed.leaseExpiresMs, 2_000_000_060_000);
  assert.equal(await lease.release(renewed), true);

  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
    "/v1/leases/acquire",
    "/v1/leases/renew",
    "/v1/leases/release",
  ]);
  assert.equal(calls[0].init.headers.authorization, "Bearer secret");
  assert.match(calls[1].init.body, new RegExp(MAX_SAFE_FENCING_TOKEN));
});

test("Cloudflare Durable Object client rejects a JSON-inexact fencing token", async () => {
  const lease = new CloudflareDurableObjectLease({
    baseUrl: "https://locks.example.test",
    apiToken: "secret",
    fetch: async () => response({
      acquired: true,
      fencing_token: ABOVE_MAX_SAFE_FENCING_TOKEN,
      lease_expires_ms: 2_000_000_000_000,
    }),
  });

  await assert.rejects(
    () => lease.acquire(lockKey("zed-pkg/registry/unsafe"), opts, false),
    (error) => error instanceof LockError && error.kind === "transport",
  );
});

test("Cloudflare Durable Object replay is explicitly token-renewed before exposure", async () => {
  const calls = [];
  const outputs = [
    {
      acquired: true,
      replayed: true,
      renewed: false,
      fencing_token: "7",
      lease_expires_ms: 2_000_000_001_000,
    },
    { renewed: true, lease_expires_ms: 2_000_000_060_000 },
  ];
  const lease = new CloudflareDurableObjectLease({
    baseUrl: "https://locks.example.test",
    apiToken: "secret",
    fetch: async (url, init) => {
      calls.push({ url, init });
      return response(outputs.shift());
    },
  });

  const grant = await lease.acquire(lockKey("zed-pkg/registry/replay"), opts, false);
  assert.equal(grant.fencingToken, 7n);
  assert.equal(grant.leaseExpiresMs, 2_000_000_060_000);
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
    "/v1/leases/acquire",
    "/v1/leases/renew",
  ]);
  assert.match(calls[1].init.body, /"fencing_token":"7"/);
});

test("Redis REST client uses one cluster slot and exact JSON fencing tokens", async () => {
  const commands = [];
  const results = [
    { result: [1, MAX_SAFE_FENCING_TOKEN, 60_000, 0] },
    { result: [1, 60_000] },
    { result: 1 },
  ];
  const lease = new UpstashRedisLease({
    restUrl: "https://redis.example.test",
    token: "redis-secret",
    namespace: "ores-test",
    fetch: async (_url, init) => {
      commands.push(JSON.parse(init.body));
      return response(results.shift());
    },
  });
  const key = lockKey("shared-auth/session/rotate");

  const grant = await lease.acquire(key, opts, false);
  assert.equal(grant.fencingToken, BigInt(MAX_SAFE_FENCING_TOKEN));
  const renewed = await lease.renew(grant, 30_000);
  assert.equal(renewed.fencingToken, grant.fencingToken);
  assert.equal(await lease.release(renewed), true);

  assert.equal(commands[0][0], "EVAL");
  assert.equal(commands[0][2], 2);
  const lockRedisKey = commands[0][3];
  const fenceRedisKey = commands[0][4];
  const lockTag = lockRedisKey.match(/\{([^}]+)\}/)?.[1];
  const fenceTag = fenceRedisKey.match(/\{([^}]+)\}/)?.[1];
  assert.ok(lockTag);
  assert.equal(lockTag, fenceTag);
  assert.equal(commands[1][5], MAX_SAFE_FENCING_TOKEN);
  assert.equal(commands[2][5], MAX_SAFE_FENCING_TOKEN);
});

test("Redis REST client rejects a JSON-inexact fencing token", async () => {
  const lease = new UpstashRedisLease({
    restUrl: "https://redis.example.test",
    token: "redis-secret",
    fetch: async () => response({ result: [1, ABOVE_MAX_SAFE_FENCING_TOKEN, 60_000, 0] }),
  });

  await assert.rejects(
    () => lease.acquire(lockKey("shared-auth/session/unsafe"), opts, false),
    (error) => error instanceof LockError && error.kind === "transport",
  );
});

test("Redis replay is explicitly token-renewed before exposure", async () => {
  const commands = [];
  const results = [
    { result: [1, "7", 1_000, 1] },
    { result: [1, 60_000] },
  ];
  const lease = new UpstashRedisLease({
    restUrl: "https://redis.example.test",
    token: "redis-secret",
    fetch: async (_url, init) => {
      commands.push(JSON.parse(init.body));
      return response(results.shift());
    },
  });

  const grant = await lease.acquire(lockKey("shared-auth/session/replay"), opts, false);
  assert.equal(grant.fencingToken, 7n);
  assert.equal(commands.length, 2);
  assert.equal(commands[0][0], "EVAL");
  assert.equal(commands[1][0], "EVAL");
  assert.equal(commands[1][5], "7");
});

test("managed clients fail fast with contention when wait is false", async () => {
  const lease = new UpstashRedisLease({
    restUrl: "https://redis.example.test",
    token: "redis-secret",
    fetch: async () => response({ result: [0, "", 59_000, 0] }),
  });
  const key = lockKey("ores-chat/room/leader");

  await assert.rejects(
    () => lease.acquire(key, opts, false),
    (error) => error instanceof LockError && error.kind === "contention" && error.step === "fiducia.try_acquire",
  );
});
