#!/bin/sh
# Fail-closed TypeSpec <-> JSON Schema parity for both independently authored
# contract bundles. TJSV generates Schema B as comparison evidence only; it
# never replaces either authored authority.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
validator_commit=6bb5b7c1ee41c8b43741e50a264c33a1165549c4
validator_package="https://github.com/ORESoftware/typespec-json-schema-validator/archive/${validator_commit}.tar.gz"

check_bundle() {
  name=$1
  typespec=$2
  schema=$3
  output="$root/target/tjsv/$name"

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
  node - "$output/report.json" "$name" <<'NODE'
import { readFileSync } from "node:fs";

const [reportPath, bundle] = process.argv.slice(2);
const report = JSON.parse(readFileSync(reportPath, "utf8"));
if (report.schema !== "ores.typespec-json-schema-validator.report/v1") {
  throw new Error(`${bundle}: unexpected TJSV report schema`);
}
if (report.status !== "passed" || report.zeroUnexplainedFindings !== true) {
  throw new Error(`${bundle}: TJSV did not prove zero unexplained findings`);
}
if (typeof report.runId !== "string" || !/^[0-9a-f]{64}$/u.test(report.runId)) {
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
process.stdout.write(`${bundle}: TJSV passed as ${report.runId}\n`);
NODE
}

case "${1:-all}" in
  main)
    check_bundle \
      main \
      contracts/typespec/main.tsp \
      contracts/json-schema/contract.schema.json
    ;;
  renewal)
    check_bundle \
      renewal \
      contracts/renewal/typespec/main.tsp \
      contracts/renewal/json-schema/contract.schema.json
    ;;
  all)
    check_bundle \
      main \
      contracts/typespec/main.tsp \
      contracts/json-schema/contract.schema.json
    check_bundle \
      renewal \
      contracts/renewal/typespec/main.tsp \
      contracts/renewal/json-schema/contract.schema.json
    ;;
  *)
    printf 'usage: %s [main|renewal|all]\n' "$0" >&2
    exit 64
    ;;
esac
