import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizePublicOperation,
  parsePublicScopePolicy,
} from "../../../managed/cloudflare-do/src/http-boundary.js";

const rawPolicy = JSON.stringify({
  key_prefixes: ["beamscale/runtime-lifecycle/prod/"],
  operations: ["acquire", "renew", "release"],
  max_ttl_ms: 60_000,
});

test("Cloudflare public scope binds one bearer to a component-safe key prefix", () => {
  const parsed = parsePublicScopePolicy(rawPolicy);
  assert.equal(parsed.configured, true);
  assert.equal(parsed.error, undefined);

  assert.equal(
    authorizePublicOperation(parsed.policy, "/v1/leases/acquire", {
      key: "beamscale/runtime-lifecycle/prod/runtime-42",
      ttl_ms: 30_000,
    }),
    null,
  );
  assert.equal(
    authorizePublicOperation(parsed.policy, "/v1/leases/acquire", {
      key: "beamscale/runtime-lifecycle/prod-shadow/runtime-42",
      ttl_ms: 30_000,
    }),
    "key_not_allowed",
  );
  assert.equal(
    authorizePublicOperation(parsed.policy, "/v1/leases/acquire", {
      key: "scintilla/runtime-lifecycle/prod/runtime-42",
      ttl_ms: 30_000,
    }),
    "key_not_allowed",
  );
});

test("Cloudflare public scope limits verbs and TTL before authority lookup", () => {
  const parsed = parsePublicScopePolicy(JSON.stringify({
    key_prefixes: ["scintilla/runtime-lifecycle/prod/"],
    operations: ["acquire", "renew"],
    max_ttl_ms: 15_000,
  }));

  assert.equal(
    authorizePublicOperation(parsed.policy, "/v1/leases/release", {
      key: "scintilla/runtime-lifecycle/prod/runtime-7",
    }),
    "operation_not_allowed",
  );
  assert.equal(
    authorizePublicOperation(parsed.policy, "/v1/leases/renew", {
      key: "scintilla/runtime-lifecycle/prod/runtime-7",
      ttl_ms: 15_001,
    }),
    "ttl_exceeds_scope",
  );
});

test("Cloudflare public scope parser fails closed on malformed or ambiguous policies", () => {
  assert.deepEqual(parsePublicScopePolicy(undefined), { configured: false, policy: null });
  for (const raw of [
    "{",
    JSON.stringify({ key_prefixes: [], operations: ["acquire"], max_ttl_ms: 1000 }),
    JSON.stringify({ key_prefixes: ["beamscale/runtime-lifecycle/prod"], operations: ["acquire"], max_ttl_ms: 1000 }),
    JSON.stringify({ key_prefixes: ["beamscale/runtime-lifecycle/../prod/"], operations: ["acquire"], max_ttl_ms: 1000 }),
    JSON.stringify({ key_prefixes: ["beamscale/runtime-lifecycle/prod/"], operations: ["admin"], max_ttl_ms: 1000 }),
    JSON.stringify({ key_prefixes: ["beamscale/runtime-lifecycle/prod/"], operations: ["acquire"], max_ttl_ms: 0 }),
    JSON.stringify({
      key_prefixes: ["beamscale/runtime-lifecycle/prod/"],
      operations: ["acquire"],
      max_ttl_ms: 1000,
      unexpected: true,
    }),
  ]) {
    assert.deepEqual(parsePublicScopePolicy(raw), {
      configured: true,
      error: "invalid_scope_policy",
    });
  }
});
