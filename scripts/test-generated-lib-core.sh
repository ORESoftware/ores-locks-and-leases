#!/usr/bin/env bash
# End-to-end preflight for templates/lib-core/gen_org_locks.py. This exercises
# the generated package exactly as a consumer repository will see it, with the
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
vendor_parent="$scratch/.vendor/.zed/ORESoftware"

log() { printf '[generated-lib-core] %s\n' "$*"; }

log "scratch: $scratch"
python3 "$repo_root/templates/lib-core/gen_org_locks.py" \
  --repo "$scratch" \
  --org preflight-example \
  --prefix preflight \
  --interfaces preflight-interfaces

mkdir -p "$vendor_parent"
ln -s "$repo_root" "$vendor_parent/ores-locks-and-leases"

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

log "TypeSpec and JSON Schema"
(
  cd "$scratch/locks"
  npx --yes \
    --package=https://github.com/ORESoftware/ores-contracts/archive/f79ea8d8d94d7a9e78c15f7e46ecae8e4b584d2e.tar.gz \
    ores-contracts check --config contracts/contracts.config.json
)

log "all generated runtime and contract checks passed"
