import { mkdir, writeFile } from "node:fs/promises";

const required = {
  corpus: process.env.CORPUS_OUTCOME,
  rust: process.env.RUST_OUTCOME,
  go: process.env.GO_OUTCOME,
  typescript: process.env.TYPESCRIPT_OUTCOME,
  dart: process.env.DART_OUTCOME,
  gleam: process.env.GLEAM_OUTCOME,
  contracts: process.env.CONTRACTS_OUTCOME,
};
const failures = Object.entries(required)
  .filter(([, outcome]) => outcome !== "success")
  .map(([name, outcome]) => ({ name, outcome: outcome ?? "missing" }));
const passed = failures.length === 0;
const receipt = {
  schema: "ores.locks.renewal-supervisor-receipt/v1",
  repository: process.env.GITHUB_REPOSITORY,
  revision: process.env.GITHUB_SHA,
  runId: process.env.GITHUB_RUN_ID,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  contractAuthorities: {
    precedence: "none",
    typespec: "contracts/renewal/typespec/main.tsp",
    jsonSchema: "contracts/renewal/json-schema/contract.schema.json",
  },
  conformanceCorpus: "conformance/cases/renewal-decision.json",
  requiredChecks: required,
  discrepancies: failures,
  zeroUnexplainedMismatches: passed,
  status: passed ? "passed" : "stopped_for_evaluation",
};
await mkdir("target/renewal-supervisor", { recursive: true });
await writeFile(
  "target/renewal-supervisor/receipt.json",
  JSON.stringify(receipt, null, 2) + "\n",
);
if (!passed) process.exitCode = 1;
