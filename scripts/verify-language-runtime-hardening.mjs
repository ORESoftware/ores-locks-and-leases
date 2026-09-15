import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const VERIFICATION_SCHEMA =
  "ores.typespec-json-schema-validator.language-boundary-verification/v1";
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;

const expectedRevision = process.env.EXPECTED_SHA;
if (typeof expectedRevision !== "string" || !REVISION_PATTERN.test(expectedRevision)) {
  throw new Error("EXPECTED_SHA must be an exact lowercase 40-character commit SHA");
}

const installRoot = resolve(
  process.env.TJSV_INSTALL_ROOT ?? "target/tjsv-language-boundary-package",
);
const modulePath = resolve(
  installRoot,
  "node_modules/@oresoftware/typespec-json-schema-validator/src/language-boundary-verification.mjs",
);
const { verifyLanguageBoundaries } = await import(pathToFileURL(modulePath).href);

async function loadJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function assertStoppedForRule(label, verification, expectedRuleId) {
  if (
    verification.schema !== VERIFICATION_SCHEMA ||
    verification.status !== "stopped_for_evaluation" ||
    verification.zeroUnexplainedFindings !== false ||
    !verification.findings?.some((finding) => finding.ruleId === expectedRuleId)
  ) {
    const rules = verification.findings?.map((finding) => finding.ruleId).join(", ") ?? "none";
    throw new Error(
      `${label}: expected ${expectedRuleId}, observed status=${verification.status} rules=${rules}`,
    );
  }
}

async function loadEvidence(bundle, manifest) {
  const root = `target/contract-runtime-boundary/language-boundary/${bundle}`;
  const evidenceByPath = {};
  for (const target of manifest.targets) {
    evidenceByPath[target.evidence] = await loadJson(`${root}/${target.evidence}`);
  }
  return evidenceByPath;
}

async function verifyBundle(bundle) {
  const boundaryRoot = `target/contract-runtime-boundary/language-boundary/${bundle}`;
  const manifest = await loadJson(`${boundaryRoot}/manifest.json`);
  const report = await loadJson(`target/tjsv/${bundle}/report.json`);
  const contractIr = await loadJson(`target/tjsv/${bundle}/contract-ir.json`);
  const evidenceByPath = await loadEvidence(bundle, manifest);
  const firstPath = manifest.targets[0].evidence;

  const baseline = verifyLanguageBoundaries({ manifest, report, contractIr, evidenceByPath });
  if (
    baseline.schema !== VERIFICATION_SCHEMA ||
    baseline.status !== "passed" ||
    baseline.zeroUnexplainedFindings !== true ||
    baseline.counts?.findings !== 0
  ) {
    throw new Error(`${bundle}: baseline language/runtime boundary evidence must pass before hardening canaries`);
  }

  const results = [];
  const runNegative = ({
    name,
    expectedRuleId,
    mutateEvidence,
    mutateManifest,
    mutateReport,
    mutateContractIr,
  }) => {
    const candidateEvidence = structuredClone(evidenceByPath);
    const candidateManifest = structuredClone(manifest);
    const candidateReport = structuredClone(report);
    const candidateContractIr = structuredClone(contractIr);

    mutateEvidence?.(candidateEvidence);
    mutateManifest?.(candidateManifest);
    mutateReport?.(candidateReport);
    mutateContractIr?.(candidateContractIr);

    const rejected = verifyLanguageBoundaries({
      manifest: candidateManifest,
      report: candidateReport,
      contractIr: candidateContractIr,
      evidenceByPath: candidateEvidence,
    });
    assertStoppedForRule(`${bundle}/${name}`, rejected, expectedRuleId);
    results.push({
      name,
      expectedRuleId,
      verificationId: rejected.verificationId,
      findingCount: rejected.counts?.findings ?? null,
    });
  };

  const canaries = [
    {
      name: "parity-report-schema-drift",
      expectedRuleId: "boundary-parity-report-schema-invalid",
      mutateReport: (candidate) => { candidate.schema = "ores.invalid.report/v0"; },
    },
    {
      name: "parity-run-id-malformed",
      expectedRuleId: "boundary-parity-run-id-invalid",
      mutateReport: (candidate) => { candidate.runId = "not-a-sha256"; },
    },
    {
      name: "parity-report-failed",
      expectedRuleId: "boundary-parity-report-not-passed",
      mutateReport: (candidate) => { candidate.status = "failed"; },
    },
    {
      name: "differential-validation-disabled",
      expectedRuleId: "boundary-differential-validation-disabled",
      mutateReport: (candidate) => { candidate.differential = { ...candidate.differential, disabled: true }; },
    },
    {
      name: "contract-ir-schema-drift",
      expectedRuleId: "boundary-contract-ir-schema-invalid",
      mutateContractIr: (candidate) => { candidate.schema = "ores.invalid.contract-ir/v0"; },
    },
    {
      name: "contract-ir-id-malformed",
      expectedRuleId: "boundary-contract-ir-id-invalid",
      mutateContractIr: (candidate) => { candidate.irId = "not-a-sha256"; },
    },
    {
      name: "contract-ir-not-admissible",
      expectedRuleId: "boundary-contract-ir-not-admissible",
      mutateContractIr: (candidate) => { candidate.admissible = false; },
    },
    {
      name: "contract-ir-role-promoted",
      expectedRuleId: "boundary-contract-ir-role-invalid",
      mutateContractIr: (candidate) => { candidate.role = "editable-authority"; },
    },
    {
      name: "contract-ir-authority-transfer",
      expectedRuleId: "boundary-contract-ir-authorities-invalid",
      mutateContractIr: (candidate) => { candidate.authorities.typespec = "generated"; },
    },
    {
      name: "contract-ir-receipt-split",
      expectedRuleId: "boundary-contract-ir-receipt-mismatch",
      mutateContractIr: (candidate) => { candidate.admission.receipt.runId = "0".repeat(64); },
    },
    {
      name: "contract-ir-differential-requirement-missing",
      expectedRuleId: "boundary-contract-ir-differential-missing",
      mutateContractIr: (candidate) => {
        candidate.admission.requirements.differentialInstanceValidation = false;
      },
    },
    {
      name: "evidence-schema-drift",
      expectedRuleId: "boundary-evidence-schema-invalid",
      mutateEvidence: (candidate) => { candidate[firstPath].schema = "ores.invalid.boundary-evidence/v0"; },
    },
    {
      name: "evidence-target-language-drift",
      expectedRuleId: "boundary-evidence-target-mismatch",
      mutateEvidence: (candidate) => { candidate[firstPath].language = "python"; },
    },
    {
      name: "source-revision-malformed",
      expectedRuleId: "boundary-source-revision-invalid",
      mutateEvidence: (candidate) => { candidate[firstPath].sourceRevision = "HEAD"; },
    },
    {
      name: "toolchain-identity-missing",
      expectedRuleId: "boundary-toolchain-identity-missing",
      mutateEvidence: (candidate) => { candidate[firstPath].toolchain = null; },
    },
    {
      name: "generator-identity-missing",
      expectedRuleId: "boundary-generator-identity-missing",
      mutateEvidence: (candidate) => { candidate[firstPath].generator = null; },
    },
    {
      name: "evidence-receipt-id-malformed",
      expectedRuleId: "boundary-evidence-schema-invalid",
      mutateEvidence: (candidate) => { candidate[firstPath].receiptRunId = "invalid"; },
    },
    {
      name: "evidence-contract-ir-id-malformed",
      expectedRuleId: "boundary-evidence-schema-invalid",
      mutateEvidence: (candidate) => { candidate[firstPath].contractIrId = "invalid"; },
    },
    {
      name: "evidence-unknown-property",
      expectedRuleId: "boundary-evidence-schema-invalid",
      mutateEvidence: (candidate) => { candidate[firstPath].unreviewedAuthority = true; },
    },
    {
      name: "evidence-validation-envelope-open",
      expectedRuleId: "boundary-evidence-schema-invalid",
      mutateEvidence: (candidate) => { candidate[firstPath].validation.bypass = "passed"; },
    },
  ];

  for (const canary of canaries) runNegative(canary);
  if (results.length !== 20) {
    throw new Error(`${bundle}: expected exactly 20 extended negative canaries, got ${results.length}`);
  }

  const output = `target/contract-runtime-boundary/language-boundary/${bundle}/extended-negative-canaries.json`;
  await writeFile(
    output,
    `${JSON.stringify({
      schema: "ores.locks.language-runtime-hardening/v1",
      bundle,
      sourceRevision: expectedRevision,
      baselineVerificationId: baseline.verificationId,
      canaryCount: results.length,
      canaries: results,
      status: "passed",
    }, null, 2)}\n`,
  );
  process.stdout.write(`${bundle}: ${results.length} extended boundary tamper canaries rejected\n`);
  return results.length;
}

const counts = [];
for (const bundle of ["main", "renewal"]) counts.push(await verifyBundle(bundle));
if (counts.some((count) => count !== 20)) {
  throw new Error("extended language/runtime hardening did not execute the full canary inventory");
}
process.stdout.write(`extended boundary hardening: ${counts.reduce((sum, count) => sum + count, 0)} total rejections\n`);
