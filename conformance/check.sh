#!/bin/sh
set -eu
root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$root"

fail(){ echo "[ores-locks-and-leases conformance] $*" >&2; exit 1; }
for boundary in contracts conformance; do
  [ -d "$boundary" ] && [ ! -L "$boundary" ] || fail "$boundary/ must be a real non-symlink directory"
done
escaped=$(find contracts conformance -type l -print -quit 2>/dev/null || true)
[ -z "$escaped" ] || fail "symlink inside contract/conformance boundary: $escaped"
command -v zed >/dev/null 2>&1 || fail "zed is required so contract tooling is package-graph resolved"

# Prove the declared Zed TJSV dependency is executable before entering the
# repository's mature parity/runtime harness. That harness retains its exact
# reviewed TJSV revision and declaration-scope verification.
zed run tjsv doctor --quiet
sh scripts/test-all.sh
