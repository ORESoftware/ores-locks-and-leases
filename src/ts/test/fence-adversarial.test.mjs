import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  FenceValidationError,
  fencedWriteRequest,
  fencingTokenText,
} from "../dist/index.js";

const corpus = JSON.parse(
  await readFile(
    new URL("../../../conformance/cases/fence-decision.json", import.meta.url),
    "utf8",
  ),
);
const valid = Object.freeze({
  tenantScope: "tenant/acme",
  resourceKey: "example/jobs/rebuild",
  fencingToken: "1",
  operationId: "operation-0001",
  payloadSha256: "a".repeat(64),
  holder: "worker-a",
  leaseId: "lease-a",
});

function rejectsWithCode(callback, code) {
  assert.throws(
    callback,
    (error) => error instanceof FenceValidationError && error.code === code,
  );
}

test("adversarial corpus records its seed and exact case count", () => {
  if (corpus.schema !== "ores.locks-and-leases.fence-corpus/v2") {
    assert.ok(Array.isArray(corpus.cases) && corpus.cases.length > 0);
    return;
  }
  assert.match(corpus.seed, /^0x[0-9a-f]+$/u);
  assert.equal(corpus.generatedCaseCount, corpus.cases.length);
  assert.ok(corpus.generatedCaseCount >= 128);
});

test("all recorded unsigned-64 token boundaries remain exact", () => {
  const boundaries = corpus.tokenBoundaries ?? [
    "0",
    "9007199254740991",
    "9007199254740992",
    "9007199254740993",
    "9223372036854775807",
    "9223372036854775808",
    "18446744073709551615",
  ];
  for (const value of boundaries) {
    assert.equal(fencingTokenText(value), value);
  }
});

test("generated UTF-8 field adversaries fail with the recorded code", () => {
  for (const fixture of corpus.invalidFields ?? []) {
    rejectsWithCode(
      () => fencedWriteRequest({ ...valid, [fixture.field]: fixture.value }),
      fixture.expectedError,
    );
  }
});

test("generated wrong-runtime-type adversaries never coerce", () => {
  for (const fixture of corpus.wrongTypeCases ?? []) {
    rejectsWithCode(
      () => fencedWriteRequest({ ...valid, [fixture.field]: fixture.value }),
      fixture.expectedError,
    );
  }
});
