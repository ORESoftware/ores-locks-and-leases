import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const RUN_ID_PATTERN = /^[0-9a-f]{64}$/u;
const TJSV_COMMIT = "6bb5b7c1ee41c8b43741e50a264c33a1165549c4";

function requireSha(name, value) {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) {
    throw new Error(`${name} must be a lowercase 40-character commit SHA`);
  }
  return value;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function loadBundle(name) {
  const reportPath = `target/tjsv/${name}/report.json`;
  const contractIrPath = `target/tjsv/${name}/contract-ir.json`;
  try {
    const [reportBytes, contractIrBytes] = await Promise.all([
      readFile(reportPath),
      readFile(contractIrPath),
    ]);
    const report = JSON.parse(reportBytes.toString("utf8"));
    const differential = report.differential?.summary;
    const passed =
      report.schema === "ores.typespec-json-schema-validator.report/v1" &&
      report.status === "passed" &&
      report.zeroUnexplainedFindings === true &&
      typeof report.runId === "string" &&
      RUN_ID_PATTERN.test(report.runId) &&
      report.differential?.disabled !== true &&
      differential !== null &&
      typeof differential === "object" &&
      differential.probesEvaluated > 0 &&
      differential.divergences === 0 &&
      differential.refusals === 0;
    return {
      name,
      status: passed ? "passed" : "stopped_for_evaluation",
      runId: typeof report.runId === "string" ? report.runId : null,
      reportSha256: digest(reportBytes),
      contractIrSha256: digest(contractIrBytes),
      differential: differential && typeof differential === "object"
        ? {
            probesEvaluated: differential.probesEvaluated ?? null,
            agreements: differential.agreements ?? null,
            divergences: differential.divergences ?? null,
            refusals: differential.refusals ?? null,
          }
        : null,
    };
  } catch {
    return {
      name,
      status: "missing_or_invalid",
      runId: null,
      reportSha256: null,
      contractIrSha256: null,
      differential: null,
    };
  }
}

const expectedRevision = requireSha("EXPECTED_SHA", process.env.EXPECTED_SHA);
const checkedOutRevision = requireSha(
  "checked-out revision",
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
);
const exactHead = expectedRevision === checkedOutRevision;

const requiredChecks = {
  rust: process.env.RUST_OUTCOME,
  rustsec: process.env.RUSTSEC_OUTCOME,
  go: process.env.GO_OUTCOME,
  typescript: process.env.TYPESCRIPT_OUTCOME,
  dart: process.env.DART_OUTCOME,
  gleam: process.env.GLEAM_OUTCOME,
  contracts: process.env.CONTRACTS_OUTCOME,
  generatedConsumer: process.env.GENERATED_CONSUMER_OUTCOME,
};

const bundles = await Promise.all([loadBundle("main"), loadBundle("renewal")]);
const discrepancies = [];
if (!exactHead) {
  discrepancies.push({
    name: "exact_head",
    outcome: `${checkedOutRevision} != ${expectedRevision}`,
  });
}
for (const [name, outcome] of Object.entries(requiredChecks)) {
  if (outcome !== "success") {
    discrepancies.push({ name, outcome: outcome ?? "missing" });
  }
}
for (const bundle of bundles) {
  if (bundle.status !== "passed") {
    discrepancies.push({
      name: `tjsv.${bundle.name}`,
      outcome: bundle.status,
    });
  }
}

const passed = discrepancies.length === 0;
const receipt = {
  schema: "ores.locks.contract-runtime-boundary-receipt/v1",
  repository: process.env.GITHUB_REPOSITORY,
  revision: expectedRevision,
  checkedOutRevision,
  workflowRevision: process.env.GITHUB_SHA ?? null,
  exactHead,
  runId: process.env.GITHUB_RUN_ID ?? null,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  contractAuthorities: {
    precedence: "none",
    typespec: [
      "contracts/typespec/main.tsp",
      "contracts/renewal/typespec/main.tsp",
    ],
    jsonSchema: [
      "contracts/json-schema/contract.schema.json",
      "contracts/renewal/json-schema/contract.schema.json",
    ],
    generatedSchemaRole: "comparison_evidence_only",
  },
  validator: {
    repository: "ORESoftware/typespec-json-schema-validator",
    commit: TJSV_COMMIT,
    command: "tjsv check",
    bundles,
  },
  runtimeBoundary: {
    requiredChecks,
    languages: ["rust", "go", "typescript", "dart", "gleam"],
    generatedConsumerRequired: true,
  },
  discrepancies,
  zeroUnexplainedMismatches: passed,
  status: passed ? "passed" : "stopped_for_evaluation",
};

await mkdir("target/contract-runtime-boundary", { recursive: true });
await writeFile(
  "target/contract-runtime-boundary/receipt.json",
  `${JSON.stringify(receipt, null, 2)}\n`,
);
if (!passed) process.exitCode = 1;
