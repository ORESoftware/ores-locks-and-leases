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
    new URL("../../../conformance/cases/fence-decision.json", import.meta.url),
    "utf8",
  ),
);
const digest = "a".repeat(64);
const validInput = Object.freeze({
  tenantScope: "tenant/acme",
  resourceKey: "example/jobs/rebuild",
  fencingToken: "1",
  operationId: "op-1",
  payloadSha256: digest,
});

function throwsFenceCode(callback, code) {
  assert.throws(
    callback,
    (error) => error instanceof FenceValidationError && error.code === code,
  );
}

for (const fixture of corpus.cases) {
  test(`fence conformance: ${fixture.name}`, () => {
    const incoming = fencedWriteRequest(fixture.incoming);
    const current =
      fixture.current === null ? null : fenceWatermark(fixture.current);

    if (fixture.expectedError !== undefined) {
      assert.throws(
        () => evaluateFence(current, incoming),
        (error) =>
          error instanceof FenceValidationError &&
          error.code === fixture.expectedError,
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
    );
  });
}

test("invalid fencing-token text fails closed", () => {
  for (const value of corpus.invalidTokens) {
    assert.throws(
      () => fencingTokenText(value),
      (error) =>
        error instanceof FenceValidationError &&
        error.code === "invalid_fencing_token",
      value,
    );
  }
});

test("full unsigned-64 maximum remains exact", () => {
  assert.equal(
    fencingTokenText(18_446_744_073_709_551_615n),
    "18446744073709551615",
  );
});

test("top-level request input must be a non-array object", () => {
  for (const value of [null, undefined, false, 7, "request", [], [validInput]]) {
    throwsFenceCode(() => fencedWriteRequest(value), "invalid_type");
  }
});

test("required string fields reject missing and non-string values", () => {
  const cases = [
    ["tenantScope", undefined],
    ["tenantScope", 123],
    ["tenantScope", { value: "tenant/acme" }],
    ["resourceKey", undefined],
    ["resourceKey", false],
    ["resourceKey", ["example/jobs/rebuild"]],
    ["operationId", undefined],
    ["operationId", 123],
    ["operationId", true],
  ];
  for (const [field, value] of cases) {
    throwsFenceCode(
      () => fencedWriteRequest({ ...validInput, [field]: value }),
      "invalid_type",
    );
  }
});

test("optional metadata rejects null and non-string values", () => {
  for (const [field, value] of [
    ["holder", null],
    ["holder", 7],
    ["holder", ["worker"]],
    ["leaseId", null],
    ["leaseId", false],
    ["leaseId", { value: "lease-1" }],
  ]) {
    throwsFenceCode(
      () => fencedWriteRequest({ ...validInput, [field]: value }),
      "invalid_type",
    );
  }
});

test("numeric or otherwise non-text fencing tokens fail closed", () => {
  for (const value of [0, 1, 42, 9_007_199_254_740_991, null, {}, [], Symbol("token")]) {
    throwsFenceCode(
      () => fencedWriteRequest({ ...validInput, fencingToken: value }),
      "invalid_fencing_token",
    );
  }
});

test("payload digest never accepts coercible non-string values", () => {
  for (const value of [[digest], { toString: () => digest }, 123, null, true]) {
    throwsFenceCode(
      () => fencedWriteRequest({ ...validInput, payloadSha256: value }),
      "invalid_payload_sha256",
    );
  }
});

test("evaluateFence revalidates forged objects before returning advanced", () => {
  const request = fencedWriteRequest(validInput);
  for (const [field, value, code] of [
    ["tenantScope", 123, "invalid_type"],
    ["resourceKey", ["example/jobs/rebuild"], "invalid_type"],
    ["operationId", false, "invalid_type"],
    ["payloadSha256", [digest], "invalid_payload_sha256"],
    ["fencingToken", 1, "invalid_fencing_token"],
    ["holder", null, "invalid_type"],
  ]) {
    const forged = { ...request, [field]: value };
    throwsFenceCode(() => evaluateFence(null, forged), code);
  }
});

test("field validation does not invoke caller coercion hooks", () => {
  let coercions = 0;
  const hostile = {
    get length() {
      coercions += 1;
      throw new Error("length getter executed");
    },
    toString() {
      coercions += 1;
      throw new Error("toString executed");
    },
    [Symbol.toPrimitive]() {
      coercions += 1;
      throw new Error("primitive conversion executed");
    },
  };
  throwsFenceCode(
    () => fencedWriteRequest({ ...validInput, tenantScope: hostile }),
    "invalid_type",
  );
  throwsFenceCode(
    () => fencedWriteRequest({ ...validInput, payloadSha256: hostile }),
    "invalid_payload_sha256",
  );
  throwsFenceCode(
    () => fencedWriteRequest({ ...validInput, fencingToken: hostile }),
    "invalid_fencing_token",
  );
  assert.equal(coercions, 0);
});
