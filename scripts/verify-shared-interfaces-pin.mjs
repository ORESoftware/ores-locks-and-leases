import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const PIN_SCHEMA = "ores.locks.shared-interfaces-pin/v1";
const UPSTREAM_SCHEMA = "ores.shared-interfaces-source/v1";
const SHARED_REPOSITORY = "ORESoftware/ores-interfaces";
const SHARED_COMMIT = "82da36fde70ed09f478201979ee9009b92cb86de";
const SOURCE_REPOSITORY = "ores-otel/ores-interfaces";
const SOURCE_COMMIT = "3d26d3c0f79277b040e4b0665e6d6e6808f695de";
const VALIDATOR_REPOSITORY = "ORESoftware/typespec-json-schema-validator";
const VALIDATOR_COMMIT = "1614779275115258db73b92c938313e8ae437936";
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DECLARATIONS = Object.freeze([
  "Ores.Validation.GitHubActionsBuildLogEvent",
  "Ores.Validation.GitHubActionsLogStream",
  "Ores.Validation.PageQuery",
  "Ores.Validation.ProblemDetails",
  "Ores.Validation.PublicValidationContract",
  "Ores.Validation.RequestMeta",
]);
const REQUIRED_RUNTIME_EXPORTS = Object.freeze(["node", "native"]);

const root = process.cwd();
const upstreamRoot = resolve(
  process.env.ORES_INTERFACES_ROOT ?? "target/ores-interfaces-source",
);

async function loadJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function validatePin(pin) {
  assert.equal(pin?.schema, PIN_SCHEMA, "shared-interface pin schema must be versioned");
  assert.equal(pin.repository, SHARED_REPOSITORY, "shared-interface repository must be canonical");
  assert.match(pin.commit ?? "", SHA_PATTERN, "shared-interface dependency must use an immutable SHA");
  assert.equal(pin.commit, SHARED_COMMIT, "shared-interface dependency must use the reviewed merge commit");
  assert.equal(pin.source?.repository, SOURCE_REPOSITORY, "shared-interface source repository changed");
  assert.equal(pin.source?.commit, SOURCE_COMMIT, "shared-interface source commit changed");
  assert.equal(pin.validator?.repository, VALIDATOR_REPOSITORY, "shared-interface validator repository changed");
  assert.equal(pin.validator?.commit, VALIDATOR_COMMIT, "shared-interface validator commit must match the runtime gate");
  assert.equal(pin.authorityModel, "independent-typespec-and-json-schema-peers");
  assert.equal(pin.authorityTransfer, false, "shared interfaces must not transfer local contract authority");
  assert.deepEqual(pin.expectedDeclarations, DECLARATIONS, "complete reviewed shared declaration inventory required");
  assert.deepEqual(pin.requiredRuntimeExports, REQUIRED_RUNTIME_EXPORTS, "Node and native shared-interface exports are required");
  return pin;
}

function validateUpstream(pin, upstream) {
  assert.equal(upstream?.schema, UPSTREAM_SCHEMA, "upstream shared-interface policy schema changed");
  assert.equal(upstream.repository, pin.repository);
  assert.equal(upstream.source?.repository, pin.source.repository);
  assert.equal(upstream.source?.commit, pin.source.commit);
  assert.equal(upstream.validator?.repository, pin.validator.repository);
  assert.equal(upstream.validator?.commit, pin.validator.commit);
  assert.equal(upstream.authorityModel, pin.authorityModel);
  assert.equal(upstream.authorityTransfer, false);
  assert.deepEqual(upstream.expectedDeclarations, pin.expectedDeclarations);
  assert.deepEqual(upstream.scopes, {
    isomorphic: [...DECLARATIONS],
    client: [],
    edge: [],
    server: [],
  });
  for (const runtime of pin.requiredRuntimeExports) {
    assert.deepEqual(
      upstream.runtimeExports?.[runtime],
      ["isomorphic"],
      `${runtime} must export only the admitted isomorphic shared scope`,
    );
  }
  for (const runtime of ["browser", "node", "deno", "bun", "edge", "native"]) {
    assert.equal(
      upstream.runtimeExports?.[runtime]?.includes("server"),
      false,
      `${runtime} must not expose server-only declarations`,
    );
  }
}

function expectRejected(name, mutate) {
  const candidate = structuredClone(pin);
  mutate(candidate);
  assert.throws(() => validatePin(candidate), undefined, `${name} must be rejected`);
}

const pin = validatePin(await loadJson("contracts/shared-interfaces.json"));
const checkoutRevision = execFileSync("git", ["-C", upstreamRoot, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
assert.equal(checkoutRevision, pin.commit, "checked-out ores-interfaces revision must match the immutable consumer pin");
const upstream = await loadJson(`${upstreamRoot}/shared-interfaces.json`);
validateUpstream(pin, upstream);

const zpkg = await readFile(".zpkg.toml", "utf8");
assert.match(
  zpkg,
  /^"oresoftware\/ores-interfaces"\s*=\s*"\^0\.1\.0"$/mu,
  "zed package metadata must declare the shared-interface dependency",
);

expectRejected("floating dependency revision", (candidate) => { candidate.commit = "main"; });
expectRejected("wrong reviewed dependency revision", (candidate) => { candidate.commit = "0".repeat(40); });
expectRejected("validator split brain", (candidate) => { candidate.validator.commit = "0".repeat(40); });
expectRejected("authority transfer", (candidate) => { candidate.authorityTransfer = true; });
expectRejected("missing shared declaration", (candidate) => { candidate.expectedDeclarations.pop(); });
expectRejected("wrong source repository", (candidate) => { candidate.source.repository = "other/ores-interfaces"; });
expectRejected("missing native export", (candidate) => { candidate.requiredRuntimeExports = ["node"]; });

process.stdout.write(`${JSON.stringify({
  schema: "ores.locks.shared-interfaces-verification/v1",
  status: "passed",
  repository: SHARED_REPOSITORY,
  commit: checkoutRevision,
  sourceCommit: pin.source.commit,
  validatorCommit: pin.validator.commit,
  declarations: pin.expectedDeclarations.length,
  requiredRuntimeExports: pin.requiredRuntimeExports,
  negativeCanaries: 7,
}, null, 2)}\n`);
