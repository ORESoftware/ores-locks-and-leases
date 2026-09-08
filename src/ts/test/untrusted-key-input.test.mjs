import assert from "node:assert/strict";
import { test } from "node:test";

import { advisoryKey, fnv1a64, lockKey } from "../dist/index.js";

const validKey = "ores-locks/runtime-admission/key";

function assertTypeRejected(callback, label) {
  assert.throws(
    callback,
    {
      name: "TypeError",
      message: "lock key must be a string",
    },
    label,
  );
}

test("direct TypeScript key helpers reject non-string runtime values", () => {
  const values = [
    0,
    1,
    1n,
    false,
    [],
    [validKey],
    {},
    null,
    undefined,
    Symbol("key"),
    () => validKey,
  ];

  for (const value of values) {
    assertTypeRejected(() => lockKey(value), "lockKey must reject a non-string");
    assertTypeRejected(() => fnv1a64(value), "fnv1a64 must reject a non-string");
    assertTypeRejected(
      () => advisoryKey(value),
      "advisoryKey must reject a non-string",
    );
  }
});

test("type rejection never invokes caller coercion hooks", () => {
  let calls = 0;
  const hostile = {
    toString() {
      calls += 1;
      return validKey;
    },
    valueOf() {
      calls += 1;
      return validKey;
    },
    [Symbol.toPrimitive]() {
      calls += 1;
      return validKey;
    },
  };

  assertTypeRejected(() => lockKey(hostile), "lockKey coercion hook");
  assertTypeRejected(() => fnv1a64(hostile), "fnv1a64 coercion hook");
  assertTypeRejected(() => advisoryKey(hostile), "advisoryKey coercion hook");
  assert.equal(calls, 0);
});

test("valid strings retain their existing key and hash semantics", () => {
  assert.equal(lockKey(validKey), validKey);
  const unsigned = fnv1a64(validKey);
  assert.equal(typeof unsigned, "bigint");
  assert.equal(advisoryKey(validKey), BigInt.asIntN(64, unsigned));
});
