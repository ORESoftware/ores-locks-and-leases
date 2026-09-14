import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const PIN_SCHEMA = "ores.locks.shared-interfaces-pin/v2";
const UPSTREAM_SCHEMA = "ores.shared-interfaces-source/v1";
const SHARED_REPOSITORY = "ORESoftware/ores-interfaces";
const SHARED_COMMIT = "ec51630b2139a58831280bc7facbeaf21834c1ea";
const SOURCE_REPOSITORY = "ores-otel/ores-interfaces";
const SOURCE_COMMIT = "3d26d3c0f79277b040e4b0665e6d6e6808f695de";
const UPSTREAM_VALIDATOR_REPOSITORY = "ORESoftware/typespec-json-schema-validator";
const UPSTREAM_VALIDATOR_COMMIT = "1614779275115258db73b92c938313e8ae437936";
const DECLARATIONS = Object.freeze([
  "Ores.Validation.GitHubActionsBuildLogEvent",
  "Ores.Validation.GitHubActionsLogStream",
  "Ores.Validation.PageQuery",
  "Ores.Validation.ProblemDetails",
  "Ores.Validation.PublicValidationContract",
  "Ores.Validation.RequestMeta",
]);
const REQUIRED_RUNTIME_EXPORTS = Object.freeze(["node", "native"]);
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const upstreamRoot = resolve(process.env.ORES_INTERFACES_ROOT ?? "target/ores-interfaces-source");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function section(text, wanted) {
  let active = null;
  const lines = [];
  for (const raw of text.split(/\r?\n/u)) {
    const heading = raw.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/u);
    if (heading) {
      active = heading[1];
      continue;
    }
    if (active === wanted) lines.push(raw);
  }
  return lines.join("\n");
}

function assertDependencyBoundary() {
  const manifest = readFileSync(".zpkg.toml", "utf8");
  const runtime = section(manifest, "dependencies");
  const build = section(manifest, "build-dependencies");

  assert.match(runtime, /^\s*"oresoftware\/ores-interfaces"\s*=\s*"\^0\.1\.0"\s*$/mu,
    "ores-interfaces must be a runtime/shared semantic dependency");
  assert.doesNotMatch(runtime, /ores-contracts|typespec-json-schema-validator/u,
    "validation/codegen tooling must not be a runtime dependency");
  assert.match(build, /^\s*"oresoftware\/ores-contracts"\s*=\s*"\^0\.1\.0"\s*$/mu,
    "ores-contracts must be build/admission-only");
  assert.doesNotMatch(build, /ores-locks-and-leases/u,
    "the package must not depend on itself through a tooling edge");
}

function validatePin(pin) {
  assert.equal(pin?.schema, PIN_SCHEMA);
  assert.equal(pin.repository, SHARED_REPOSITORY);
  assert.match(pin.commit ?? "", SHA_PATTERN);
  assert.equal(pin.commit, SHARED_COMMIT, "consumer pin must use the reviewed current ores-interfaces commit");
  assert.equal(pin.source?.repository, SOURCE_REPOSITORY);
  assert.equal(pin.source?.commit, SOURCE_COMMIT);
  assert.equal(pin.upstreamValidator?.repository, UPSTREAM_VALIDATOR_REPOSITORY);
  assert.equal(pin.upstreamValidator?.commit, UPSTREAM_VALIDATOR_COMMIT,
    "record upstream validator provenance without forcing the lock-lib runtime validator to downgrade");
  assert.equal(pin.authorityModel, "independent-typespec-and-json-schema-peers");
  assert.equal(pin.authorityTransfer, false);
  assert.deepEqual(pin.expectedDeclarations, DECLARATIONS);
  assert.deepEqual(pin.requiredRuntimeExports, REQUIRED_RUNTIME_EXPORTS);
}

function validateUpstream(pin, upstream) {
  assert.equal(upstream?.schema, UPSTREAM_SCHEMA);
  assert.equal(upstream.repository, pin.repository);
  assert.equal(upstream.source?.repository, pin.source.repository);
  assert.equal(upstream.source?.commit, pin.source.commit);
  assert.equal(upstream.validator?.repository, pin.upstreamValidator.repository);
  assert.equal(upstream.validator?.commit, pin.upstreamValidator.commit);
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
    assert.deepEqual(upstream.runtimeExports?.[runtime], ["isomorphic"], `${runtime} must expose only isomorphic shared interfaces`);
  }
  for (const runtime of ["browser", "node", "deno", "bun", "edge", "native"]) {
    assert.equal(upstream.runtimeExports?.[runtime]?.includes("server"), false,
      `${runtime} must not expose server-only declarations`);
  }
}

function assertNoReverseDependency() {
  const upstreamManifestPath = resolve(upstreamRoot, ".zpkg.toml");
  assert.equal(existsSync(upstreamManifestPath), true, "pinned ores-interfaces checkout must contain .zpkg.toml");
  const upstreamManifest = readFileSync(upstreamManifestPath, "utf8");
  assert.doesNotMatch(upstreamManifest, /oresoftware\/ores-locks-and-leases|ORESoftware\/ores-locks-and-leases/u,
    "ores-interfaces must not depend back on the lock domain package");
}

function expectRejected(pin, name, mutate) {
  const candidate = structuredClone(pin);
  mutate(candidate);
  assert.throws(() => validatePin(candidate), undefined, `${name} must be rejected`);
}

assertDependencyBoundary();
assert.equal(existsSync("contracts/typespec/main.tsp"), true);
assert.equal(existsSync("contracts/json-schema/contract.schema.json"), true);
assert.equal(existsSync("scripts/check-tjsv-contracts.sh"), true);

const pin = readJson("contracts/shared-interfaces.json");
validatePin(pin);
const revision = spawnSync("git", ["-C", upstreamRoot, "rev-parse", "HEAD"], { encoding: "utf8" });
assert.equal(revision.status, 0, revision.stderr || "unable to inspect ores-interfaces checkout");
assert.equal(revision.stdout.trim(), pin.commit, "checked-out ores-interfaces revision must equal the immutable consumer pin");
validateUpstream(pin, readJson(resolve(upstreamRoot, "shared-interfaces.json")));
assertNoReverseDependency();

expectRejected(pin, "floating shared-interface revision", (value) => { value.commit = "main"; });
expectRejected(pin, "wrong shared-interface revision", (value) => { value.commit = "0".repeat(40); });
expectRejected(pin, "upstream validator provenance drift", (value) => { value.upstreamValidator.commit = "0".repeat(40); });
expectRejected(pin, "authority transfer", (value) => { value.authorityTransfer = true; });
expectRejected(pin, "missing declaration", (value) => { value.expectedDeclarations.pop(); });
expectRejected(pin, "wrong source repository", (value) => { value.source.repository = "other/ores-interfaces"; });
expectRejected(pin, "missing native runtime export", (value) => { value.requiredRuntimeExports = ["node"]; });

process.stdout.write(`${JSON.stringify({
  schema: "ores.locks.shared-interface-boundary-receipt/v2",
  status: "passed",
  dependencyBoundary: {
    runtime: ["oresoftware/ores-interfaces"],
    build: ["oresoftware/ores-contracts"],
    reverseDependency: false,
  },
  sharedInterfaces: {
    repository: pin.repository,
    commit: revision.stdout.trim(),
    sourceCommit: pin.source.commit,
    upstreamValidatorCommit: pin.upstreamValidator.commit,
    declarations: pin.expectedDeclarations.length,
    requiredRuntimeExports: pin.requiredRuntimeExports,
  },
  negativeCanaries: 7,
}, null, 2)}\n`);
