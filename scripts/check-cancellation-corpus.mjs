import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const path = process.argv[2] ?? "conformance/cases/cancellation-race.json";
const corpus = JSON.parse(await readFile(path, "utf8"));

assert.equal(corpus.schema, "ores.locks.cancellation-race-corpus/v1");
const operation = corpus.operation;
assert.deepEqual(Object.keys(operation).sort(), ["holder", "keys", "request_id"]);
assert.ok(Array.isArray(operation.keys) && operation.keys.length > 0);
assert.ok(operation.keys.every((key) => typeof key === "string" && key.length > 0));
assert.equal(typeof operation.holder, "string");
assert.equal(typeof operation.request_id, "string");
assert.ok(Array.isArray(corpus.scenarios) && corpus.scenarios.length >= 4);

const names = new Set();
const triggers = new Set();
for (const scenario of corpus.scenarios) {
  assert.equal(typeof scenario.name, "string");
  assert.equal(names.has(scenario.name), false, `duplicate scenario ${scenario.name}`);
  names.add(scenario.name);
  assert.ok(["wait_timeout", "caller_cancel"].includes(scenario.trigger));
  triggers.add(scenario.trigger);
  assert.deepEqual(scenario.cancel_request, operation, `${scenario.name}: request identity drift`);
  assert.equal(scenario.expected.work, "not_started", `${scenario.name}: cancellation must precede work`);
  assert.equal(typeof scenario.expected.retryable, "boolean");
  assert.notEqual(scenario.expected.outcome, "contention", `${scenario.name}: cancellation is not contention`);

  if (scenario.cancel_response === null) {
    assert.equal(scenario.release_request, null);
    assert.equal(scenario.release_response, null);
    assert.equal(scenario.expected.outcome, "transport_safety_failure");
    assert.equal(scenario.expected.retryable, false);
    continue;
  }

  if (scenario.cancel_response.cancelled === true) {
    assert.equal(scenario.cancel_response.acquired, false);
    assert.equal(scenario.release_request, null);
    assert.equal(scenario.release_response, null);
    assert.equal(scenario.expected.outcome, "cancelled");
    continue;
  }

  assert.equal(scenario.cancel_response.cancelled, false);
  assert.equal(scenario.cancel_response.acquired, true);
  const grant = scenario.cancel_response.grant;
  assert.ok(grant && typeof grant === "object");
  assert.equal(grant.holder, operation.holder);
  assert.match(grant.fencing_token, /^[1-9]\d*$/);
  assert.deepEqual(scenario.release_request, {
    holder: grant.holder,
    fencing_token: grant.fencing_token,
  });
  assert.ok(scenario.release_response && typeof scenario.release_response.released === "boolean");
  assert.equal(
    scenario.expected.outcome,
    scenario.release_response.released ? "raced_grant_released" : "safety_failure",
  );
  assert.equal(scenario.expected.retryable, false);
}

assert.ok(triggers.has("wait_timeout"));
assert.ok(triggers.has("caller_cancel"));
console.log(JSON.stringify({ schema: corpus.schema, scenarios: corpus.scenarios.length, result: "passed" }));
