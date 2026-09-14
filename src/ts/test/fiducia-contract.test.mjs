import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_ACQUIRE_OPTIONS,
  FiduciaLease,
  lockKey,
} from "../dist/index.js";

test("FiduciaLease preserves queue identity and current lock wire shapes", async () => {
  const calls = [];
  let acquireCount = 0;
  const fetch = async (url, init) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body);
    calls.push({ path, body, redirect: init.redirect });

    if (path === "/v1/locks/acquire") {
      acquireCount += 1;
      const output = acquireCount === 1
        ? { acquired: false }
        : { acquired: true, fencing_token: 17, lease_expires_ms: 1_700_000_000_000 };
      return { status: 200, text: async () => JSON.stringify({ result: { output } }) };
    }
    if (path === "/v1/locks/renew") {
      return {
        status: 200,
        text: async () => JSON.stringify({ result: { output: { renewed: true, lease_expires_ms: 1_700_000_010_000 } } }),
      };
    }
    if (path === "/v1/locks/release") {
      return { status: 200, text: async () => JSON.stringify({ result: { output: { released: true } } }) };
    }
    return { status: 404, text: async () => "not found" };
  };

  const key = lockKey("t/fiducia-wire");
  const lease = new FiduciaLease({
    baseUrl: "https://fiducia.example",
    apiKey: "test-only",
    fetch,
  });
  const opts = {
    ...DEFAULT_ACQUIRE_OPTIONS,
    holder: "svc-wire-test",
    waitTimeoutMs: 100,
    retryIntervalMs: 1,
  };

  const grant = await lease.acquire(key, opts, true);
  assert.equal(grant.fencingToken, 17n);

  assert.equal(calls[0].path, "/v1/locks/acquire");
  assert.equal(calls[1].path, "/v1/locks/acquire");
  assert.equal(calls[0].body.wait, true);
  assert.equal(calls[0].body.wait_timeout_ms, 100);
  assert.equal(calls[0].body.holder, "svc-wire-test");
  assert.equal(calls[0].body.request_id, calls[1].body.request_id, "polls must reuse one logical acquire identity");
  assert.notEqual(calls[0].body.request_id, calls[0].body.holder, "request identity and holder identity are distinct");
  assert.equal(calls[0].redirect, "manual");

  // A grant first observed on a retry is renewed before it is exposed to work.
  assert.equal(calls[2].path, "/v1/locks/renew");
  assert.deepEqual(calls[2].body.keys, ["t/fiducia-wire"]);
  assert.equal("key" in calls[2].body, false);
  assert.equal(calls[2].body.fencing_token, 17);

  assert.equal(await lease.release(grant), true);
  assert.equal(calls[3].path, "/v1/locks/release");
  assert.equal(calls[3].body.holder, "svc-wire-test");
  assert.equal(calls[3].body.fencing_token, 17);
  assert.equal("key" in calls[3].body, false, "release identifies the whole grant by holder + fencing token");
});
