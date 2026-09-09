#!/bin/sh
# Fail-closed TypeSpec <-> JSON Schema parity for both independently authored
# contract bundles. TJSV generates Schema B as comparison evidence only; it
# never replaces either authored authority. Each freshly emitted Contract IR is
# then canonically re-verified against the retained receipt, current source
# closure, generated witness, and one explicit complete consumer scope.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
validator_commit=6bb5b7c1ee41c8b43741e50a264c33a1165549c4
validator_package="https://github.com/ORESoftware/typespec-json-schema-validator/archive/${validator_commit}.tar.gz"

main_declarations='["Ores.LocksAndLeases.AcquireOptions","Ores.LocksAndLeases.AdvisoryKey","Ores.LocksAndLeases.FenceDecision","Ores.LocksAndLeases.FenceDecisionKind","Ores.LocksAndLeases.FencedWriteRequest","Ores.LocksAndLeases.FenceWatermark","Ores.LocksAndLeases.FencingToken","Ores.LocksAndLeases.FencingTokenText","Ores.LocksAndLeases.LeaseGrant","Ores.LocksAndLeases.LeaseMaintenanceOptions","Ores.LocksAndLeases.LockError","Ores.LocksAndLeases.LockErrorKind","Ores.LocksAndLeases.LockKey","Ores.LocksAndLeases.LockLayers","Ores.LocksAndLeases.LockPlan","Ores.LocksAndLeases.LockStep","Ores.LocksAndLeases.PgScope"]'
renewal_declarations='["Ores.LocksAndLeases.Renewal.FencingToken","Ores.LocksAndLeases.Renewal.LogicalMilliseconds","Ores.LocksAndLeases.Renewal.RenewalDecision","Ores.LocksAndLeases.Renewal.RenewalDecisionKind","Ores.LocksAndLeases.Renewal.RenewalGrantIdentity","Ores.LocksAndLeases.Renewal.RenewalLossReason","Ores.LocksAndLeases.Renewal.RenewalPolicy","Ores.LocksAndLeases.Renewal.RenewalSnapshot","Ores.LocksAndLeases.Renewal.RenewalTtlMilliseconds"]'

check_bundle() {
  name=$1
  typespec=$2
  schema=$3
  expected_declarations=$4
  output="$root/target/tjsv/$name"
  generated="$output/generated-schema-b/${name}.typespec.generated.schema.json"

  rm -rf -- "$output"
  mkdir -p -- "$output/generated-schema-b"

  npx --yes --package="$validator_package" tjsv check \
    --typespec="$root/$typespec" \
    --schema="$root/$schema" \
    --report="$output/report.json" \
    --sarif="$output/report.sarif" \
    --contract-ir="$output/contract-ir.json" \
    --output-dir="$output/generated-schema-b" \
    --bundle-id="${name}.typespec.generated.schema.json" \
    --int64-strategy=number \
    --seal-object-schemas=true \
    --polymorphic-models-strategy=oneOf \
    --probes=true \
    --max-probes=128 \
    --quiet

  test -s "$output/report.json"
  test -s "$output/contract-ir.json"
  test -s "$generated"

  npx --yes --package="$validator_package" tjsv verify-ir \
    --contract-ir="$output/contract-ir.json" \
    --parity-receipt="$output/report.json" \
    --typespec="$root/$typespec" \
    --generated-schema="$generated" \
    --schema="$root/$schema" \
    --expected-declarations="$expected_declarations" \
    --verification="$output/consumer-verification.json" \
    --quiet

  test -s "$output/consumer-verification.json"
  node - \
    "$output/report.json" \
    "$output/contract-ir.json" \
    "$output/consumer-verification.json" \
    "$expected_declarations" \
    "$name" <<'NODE'
import { readFileSync } from "node:fs";

const [reportPath, irPath, verificationPath, expectedJson, bundle] = process.argv.slice(2);
const report = JSON.parse(readFileSync(reportPath, "utf8"));
const contractIr = JSON.parse(readFileSync(irPath, "utf8"));
const verification = JSON.parse(readFileSync(verificationPath, "utf8"));
const expected = JSON.parse(expectedJson);
const digestPattern = /^[0-9a-f]{64}$/u;

if (report.schema !== "ores.typespec-json-schema-validator.report/v1") {
  throw new Error(`${bundle}: unexpected TJSV report schema`);
}
if (report.status !== "passed" || report.zeroUnexplainedFindings !== true) {
  throw new Error(`${bundle}: TJSV did not prove zero unexplained findings`);
}
if (typeof report.runId !== "string" || !digestPattern.test(report.runId)) {
  throw new Error(`${bundle}: TJSV receipt is missing a deterministic runId`);
}
const summary = report.differential?.summary;
if (
  report.differential?.disabled === true ||
  summary === null ||
  typeof summary !== "object" ||
  summary.probesEvaluated <= 0 ||
  summary.divergences !== 0 ||
  summary.refusals !== 0
) {
  throw new Error(`${bundle}: differential validation evidence is incomplete`);
}

if (
  contractIr.schema !== "ores.typespec-json-schema-validator.contract-ir/v1" ||
  contractIr.status !== "passed" ||
  contractIr.admissible !== true ||
  contractIr.role !== "downstream-derived-parity-artifact" ||
  contractIr.editableAuthority !== false ||
  !digestPattern.test(contractIr.irId ?? "") ||
  contractIr.authorities?.typespec !== "independently-authored" ||
  contractIr.authorities?.jsonSchema !== "independently-authored" ||
  contractIr.authorities?.generatedJsonSchema !== "comparison-evidence-only" ||
  contractIr.authorities?.precedence !== "none" ||
  contractIr.admission?.receipt?.runId !== report.runId ||
  contractIr.admission?.receipt?.status !== "passed" ||
  contractIr.admission?.receipt?.zeroUnexplainedFindings !== true ||
  contractIr.admission?.scope?.complete !== true
) {
  throw new Error(`${bundle}: Contract IR is not admissible or receipt-bound`);
}

const admitted = contractIr.declarations?.map((entry) => entry.id) ?? [];
if (JSON.stringify(admitted) !== JSON.stringify(expected)) {
  throw new Error(`${bundle}: Contract IR declaration scope drifted`);
}
if (
  verification.schema !== "ores.typespec-json-schema-validator.consumer-verification-receipt/v1" ||
  verification.status !== "passed" ||
  verification.admissible !== true ||
  !digestPattern.test(verification.verificationId ?? "") ||
  verification.suppliedIrId !== contractIr.irId ||
  verification.computedIrId !== contractIr.irId ||
  verification.expectedIrId !== contractIr.irId ||
  verification.receiptRunId !== report.runId ||
  verification.failureCode !== null ||
  JSON.stringify(verification.declarationIds) !== JSON.stringify(expected)
) {
  throw new Error(`${bundle}: canonical verify-ir admission is incomplete`);
}

process.stdout.write(
  `${bundle}: TJSV ${report.runId}; IR ${contractIr.irId}; verification ${verification.verificationId}\n`,
);
NODE
}

case "${1:-all}" in
  main)
    check_bundle \
      main \
      contracts/typespec/main.tsp \
      contracts/json-schema/contract.schema.json \
      "$main_declarations"
    ;;
  renewal)
    check_bundle \
      renewal \
      contracts/renewal/typespec/main.tsp \
      contracts/renewal/json-schema/contract.schema.json \
      "$renewal_declarations"
    ;;
  all)
    check_bundle \
      main \
      contracts/typespec/main.tsp \
      contracts/json-schema/contract.schema.json \
      "$main_declarations"
    check_bundle \
      renewal \
      contracts/renewal/typespec/main.tsp \
      contracts/renewal/json-schema/contract.schema.json \
      "$renewal_declarations"
    ;;
  *)
    printf 'usage: %s [main|renewal|all]\n' "$0" >&2
    exit 64
    ;;
esac
