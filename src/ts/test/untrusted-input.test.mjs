import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FenceValidationError,
  evaluateFence,
  fencedWriteRequest,
  fencingTokenText,
  lockKey,
} from "../dist/index.js";

const digest = "a".repeat(64);
const validInput = Object.freeze({
  tenantScope: "tenant/acme",
  resourceKey: "example/jobs/rebuild",
  fencingToken: "1",
  operationId: "op-1",
  payloadSha256: digest,
});

function assertInvalidType(field, value) {
  assert.throws(
    () => fencedWriteRequest({ ...validInput, [field]: value }),
    (error) =>
      error instanceof FenceValidationError &&
      error.code === "invalid_type" &&
      error.field === field,
    `${field}=${String(value)}`,
  );
}

test("untrusted required fields reject non-string runtime values", () => {
  for (const [field, values] of [
    ["tenantScope", [123, false, [], {}, null]],
    ["resourceKey", [123, false, [], {}, null]],
    ["operationId", [123, false, [], {}, null]],
    ["payloadSha256", [123, false, [digest], {}, null]],
  ]) {
    for (const value of values) assertInvalidType(field, value);
  }
});

test("untrusted optional fields reject present non-string values", () => {
  for (const field of ["holder", "leaseId"]) {
    for (const value of [123, false, [], {}, null]) {
      assertInvalidType(field, value);
    }
  }
});

test("fencing token text never coerces JavaScript numbers or containers", () => {
  for (const value of [0, 1, Number.MAX_SAFE_INTEGER, false, [], ["1"], {}, null]) {
    assert.throws(
      () => fencingTokenText(value),
      (error) =>
        error instanceof FenceValidationError &&
        error.code === "invalid_type" &&
        error.field === "fencingToken",
      String(value),
    );
  }
  assert.equal(fencingTokenText("1"), "1");
  assert.equal(fencingTokenText(1n), "1");
});

test("direct lockKey calls reject non-string runtime values", () => {
  for (const value of [123, false, [], ["example/jobs/rebuild"], {}, null]) {
    assert.throws(() => lockKey(value), {
      name: "TypeError",
      message: "lock key must be a string",
    });
  }
  assert.equal(lockKey("example/jobs/rebuild"), "example/jobs/rebuild");
});

test("forged requests are revalidated before an advanced decision", () => {
  const valid = fencedWriteRequest(validInput);
  assert.equal(evaluateFence(null, valid).kind, "advanced");

  for (const [field, value] of [
    ["tenantScope", 123],
    ["resourceKey", 123],
    ["fencingToken", 1],
    ["operationId", 123],
    ["payloadSha256", [digest]],
    ["holder", false],
    ["leaseId", {}],
  ]) {
    const forged = { ...valid, [field]: value };
    assert.throws(
      () => evaluateFence(null, forged),
      (error) =>
        error instanceof FenceValidationError &&
        error.code === "invalid_type" &&
        error.field === field,
      field,
    );
  }
});

test("type rejection does not invoke caller coercion hooks", () => {
  let calls = 0;
  const hostile = {
    toString() {
      calls += 1;
      return "tenant/acme";
    },
    valueOf() {
      calls += 1;
      return "tenant/acme";
    },
    [Symbol.toPrimitive]() {
      calls += 1;
      return "tenant/acme";
    },
  };

  assertInvalidType("tenantScope", hostile);
  assertInvalidType("payloadSha256", hostile);
  assert.throws(() => fencingTokenText(hostile), FenceValidationError);
  assert.throws(() => lockKey(hostile), TypeError);
  assert.equal(calls, 0);
});
