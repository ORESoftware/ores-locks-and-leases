import assert from "node:assert/strict";
import test from "node:test";

import { CloudflareDurableObjectLease, lockKey } from "../dist/index.js";

const key = lockKey("oresoftware/fencing/admission");
const acquireOpts = {
  ttlMs: 30_000,
  waitTimeoutMs: 10,
  retryIntervalMs: 1,
  holder: "worker-a",
};

function response(body, status = 200) {
  return { status, text: async () => JSON.stringify(body) };
}

function leaseReturning(fencingToken) {
  return new CloudflareDurableObjectLease({
    baseUrl: "https://locks.invalid",
    apiToken: "test-only",
    fetch: async () => response({
      acquired: true,
      fencing_token: fencingToken,
      lease_expires_ms: 2_000_000_000_000,
      replayed: false,
    }),
  });
}

for (const invalid of [
  undefined,
  null,
  0,
  -1,
  1.5,
  true,
  "0",
  "01",
  "1.0",
  "+1",
  " 1",
  Number.MAX_SAFE_INTEGER + 1,
  "9007199254740992",
]) {
  test(`HTTP client rejects acquired grant with invalid fencing token ${String(invalid)}`, async () => {
    const lease = leaseReturning(invalid);
    await assert.rejects(
      lease.acquire(key, acquireOpts, false),
      /acquired without a valid fencing token/,
    );
  });
}

test("HTTP client admits both exact numeric and canonical decimal-string boundary tokens", async () => {
  for (const value of [1, "1", Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)]) {
    const grant = await leaseReturning(value).acquire(key, acquireOpts, false);
    assert.equal(grant.fencingToken, BigInt(value));
  }
});

test("renew/release serialize authority as canonical decimal text", async () => {
  const calls = [];
  const lease = new CloudflareDurableObjectLease({
    baseUrl: "https://locks.invalid",
    apiToken: "test-only",
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      if (body.ttl_ms !== undefined && body.fencing_token !== undefined) {
        return response({ renewed: true, lease_expires_ms: 2_000_000_000_000 });
      }
      if (body.fencing_token !== undefined) return response({ released: true });
      return response({ acquired: true, fencing_token: "7", replayed: false });
    },
  });

  const grant = { key, holder: "worker-a", fencingToken: 9007199254740991n, ttlMs: 30_000 };
  await lease.renew(grant, 10_000);
  await lease.release(grant);
  assert.equal(calls[0].fencing_token, "9007199254740991");
  assert.equal(calls[1].fencing_token, "9007199254740991");
  assert.equal(typeof calls[0].fencing_token, "string");
});
