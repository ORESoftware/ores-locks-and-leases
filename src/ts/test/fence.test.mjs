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
