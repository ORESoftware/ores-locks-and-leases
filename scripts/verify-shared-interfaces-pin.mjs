import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const PIN_SCHEMA = "ores.locks.shared-interfaces-pin/v1";
const UPSTREAM_SCHEMA = "ores.shared-interfaces-source/v1";
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHARED_COMMIT = "a347aac8b828998a80a3f99215bc00dd3046bdcd";
const SOURCE_COMMIT = "3d26d3c0f79277b040e4b0665e6d6e6808f695de";
const CERTIFICATION_VALIDATOR_COMMIT = "1614779275115258db73b92c938313e8ae437936";
const DECLARATIONS = Object.freeze([
  "Ores.Validation.GitHubActionsBuildLogEvent",
  "Ores.Validation.GitHubActionsLogStream",
  "Ores.Validation.PageQuery",
  "Ores.Validation.ProblemDetails",
  "Ores.Validation.PublicValidationContract",
  "Ores.Validation.RequestMeta",
]);
const REQUIRED_RUNTIME_EXPORTS = Object.freeze(["node", "native"]);
const upstreamRoot = resolve(process.env.ORES_INTERFACES_ROOT ?? "target/ores-interfaces-source");

async function loadJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function validatePin(pin) {
  assert.equal(pin?.schema, PIN_SCHEMA);
  assert.equal(pin.repository, "ORESoftware/ores-interfaces");
  assert.match(pin.commit ?? "", SHA_PATTERN, "shared-interface dependency must use an immutable SHA");
  assert.equal(pin.commit, SHARED_COMMIT, "shared-interface dependency must use the reviewed exact commit");
  assert.equal(pin.source?.repository, "ores-otel/ores-interfaces");
  assert.match(pin.source?.commit ?? "", SHA_PATTERN);
  assert.equal(pin.source.commit, SOURCE_COMMIT, "shared-interface source provenance must remain exact");
  assert.equal(pin.certification?.validatorRepository, "ORESoftware/typespec-json-schema-validator");
  assert.match(pin.certification?.validatorCommit ?? "", SHA_PATTERN);
  assert.equal(pin.certification.validatorCommit, CERTIFICATION_VALIDATOR_COMMIT, "producer certification provenance must remain exact");
  assert.equal(pin.authorityModel, "independent-typespec-and-json-schema-peers");
  assert.equal(pin.authorityTransfer, false, "shared interfaces must not transfer local contract authority");
  assert.deepEqual(pin.expectedDeclarations, DECLARATIONS);
  assert.deepEqual(pin.requiredRuntimeExports, REQUIRED_RUNTIME_EXPORTS);
  return pin;
}

function validateUpstream(pin, upstream) {
  assert.equal(upstream?.schema, UPSTREAM_SCHEMA);
  assert.equal(upstream.repository, pin.repository);
  assert.equal(upstream.source?.repository, pin.source.repository);
  assert.equal(upstream.source?.commit, pin.source.commit);
  assert.equal(upstream.validator?.repository, pin.certification.validatorRepository);
  assert.equal(upstream.validator?.commit, pin.certification.validatorCommit);
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
    assert.deepEqual(upstream.runtimeExports?.[runtime], ["isomorphic"]);
  }
  for (const runtime of ["browser", "node", "deno", "bun", "edge", "native"]) {
    assert.equal(upstream.runtimeExports?.[runtime]?.includes("server"), false);
  }
}

function expectRejected(pin, mutate) {
  const candidate = structuredClone(pin);
  mutate(candidate);
  assert.throws(() => validatePin(candidate));
}

const pin = validatePin(await loadJson("contracts/shared-interfaces.json"));
const checkoutRevision = execFileSync("git", ["-C", upstreamRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.equal(checkoutRevision, pin.commit, "checked-out ores-interfaces revision must match consumer pin");
validateUpstream(pin, await loadJson(`${upstreamRoot}/shared-interfaces.json`));

const zpkg = await readFile(".zpkg.toml", "utf8");
assert.match(zpkg, /^"oresoftware\/ores-interfaces"\s*=\s*"\^0\.1\.0"$/mu);

expectRejected(pin, (candidate) => { candidate.commit = "main"; });
expectRejected(pin, (candidate) => { candidate.commit = "0".repeat(40); });
expectRejected(pin, (candidate) => { candidate.certification.validatorCommit = "main"; });
expectRejected(pin, (candidate) => { candidate.authorityTransfer = true; });
expectRejected(pin, (candidate) => { candidate.expectedDeclarations.pop(); });
expectRejected(pin, (candidate) => { candidate.source.repository = "other/ores-interfaces"; });
expectRejected(pin, (candidate) => { candidate.requiredRuntimeExports = ["node"]; });

process.stdout.write(`${JSON.stringify({
  schema: "ores.locks.shared-interfaces-verification/v1",
  status: "passed",
  repository: pin.repository,
  commit: checkoutRevision,
  sourceCommit: pin.source.commit,
  certificationValidatorCommit: pin.certification.validatorCommit,
  declarations: pin.expectedDeclarations.length,
  requiredRuntimeExports: pin.requiredRuntimeExports,
  negativeCanaries: 7,
}, null, 2)}\n`);
