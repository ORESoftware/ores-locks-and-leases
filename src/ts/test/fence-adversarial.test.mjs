import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  FenceValidationError,
  evaluateFence,
  fenceWatermark,
  fencedWriteRequest,
  fencingTokenText,
} from "../dist/index.js";

const corpus = JSON.parse(
  await readFile(
    process.env["ORES_FENCE_ADVERSARIAL_CORPUS"] ??
      new URL("../../../conformance/cases/fence-adversarial.json", import.meta.url),
    "utf8",
  ),
);

function assertFenceError(callback, expected, name) {
  assert.throws(
    callback,
    (error) =>
      error instanceof FenceValidationError && error.code === expected,
    name,
  );
}

test("adversarial corpus has the pinned reproducible identity", () => {
  assert.equal(corpus.schema, "ores.locks.fence-adversarial/v1");
  assert.equal(corpus.generator, "splitmix64-v1");
  assert.equal(corpus.seed, "0x4f5245534c4f434b");
});

for (const fixture of corpus.tokenCases) {
  test(`adversarial token: ${fixture.name}`, () => {
    if (fixture.expected.ok) {
      assert.equal(fencingTokenText(fixture.value), fixture.expected.canonical);
      return;
    }
    assertFenceError(
      () => fencingTokenText(fixture.value),
      fixture.expected.error,
      fixture.name,
    );
  });
}

for (const fixture of corpus.requestCases) {
  test(`adversarial request: ${fixture.name}`, () => {
    if (fixture.expected.ok) {
      const request = fencedWriteRequest(fixture.incoming);
      assert.equal(request.fencingToken, fixture.incoming.fencingToken);
      return;
    }
    assertFenceError(
      () => fencedWriteRequest(fixture.incoming),
      fixture.expected.error,
      fixture.name,
    );
  });
}

for (const fixture of corpus.decisionCases) {
  test(`adversarial decision: ${fixture.name}`, () => {
    const incoming = fencedWriteRequest(fixture.incoming);
    const current =
      fixture.current === null ? null : fenceWatermark(fixture.current);
    if (fixture.expectedError !== undefined) {
      assertFenceError(
        () => evaluateFence(current, incoming),
        fixture.expectedError,
        fixture.name,
      );
      return;
    }
    const decision = evaluateFence(current, incoming);
    assert.deepEqual(
      {
        kind: decision.kind,
        shouldApply: decision.shouldApply,
        incomingToken: decision.incomingToken,
        currentToken: decision.currentToken,
        previousToken: decision.previousToken ?? null,
      },
      fixture.expected,
      fixture.name,
    );
  });
}

test("generated wire adversaries cannot trigger coercion or escape the closed object", () => {
  let calls = 0;
  const hostile = {
    toString() {
      calls += 1;
      throw new Error("coercion executed");
    },
    [Symbol.toPrimitive]() {
      calls += 1;
      throw new Error("primitive conversion executed");
    },
  };
  const valid = corpus.requestCases.find((item) => item.expected.ok).incoming;
  for (const [field, value, code] of [
    ["tenantScope", hostile, "invalid_type"],
    ["fencingToken", hostile, "invalid_fencing_token"],
    ["payloadSha256", hostile, "invalid_payload_sha256"],
  ]) {
    assertFenceError(
      () => fencedWriteRequest({ ...valid, [field]: value }),
      code,
      field,
    );
  }
  assertFenceError(
    () => fencedWriteRequest({ ...valid, outboxKey: "forged" }),
    "unexpected_field",
    "closed object",
  );
  assert.equal(calls, 0);
});
