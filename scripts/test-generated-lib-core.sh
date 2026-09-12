#!/usr/bin/env bash
# End-to-end preflight for the lib-core generators. This exercises the
# generated package exactly as a consumer repository will see it, with the
# current checkout standing in for zed-pkg's vendored source tree.
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
scratch=$(mktemp -d "${TMPDIR:-/tmp}/ores-locks-generated.XXXXXX")
cleanup() {
  if [ -d "$scratch" ]; then
    find "$scratch" -depth -delete
  fi
}
trap cleanup EXIT HUP INT TERM
vendor_parent="$scratch/locks/.vendor/.zed/oresoftware"
tjsv_commit=dfc28bfc000faba5a963f23c708171dfd5f8debf
tjsv_package="https://github.com/ORESoftware/typespec-json-schema-validator/archive/${tjsv_commit}.tar.gz"
generated_declarations='["Preflight.Locks.LockCatalog","Preflight.Locks.LockCatalogEntry","Preflight.Locks.LockDomain","Preflight.Locks.LockLayers","Preflight.Locks.PgScope"]'

# Reproduce a lib-core whose repository root is a virtual Cargo workspace.
# Without an explicit workspace in locks/langs/rust/Cargo.toml, Cargo rejects the
# generated package because it is nested below but absent from `members`.
printf '%s\n' \
  '[workspace]' \
  'resolver = "2"' \
  'members = []' \
  > "$scratch/Cargo.toml"

log() { printf '[generated-lib-core] %s\n' "$*"; }

log "scratch: $scratch"
python3 "$repo_root/templates/lib-core/gen_org_locks.py" \
  --repo "$scratch" \
  --org preflight-example \
  --prefix preflight \
  --interfaces preflight-interfaces
python3 "$repo_root/templates/lib-core/gen_org_fencing.py" \
  --repo "$scratch" \
  --org preflight-example \
  --prefix preflight

mkdir -p "$vendor_parent"
ln -s "$repo_root" "$vendor_parent/ores-locks-and-leases"

log "Zed manifests"
(
  cd "$repo_root"
  zed validate
)
(
  cd "$scratch"
  zed validate
  zed validate --manifest locks/.zpkg.toml
)

log "Generated fencing assets"
python3 -m json.tool \
  "$scratch/locks/persistence/fencing.config.json" >/dev/null
grep -q '^CREATE SCHEMA IF NOT EXISTS preflight_locks;' \
  "$scratch/locks/persistence/postgres/fencing.sql"
grep -q 'preflight-example-locks:{' \
  "$scratch/locks/persistence/redis/fenced-write.lua"
sh -n "$scratch/locks/persistence/redis/test-fenced-write.sh"
test "$(grep -c 'ores-locks-and-leases:fencing-assets:v1' "$scratch/locks/README.md")" -eq 1

log "Rust"
cargo test --manifest-path "$scratch/locks/langs/rust/Cargo.toml" --all-targets --features full

log "Go"
go -C "$scratch/locks/langs/golang" mod tidy
go -C "$scratch/locks/langs/golang" test ./...

log "TypeScript"
npm --prefix "$scratch/locks/langs/typescript" install --no-audit --no-fund
npm --prefix "$scratch/locks/langs/typescript" test

log "Dart"
(
  cd "$scratch/locks/langs/dart"
  dart pub get
  dart format --output=none --set-exit-if-changed lib test
  dart analyze --fatal-infos
  dart test
)

log "Gleam"
(
  cd "$scratch/locks/langs/gleam"
  gleam format --check src test
  gleam test
)

log "TypeSpec and JSON Schema peer authorities"
(
  cd "$scratch/locks"
  npx --yes \
    --package=https://github.com/ORESoftware/ores-contracts/archive/f79ea8d8d94d7a9e78c15f7e46ecae8e4b584d2e.tar.gz \
    ores-contracts check --config contracts/contracts.config.json

  mkdir -p target/tjsv/generated-consumer/generated-schema-b
  npx --yes --package="$tjsv_package" tjsv check \
    --typespec=contracts/typespec/main.tsp \
    --schema=contracts/json-schema/contract.schema.json \
    --report=target/tjsv/generated-consumer/report.json \
    --sarif=target/tjsv/generated-consumer/report.sarif \
    --contract-ir=target/tjsv/generated-consumer/contract-ir.json \
    --output-dir=target/tjsv/generated-consumer/generated-schema-b \
    --bundle-id=generated-consumer.typespec.generated.schema.json \
    --int64-strategy=number \
    --seal-object-schemas=true \
    --probes=true \
    --max-probes=128

  npx --yes --package="$tjsv_package" tjsv verify-ir \
    --contract-ir=target/tjsv/generated-consumer/contract-ir.json \
    --parity-receipt=target/tjsv/generated-consumer/report.json \
    --typespec=contracts/typespec/main.tsp \
    --generated-schema=target/tjsv/generated-consumer/generated-schema-b/generated-consumer.typespec.generated.schema.json \
    --schema=contracts/json-schema/contract.schema.json \
    --expected-declarations="$generated_declarations" \
    --verification=target/tjsv/generated-consumer/consumer-verification.json

  node - \
    target/tjsv/generated-consumer/report.json \
    target/tjsv/generated-consumer/contract-ir.json \
    target/tjsv/generated-consumer/consumer-verification.json \
    "$generated_declarations" <<'NODE'
import { readFileSync } from "node:fs";

const [reportPath, irPath, verificationPath, expectedJson] = process.argv.slice(2);
const report = JSON.parse(readFileSync(reportPath, "utf8"));
const contractIr = JSON.parse(readFileSync(irPath, "utf8"));
const verification = JSON.parse(readFileSync(verificationPath, "utf8"));
const digestPattern = /^[0-9a-f]{64}$/u;
const summary = report.differential?.summary;

function normalizedIds(value, label) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    throw new Error(`${label} is not a nonempty declaration list`);
  }
  const sorted = [...value].sort();
  if (new Set(sorted).size !== sorted.length) {
    throw new Error(`${label} contains duplicate declarations`);
  }
  return sorted;
}

const expected = normalizedIds(JSON.parse(expectedJson), "expected generated scope");

if (
  report.status !== "passed" ||
  report.zeroUnexplainedFindings !== true ||
  !digestPattern.test(report.runId ?? "") ||
  report.differential?.disabled === true ||
  summary === null ||
  typeof summary !== "object" ||
  summary.probesEvaluated <= 0 ||
  summary.divergences !== 0 ||
  summary.refusals !== 0
) {
  throw new Error("generated consumer contract did not pass TJSV differential admission");
}

const admitted = normalizedIds(
  contractIr.declarations?.map((entry) => entry.id),
  "generated Contract IR scope",
);
if (
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
  contractIr.admission?.scope?.complete !== true ||
  JSON.stringify(admitted) !== JSON.stringify(expected)
) {
  throw new Error("generated consumer Contract IR was not admitted over its exact declaration scope");
}

const verified = normalizedIds(
  verification.declarationIds,
  "generated consumer verification scope",
);
if (
  verification.status !== "passed" ||
  verification.admissible !== true ||
  !digestPattern.test(verification.verificationId ?? "") ||
  verification.suppliedIrId !== contractIr.irId ||
  verification.computedIrId !== contractIr.irId ||
  verification.expectedIrId !== contractIr.irId ||
  verification.receiptRunId !== report.runId ||
  verification.failureCode !== null ||
  JSON.stringify(verified) !== JSON.stringify(expected)
) {
  throw new Error("generated consumer canonical verify-ir receipt was not admissible");
}
NODE
)

log "all generated runtime, contract, and fencing-asset checks passed"
