#!/bin/sh
# Optional additive projection admission for Protobuf, WIT, and Dafny.
#
# These lanes are intentionally optional: an absent lane is not an error. Once
# a lane directory exists, however, it must contain its language artifact plus
# a TJSV projection manifest and policy, and verification is fail-closed against
# the exact current TypeSpec + authored JSON Schema + generated witness + IR.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"

validator_commit=${TJSV_COMMIT:-b2c4810400625829114a56087ad33937caac735a}
validator_package="https://github.com/ORESoftware/typespec-json-schema-validator/archive/${validator_commit}.tar.gz"

# Additive contract artifacts must live under the projection-admission tree so
# they cannot accidentally bypass digest-bound TJSV admission.
for ext in proto wit dfy; do
  unexpected=$(find contracts -type f -name "*.$ext" ! -path 'contracts/projections/*' -print -quit)
  if [ -n "$unexpected" ]; then
    printf 'optional contract artifact must live under contracts/projections: %s\n' "$unexpected" >&2
    exit 2
  fi
done

bundle_paths() {
  case "$1" in
    main)
      printf '%s\n' 'contracts/typespec/main.tsp|contracts/json-schema/contract.schema.json'
      ;;
    renewal)
      printf '%s\n' 'contracts/renewal/typespec/main.tsp|contracts/renewal/json-schema/contract.schema.json'
      ;;
    local)
      printf '%s\n' 'contracts/local-file/typespec/main.tsp|contracts/local-file/json-schema/contract.schema.json'
      ;;
    *)
      return 64
      ;;
  esac
}

check_lane() {
  bundle=$1
  lane=$2
  ext=$3
  lane_dir="contracts/projections/$bundle/$lane"

  if [ ! -d "$lane_dir" ]; then
    printf '%s/%s: optional lane absent; skipped\n' "$bundle" "$lane"
    return 0
  fi

  artifact=$(find "$lane_dir" -type f -name "*.$ext" -print -quit)
  if [ -z "$artifact" ]; then
    printf '%s/%s: lane exists but has no .%s artifact\n' "$bundle" "$lane" "$ext" >&2
    return 2
  fi

  manifest="$lane_dir/projection-manifest.json"
  policy="$lane_dir/projection-policy.json"
  test -s "$manifest" || {
    printf '%s/%s: missing projection-manifest.json\n' "$bundle" "$lane" >&2
    return 2
  }
  test -s "$policy" || {
    printf '%s/%s: missing projection-policy.json\n' "$bundle" "$lane" >&2
    return 2
  }

  paths=$(bundle_paths "$bundle")
  typespec=${paths%%|*}
  schema=${paths#*|}
  evidence="target/tjsv/$bundle"
  generated="$evidence/generated-schema-b/${bundle}.typespec.generated.schema.json"
  verification="$evidence/projections/${lane}-verification.json"

  test -s "$evidence/contract-ir.json"
  test -s "$evidence/report.json"
  test -s "$generated"
  mkdir -p "$(dirname "$verification")"

  npx --yes --package="$validator_package" tjsv verify-projection \
    --root=. \
    --projection-manifest="$manifest" \
    --contract-ir="$evidence/contract-ir.json" \
    --parity-receipt="$evidence/report.json" \
    --typespec="$typespec" \
    --generated-schema="$generated" \
    --schema="$schema" \
    --policy="$policy" \
    --verification="$verification" \
    --quiet

  test -s "$verification"
  printf '%s/%s: TJSV projection admission passed (%s)\n' "$bundle" "$lane" "$artifact"
}

for bundle in main renewal local; do
  check_lane "$bundle" protobuf proto
  check_lane "$bundle" wit wit
  check_lane "$bundle" dafny dfy
done
