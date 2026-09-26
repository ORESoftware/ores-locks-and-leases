import assert from "node:assert/strict";
import test from "node:test";

import {
  BeamScaleCriticalSectionLease,
  LockError,
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

test("BeamScale exports sequence as fencing watermark and retains full token for copied grants", async () => {
  const calls = [];
  const outputs = [
    response({
      op: "critical_section_result",
      operation: "acquire",
      ok: true,
      token: { runtime_epoch: 41, owner_epoch: 7, sequence: 13 },
      expires_at_ms: 2_000_000_000_000,
    }),
    response({
      op: "critical_section_result",
      operation: "renew",
      ok: true,
      token: { runtime_epoch: 41, owner_epoch: 7, sequence: 13 },
      expires_at_ms: 2_000_000_060_000,
    }),
    response({ op: "critical_section_result", operation: "release", ok: true }),
  ];
  const lease = new BeamScaleCriticalSectionLease({
    baseUrl: "https://api.beamscale.test",
    apiToken: "secret",
    deploymentId: "orders-critical",
    fetch: async (url, init) => {
      calls.push({ url, init });
      return outputs.shift();
    },
  });
  const key = lockKey("orders/reconcile");
  const grant = await lease.acquire(key, opts, false);
  assert.equal(grant.fencingToken, 13n);
  assert.equal(grant.leaseExpiresMs, 2_000_000_000_000);

  // Maintained/renewal paths snapshot grants. Full token lookup must therefore
  // use stable grant identity rather than object identity.
  const copied = { ...grant };
  const renewed = await lease.renew(copied, 60_000);
  assert.equal(renewed.fencingToken, 13n);
  assert.equal(renewed.leaseExpiresMs, 2_000_000_060_000);
  assert.equal(await lease.release({ ...renewed }), true);

  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
    "/v1/critical-sections/orders-critical/acquire",
    "/v1/critical-sections/orders-critical/renew",
    "/v1/critical-sections/orders-critical/release",
  ]);
  const renewBody = JSON.parse(calls[1].init.body);
  assert.deepEqual(renewBody.token, { runtime_epoch: 41, owner_epoch: 7, sequence: 13 });
});

test("BeamScale stale renewal fails as lost_lease and clears retained authority", async () => {
  const outputs = [
    response({
      op: "critical_section_result",
      operation: "acquire",
      ok: true,
      token: { runtime_epoch: 5, owner_epoch: 2, sequence: 9 },
      expires_at_ms: 2_000_000_000_000,
    }),
    response({
      op: "critical_section_result",
      operation: "renew",
      ok: false,
      error_code: "stale_or_not_owner",
    }, 409),
  ];
  const lease = new BeamScaleCriticalSectionLease({
    baseUrl: "https://api.beamscale.test",
    apiToken: "secret",
    deploymentId: "orders-critical",
    fetch: async () => outputs.shift(),
  });
  const grant = await lease.acquire(lockKey("orders/stale"), opts, false);
  await assert.rejects(
    () => lease.renew({ ...grant }, 60_000),
    (error) => error instanceof LockError && error.kind === "lost_lease",
  );
  await assert.rejects(
    () => lease.release({ ...grant }),
    (error) => error instanceof LockError && error.kind === "lost_lease",
  );
});

test("BeamScale busy acquire maps to contention when wait is false", async () => {
  const lease = new BeamScaleCriticalSectionLease({
    baseUrl: "https://api.beamscale.test",
    apiToken: "secret",
    deploymentId: "orders-critical",
    fetch: async () => response({
      op: "critical_section_result",
      operation: "acquire",
      ok: false,
      error_code: "busy",
      remaining_ms: 50_000,
    }, 409),
  });
  await assert.rejects(
    () => lease.acquire(lockKey("orders/busy"), opts, false),
    (error) => error instanceof LockError && error.kind === "contention",
  );
});

test("BeamScale ambiguous acquire safely replays once with the same request id", async () => {
  const calls = [];
  const lease = new BeamScaleCriticalSectionLease({
    baseUrl: "https://api.beamscale.test",
    apiToken: "secret",
    deploymentId: "orders-critical",
    fetch: async (_url, init) => {
      calls.push(JSON.parse(init.body));
      if (calls.length === 1) throw new Error("connection reset after write");
      return response({
        op: "critical_section_result",
        operation: "acquire",
        ok: true,
        token: { runtime_epoch: 11, owner_epoch: 4, sequence: 17 },
        expires_at_ms: 2_000_000_000_000,
      });
    },
  });
  const grant = await lease.acquire(
    lockKey("orders/ambiguous"),
    { ...opts, requestId: "request-ambiguous-1" },
    true,
  );
  assert.equal(grant.fencingToken, 17n);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].request_id, "request-ambiguous-1");
  assert.equal(calls[1].request_id, "request-ambiguous-1");
});

test("BeamScale repeated ambiguous transport still fails closed", async () => {
  let calls = 0;
  const lease = new BeamScaleCriticalSectionLease({
    baseUrl: "https://api.beamscale.test",
    apiToken: "secret",
    deploymentId: "orders-critical",
    fetch: async () => {
      calls += 1;
      throw new Error("connection reset after write");
    },
  });
  await assert.rejects(
    () => lease.acquire(
      lockKey("orders/ambiguous-twice"),
      { ...opts, requestId: "request-ambiguous-2" },
      true,
    ),
    (error) => error instanceof LockError && error.kind === "transport",
  );
  assert.equal(calls, 2);
});

test("BeamScale release stale result is a committed no-op", async () => {
  const outputs = [
    response({
      op: "critical_section_result",
      operation: "acquire",
      ok: true,
      token: { runtime_epoch: 8, owner_epoch: 3, sequence: 10 },
      expires_at_ms: 2_000_000_000_000,
    }),
    response({
      op: "critical_section_result",
      operation: "release",
      ok: false,
      error_code: "stale_or_not_owner",
    }, 409),
  ];
  const lease = new BeamScaleCriticalSectionLease({
    baseUrl: "https://api.beamscale.test",
    apiToken: "secret",
    deploymentId: "orders-critical",
    fetch: async () => outputs.shift(),
  });
  const grant = await lease.acquire(lockKey("orders/released"), opts, false);
  assert.equal(await lease.release({ ...grant }), false);
});
