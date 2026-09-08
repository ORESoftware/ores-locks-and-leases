import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { LeaseRenewalSupervisor, RenewalError } from "../dist/index.js";

const MAX_TOKEN = 18_446_744_073_709_551_615n;

function grant(overrides = {}) {
  return {
    key: "renewal/test/resource",
    holder: "holder-a",
    fencingToken: MAX_TOKEN,
    leaseExpiresMs: 100_000,
    ttlMs: 10_000,
    ...overrides,
  };
}

const policy = { renewEveryMs: 4_000, safetyMarginMs: 2_000 };

async function corpus() {
  const text = await readFile(new URL("../../../conformance/cases/renewal-decision.json", import.meta.url), "utf8");
  return JSON.parse(text);
}

test("shared renewal decision corpus", async () => {
  for (const entry of (await corpus()).cases) {
    const inputGrant = grant({ ttlMs: entry.ttlMs });
    if (entry.expect.kind === "invalid") {
      assert.throws(
        () => new LeaseRenewalSupervisor(inputGrant, {
          renewEveryMs: entry.renewEveryMs,
          safetyMarginMs: entry.safetyMarginMs,
        }, entry.startMs),
        (error) => error instanceof RenewalError && error.reason === entry.expect.reason,
        entry.name,
      );
      continue;
    }
    const supervisor = new LeaseRenewalSupervisor(inputGrant, {
      renewEveryMs: entry.renewEveryMs,
      safetyMarginMs: entry.safetyMarginMs,
    }, entry.startMs);
    const decision = supervisor.decide(entry.nowMs);
    assert.equal(decision.kind, entry.expect.kind, entry.name);
    if (decision.kind === "wait") assert.equal(decision.checkInMs, entry.expect.checkInMs, entry.name);
    if (decision.kind === "lost") assert.equal(decision.reason, entry.expect.reason, entry.name);
    assert.equal(supervisor.grant.fencingToken, MAX_TOKEN, entry.name);
  }
});

test("successful checkpoint preserves full-width identity and reschedules", async () => {
  const supervisor = new LeaseRenewalSupervisor(grant(), policy, 1_000);
  const calls = [];
  const lease = {
    async acquire() { throw new Error("unused"); },
    async renew(previous, ttlMs) {
      calls.push([previous.fencingToken, ttlMs]);
      return grant({ leaseExpiresMs: 110_000 });
    },
    async release() { return true; },
  };
  const times = [5_000, 5_100];
  const checkpoint = await supervisor.checkpoint(lease, () => times.shift());
  assert.deepEqual(checkpoint, { kind: "renewed", checkInMs: 4_000 });
  assert.deepEqual(calls, [[MAX_TOKEN, 10_000]]);
  assert.equal(supervisor.localDeadlineMs, 15_100);
  assert.equal(supervisor.nextRenewalMs, 9_100);
});

test("identity, token, and authority deadline drift fail closed", () => {
  for (const [overrides, reason] of [
    [{ holder: "holder-b", leaseExpiresMs: 110_000 }, "identity_changed"],
    [{ fencingToken: MAX_TOKEN - 1n, leaseExpiresMs: 110_000 }, "token_changed"],
    [{ leaseExpiresMs: undefined }, "deadline_missing"],
    [{ leaseExpiresMs: 100_000 }, "deadline_regressed"],
  ]) {
    const supervisor = new LeaseRenewalSupervisor(grant(), policy, 1_000);
    assert.throws(
      () => supervisor.acceptRenewal(5_100, grant(overrides)),
      (error) => error instanceof RenewalError && error.reason === reason,
      reason,
    );
    assert.equal(supervisor.isLive, false);
  }
});

test("transport ambiguity is sticky and prevents another authority call", async () => {
  const supervisor = new LeaseRenewalSupervisor(grant(), policy, 1_000);
  let calls = 0;
  const lease = {
    async acquire() { throw new Error("unused"); },
    async renew() {
      calls += 1;
      throw new Error("partition");
    },
    async release() { return true; },
  };
  await assert.rejects(
    supervisor.checkpoint(lease, () => 5_000),
    (error) => error instanceof RenewalError && error.reason === "renewal_failed",
  );
  await assert.rejects(
    supervisor.checkpoint(lease, () => 5_001),
    (error) => error instanceof RenewalError && error.reason === "renewal_failed",
  );
  assert.equal(calls, 1);
});

test("renewal completing at the old deadline is rejected", () => {
  const supervisor = new LeaseRenewalSupervisor(grant(), policy, 1_000);
  assert.throws(
    () => supervisor.acceptRenewal(11_000, grant({ leaseExpiresMs: 110_000 })),
    (error) => error instanceof RenewalError && error.reason === "completion_after_deadline",
  );
});
