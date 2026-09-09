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
tjsv_commit=6bb5b7c1ee41c8b43741e50a264c33a1165549c4
tjsv_package="https://github.com/ORESoftware/typespec-json-schema-validator/archive/${tjsv_commit}.tar.gz"

# Reproduce a lib-core whose repository root is a virtual Cargo workspace.
# Without an explicit workspace in locks/rust/Cargo.toml, Cargo rejects the
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
cargo test --manifest-path "$scratch/locks/rust/Cargo.toml" --all-targets --features full

log "Go"
go -C "$scratch/locks/golang" mod tidy
go -C "$scratch/locks/golang" test ./...

log "TypeScript"
npm --prefix "$scratch/locks/typescript" install --no-audit --no-fund
npm --prefix "$scratch/locks/typescript" test

log "Dart"
(
  cd "$scratch/locks/dart"
  dart pub get
  dart format --output=none --set-exit-if-changed lib test
  dart analyze --fatal-infos
  dart test
)

log "Gleam"
(
  cd "$scratch/locks/gleam"
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
    --max-probes=128 \
    --quiet

  node - target/tjsv/generated-consumer/report.json <<'NODE'
import { readFileSync } from "node:fs";
const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
const summary = report.differential?.summary;
if (
  report.status !== "passed" ||
  report.zeroUnexplainedFindings !== true ||
  report.differential?.disabled === true ||
  summary === null ||
  typeof summary !== "object" ||
  summary.probesEvaluated <= 0 ||
  summary.divergences !== 0 ||
  summary.refusals !== 0
) {
  throw new Error("generated consumer contract did not pass TJSV differential admission");
}
NODE
)

log "all generated runtime, contract, and fencing-asset checks passed"
