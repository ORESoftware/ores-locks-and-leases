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

test("Cloudflare Durable Object client preserves full-width fencing tokens", async () => {
  const calls = [];
  const outputs = [
    { acquired: true, fencing_token: "18446744073709551615", lease_expires_ms: 2_000_000_000_000 },
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
  assert.equal(grant.fencingToken, 18446744073709551615n);
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
  assert.match(calls[1].init.body, /18446744073709551615/);
});

test("Redis REST client uses one cluster slot and decimal u64 tokens", async () => {
  const commands = [];
  const results = [
    { result: [1, "18446744073709551615", 60_000] },
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
  assert.equal(grant.fencingToken, 18446744073709551615n);
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
  assert.equal(commands[1][5], "18446744073709551615");
  assert.equal(commands[2][5], "18446744073709551615");
});

test("managed clients fail fast with contention when wait is false", async () => {
  const lease = new UpstashRedisLease({
    restUrl: "https://redis.example.test",
    token: "redis-secret",
    fetch: async () => response({ result: [0, "", 59_000] }),
  });
  const key = lockKey("ores-chat/room/leader");

  await assert.rejects(
    () => lease.acquire(key, opts, false),
    (error) => error instanceof LockError && error.kind === "contention" && error.step === "fiducia.try_acquire",
  );
});
