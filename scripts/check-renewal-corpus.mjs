import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const path = process.argv[2] ?? "conformance/cases/renewal-decision.json";
const corpus = JSON.parse(await readFile(path, "utf8"));

assert.equal(corpus.schema, "ores.locks.renewal-decision-corpus/v1");
assert.deepEqual(corpus.clockDomain, {
  minimum: 0,
  maximum: 9_007_199_254_740_991,
  unit: "monotonic-milliseconds",
});
assert.equal(corpus.fencingToken, "18446744073709551615");
assert.ok(Array.isArray(corpus.cases));
assert.ok(corpus.cases.length >= 10);

const names = new Set();
const requiredKinds = new Set(["wait", "renew_now", "lost", "invalid"]);
const seenKinds = new Set();
const seenReasons = new Set();

for (const entry of corpus.cases) {
  assert.equal(typeof entry.name, "string");
  assert.ok(entry.name.length > 0);
  assert.equal(names.has(entry.name), false, `duplicate case ${entry.name}`);
  names.add(entry.name);
  for (const field of ["startMs", "ttlMs", "renewEveryMs", "safetyMarginMs", "nowMs"]) {
    assert.ok(Number.isSafeInteger(entry[field]), `${entry.name}.${field}`);
  }
  assert.ok(entry.expect && typeof entry.expect === "object");
  assert.ok(requiredKinds.has(entry.expect.kind), `${entry.name}.expect.kind`);
  assert.ok(Number.isSafeInteger(entry.expect.checkInMs));
  assert.equal(typeof entry.expect.reason, "string");
  seenKinds.add(entry.expect.kind);
  if (entry.expect.reason) seenReasons.add(entry.expect.reason);

  const schedule = evaluate(entry);
  assert.deepEqual(schedule, entry.expect, entry.name);
}

assert.deepEqual(seenKinds, requiredKinds);
for (const required of ["expired", "clock_regression", "invalid_policy", "invalid_ttl", "deadline_overflow"]) {
  assert.ok(seenReasons.has(required), `missing reason ${required}`);
}

function evaluate(entry) {
  const max = 9_007_199_254_740_991;
  const maxTtl = 9_223_372_036_854;
  if (entry.startMs < 0 || entry.startMs > max) {
    return { kind: "invalid", checkInMs: 0, reason: "deadline_overflow" };
  }
  if (entry.ttlMs <= 0 || entry.ttlMs > maxTtl) {
    return { kind: "invalid", checkInMs: 0, reason: "invalid_ttl" };
  }
  if (
    entry.renewEveryMs <= 0 ||
    entry.safetyMarginMs <= 0 ||
    entry.renewEveryMs >= entry.ttlMs ||
    entry.safetyMarginMs >= entry.ttlMs
  ) {
    return { kind: "invalid", checkInMs: 0, reason: "invalid_policy" };
  }
  if (entry.startMs + entry.ttlMs > max || entry.startMs + entry.renewEveryMs > max) {
    return { kind: "invalid", checkInMs: 0, reason: "deadline_overflow" };
  }
  const deadline = entry.startMs + entry.ttlMs;
  const next = Math.min(entry.startMs + entry.renewEveryMs, deadline - entry.safetyMarginMs);
  if (entry.nowMs < entry.startMs) {
    return { kind: "lost", checkInMs: 0, reason: "clock_regression" };
  }
  if (entry.nowMs >= deadline) {
    return { kind: "lost", checkInMs: 0, reason: "expired" };
  }
  if (entry.nowMs >= next) {
    return { kind: "renew_now", checkInMs: 0, reason: "" };
  }
  return { kind: "wait", checkInMs: next - entry.nowMs, reason: "" };
}

console.log(JSON.stringify({
  schema: corpus.schema,
  cases: corpus.cases.length,
  fencingToken: corpus.fencingToken,
  result: "passed",
}));
