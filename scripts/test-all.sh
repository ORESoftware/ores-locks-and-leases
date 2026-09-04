#!/bin/sh
# Run every slice's tests that the local toolchain can run. A missing
# toolchain skips that slice with a note rather than failing, so the script is
# usable on a laptop with only some of the languages installed; CI installs
# all of them and runs each job separately (.github/workflows/ci.yml).
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
status=0

run() {
  name=$1; shift
  echo "== $name"
  if "$@"; then echo "== $name: ok"; else echo "== $name: FAILED"; status=1; fi
}

if command -v cargo >/dev/null 2>&1; then
  run rust sh -c "cd '$root/src/rust' && cargo fmt --all -- --check && cargo check --locked --no-default-features && cargo clippy --locked --all-targets --features full -- -D warnings && cargo test --locked --all-targets --features full"
  if cargo audit --version >/dev/null 2>&1; then
    run rustsec sh -c "cd '$root/src/rust' && cargo audit --file Cargo.lock"
  else echo "== rustsec: skipped (no cargo-audit)"; fi
else echo "== rust: skipped (no cargo)"; fi

if command -v go >/dev/null 2>&1; then
  run go sh -c "cd '$root/src/go' && go vet ./... && go test ./..."
else echo "== go: skipped (no go)"; fi

if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  run typescript sh -c "cd '$root/src/ts' && npm ci --no-audit --no-fund && npm test"
  run contracts npx --yes --package=https://github.com/ORESoftware/ores-contracts/archive/f79ea8d8d94d7a9e78c15f7e46ecae8e4b584d2e.tar.gz ores-contracts check --config "$root/contracts/contracts.config.json"
else echo "== typescript: skipped (no node/npm)"; fi

if command -v dart >/dev/null 2>&1; then
  run dart sh -c "cd '$root/src/dart' && dart pub get --enforce-lockfile && dart format --output=none --set-exit-if-changed lib test && dart analyze --fatal-infos && dart test"
else echo "== dart: skipped (no dart)"; fi

if command -v gleam >/dev/null 2>&1; then
  run gleam sh -c "cd '$root/src/gleam' && gleam format --check src test && gleam test"
else echo "== gleam: skipped (no gleam)"; fi

if command -v python3 >/dev/null 2>&1 && command -v bash >/dev/null 2>&1; then
  run rollout-tools sh -c "bash -n '$root/templates/lib-core/fanout.sh' && python3 -c 'compile(open(\"$root/templates/lib-core/gen_org_locks.py\", encoding=\"utf-8\").read(), \"gen_org_locks.py\", \"exec\")' && ! '$root/templates/lib-core/fanout.sh' --no-push >/dev/null 2>&1 && ! python3 '$root/templates/lib-core/gen_org_locks.py' --repo '$root' --org ORESoftware --prefix ores --interfaces ores-interfaces --commit --branch feat/no-linear-id >/dev/null 2>&1"
else echo "== rollout-tools: skipped (no python3/bash)"; fi

exit $status
