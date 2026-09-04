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
  run rust sh -c "cd '$root/src/rust' && cargo test --all-targets --features full"
else echo "== rust: skipped (no cargo)"; fi

if command -v go >/dev/null 2>&1; then
  run go sh -c "cd '$root/src/go' && go vet ./... && go test ./..."
else echo "== go: skipped (no go)"; fi

if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  run typescript sh -c "cd '$root/src/ts' && npm install --no-audit --no-fund && npm test"
else echo "== typescript: skipped (no node/npm)"; fi

if command -v dart >/dev/null 2>&1; then
  run dart sh -c "cd '$root/src/dart' && dart pub get && dart analyze --fatal-infos && dart test"
else echo "== dart: skipped (no dart)"; fi

if command -v gleam >/dev/null 2>&1; then
  run gleam sh -c "cd '$root/src/gleam' && gleam test"
else echo "== gleam: skipped (no gleam)"; fi

exit $status
