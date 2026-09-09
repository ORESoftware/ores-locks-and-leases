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

const expectedRevision = requireSha("EXPECTED_SHA", process.env.EXPECTED_SHA);
const checkedOutRevision = requireSha(
  "checked-out revision",
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
);
const exactHead = expectedRevision === checkedOutRevision;

const required = {
  corpus: process.env.CORPUS_OUTCOME,
  rust: process.env.RUST_OUTCOME,
  go: process.env.GO_OUTCOME,
  typescript: process.env.TYPESCRIPT_OUTCOME,
  dart: process.env.DART_OUTCOME,
  gleam: process.env.GLEAM_OUTCOME,
  contracts: process.env.CONTRACTS_OUTCOME,
};

let tjsv;
try {
  const reportBytes = await readFile("target/tjsv/renewal/report.json");
  const contractIrBytes = await readFile("target/tjsv/renewal/contract-ir.json");
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
  tjsv = {
    status: passed ? "passed" : "stopped_for_evaluation",
    runId: typeof report.runId === "string" ? report.runId : null,
    reportSha256: createHash("sha256").update(reportBytes).digest("hex"),
    contractIrSha256: createHash("sha256").update(contractIrBytes).digest("hex"),
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
  tjsv = {
    status: "missing_or_invalid",
    runId: null,
    reportSha256: null,
    contractIrSha256: null,
    differential: null,
  };
}

const discrepancies = Object.entries(required)
  .filter(([, outcome]) => outcome !== "success")
  .map(([name, outcome]) => ({ name, outcome: outcome ?? "missing" }));
if (!exactHead) {
  discrepancies.push({
    name: "exact_head",
    outcome: `${checkedOutRevision} != ${expectedRevision}`,
  });
}
if (tjsv.status !== "passed") {
  discrepancies.push({ name: "tjsv.renewal", outcome: tjsv.status });
}

const passed = discrepancies.length === 0;
const receipt = {
  schema: "ores.locks.renewal-supervisor-receipt/v1",
  repository: process.env.GITHUB_REPOSITORY,
  revision: expectedRevision,
  checkedOutRevision,
  workflowRevision: process.env.GITHUB_SHA ?? null,
  exactHead,
  runId: process.env.GITHUB_RUN_ID,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  contractAuthorities: {
    precedence: "none",
    typespec: "contracts/renewal/typespec/main.tsp",
    jsonSchema: "contracts/renewal/json-schema/contract.schema.json",
    generatedSchemaRole: "comparison_evidence_only",
    validator: {
      repository: "ORESoftware/typespec-json-schema-validator",
      commit: TJSV_COMMIT,
      command: "tjsv check",
      evidence: tjsv,
    },
  },
  conformanceCorpus: "conformance/cases/renewal-decision.json",
  requiredChecks: required,
  discrepancies,
  zeroUnexplainedMismatches: passed,
  status: passed ? "passed" : "stopped_for_evaluation",
};
await mkdir("target/renewal-supervisor", { recursive: true });
await writeFile(
  "target/renewal-supervisor/receipt.json",
  `${JSON.stringify(receipt, null, 2)}\n`,
);
if (!passed) process.exitCode = 1;
