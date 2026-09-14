import assert from "node:assert/strict";
import test from "node:test";

import { FiduciaLease, LockError, lockKey } from "../dist/index.js";

function response(output, status = 200) {
  return {
    status,
    async text() {
      return JSON.stringify({ result: { output } });
    },
  };
}

const key = lockKey("tenant/acme/jobs/rebuild");
const baseOpts = {
  ttlMs: 60_000,
  waitTimeoutMs: 5,
  retryIntervalMs: 10,
  holder: "worker-a",
  requestId: "attempt-42",
};

test("Fiducia timeout cancels the exact queued request before returning timeout", async () => {
  const calls = [];
  const lease = new FiduciaLease({
    baseUrl: "https://fiducia.example.test",
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      calls.push({ path, body: JSON.parse(init.body) });
      if (path === "/v1/locks/acquire") return response({ acquired: false });
      if (path === "/v1/locks/cancel") return response({ cancelled: true, acquired: false });
      throw new Error(`unexpected path ${path}`);
    },
  });

  await assert.rejects(
    () => lease.acquire(key, baseOpts, true),
    (error) => error instanceof LockError && error.kind === "timeout" && error.retryable,
  );

  assert.deepEqual(calls.map((call) => call.path), ["/v1/locks/acquire", "/v1/locks/cancel"]);
  assert.equal(calls[0].body.request_id, "attempt-42");
  assert.equal(calls[1].body.request_id, "attempt-42");
  assert.equal(calls[0].body.holder, calls[1].body.holder);
  assert.deepEqual(calls[1].body.keys, [String(key)]);
});

test("Fiducia caller cancellation releases a grant won by the cancel race", async () => {
  const calls = [];
  const controller = new AbortController();
  const lease = new FiduciaLease({
    baseUrl: "https://fiducia.example.test",
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      calls.push({ path, body: JSON.parse(init.body) });
      if (path === "/v1/locks/acquire") {
        controller.abort(new Error("caller stopped waiting"));
        return response({ acquired: false });
      }
      if (path === "/v1/locks/cancel") {
        return response({
          cancelled: false,
          acquired: true,
          grant: { holder: "worker-a", fencing_token: "41" },
        });
      }
      if (path === "/v1/locks/release") return response({ released: true });
      throw new Error(`unexpected path ${path}`);
    },
  });

  await assert.rejects(
    () => lease.acquire(key, { ...baseOpts, signal: controller.signal }, true),
    (error) => error instanceof LockError && error.kind === "transport" && !error.retryable,
  );

  assert.deepEqual(calls.map((call) => call.path), [
    "/v1/locks/acquire",
    "/v1/locks/cancel",
    "/v1/locks/release",
  ]);
  assert.equal(calls[0].body.request_id, "attempt-42");
  assert.equal(calls[1].body.request_id, "attempt-42");
  assert.equal(calls[2].body.holder, "worker-a");
  assert.equal(calls[2].body.fencing_token, 41);
});

test("Fiducia raced-grant release no-op becomes a safety failure", async () => {
  const lease = new FiduciaLease({
    baseUrl: "https://fiducia.example.test",
    fetch: async (url) => {
      const path = new URL(url).pathname;
      if (path === "/v1/locks/acquire") return response({ acquired: false });
      if (path === "/v1/locks/cancel") {
        return response({
          cancelled: false,
          acquired: true,
          grant: { holder: "worker-a", fencing_token: "41" },
        });
      }
      if (path === "/v1/locks/release") return response({ released: false });
      throw new Error(`unexpected path ${path}`);
    },
  });

  await assert.rejects(
    () => lease.acquire(key, baseOpts, true),
    (error) =>
      error instanceof LockError &&
      error.kind === "transport" &&
      /raced grant release was a no-op/.test(error.message),
  );
});

test("Fiducia cancel transport ambiguity never downgrades to timeout or contention", async () => {
  const lease = new FiduciaLease({
    baseUrl: "https://fiducia.example.test",
    fetch: async (url) => {
      const path = new URL(url).pathname;
      if (path === "/v1/locks/acquire") return response({ acquired: false });
      if (path === "/v1/locks/cancel") return response({ error: "unavailable" }, 503);
      throw new Error(`unexpected path ${path}`);
    },
  });

  await assert.rejects(
    () => lease.acquire(key, baseOpts, true),
    (error) => error instanceof LockError && error.kind === "transport" && !error.retryable,
  );
});
