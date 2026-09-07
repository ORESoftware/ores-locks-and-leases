#!/bin/sh
# Prove that --commit derives both content and parentage from --base-ref while
# leaving a parked checkout untouched, that reruns never overwrite a divergent
# existing branch, and that the companion fencing generator safely appends one
# deterministic commit to the DEN-backed generated branch.
set -eu

repo_root=$(cd "$(dirname "$0")/.." && pwd)
fixture=$(mktemp -d "${TMPDIR:-/tmp}/ores-locks-generator-safety.XXXXXX")
cleanup() {
  if [ -d "$fixture" ]; then
    find "$fixture" -depth -delete
  fi
}
trap cleanup EXIT HUP INT TERM

git -C "$fixture" init -q -b main
git -C "$fixture" config user.name "ores-locks generator test"
git -C "$fixture" config user.email "ores-locks-generator-test@example.invalid"
printf '%s\n' \
  '[package]' \
  'org = "fixture-org"' \
  'name = "fixture-lib-core"' \
  'version = "0.1.0"' \
  'description = "BASE_REF_MANIFEST"' \
  'license = "MIT"' \
  '' \
  '[dependencies]' \
  > "$fixture/.zpkg.toml"
git -C "$fixture" add .zpkg.toml
git -C "$fixture" commit -q -m "base"
base_commit=$(git -C "$fixture" rev-parse HEAD)

git -C "$fixture" switch -q -c parked-work
printf '%s\n' \
  '[package]' \
  'org = "fixture-org"' \
  'name = "fixture-lib-core"' \
  'version = "9.9.9"' \
  'description = "PARKED_BRANCH_MANIFEST"' \
  'license = "MIT"' \
  > "$fixture/.zpkg.toml"
git -C "$fixture" add .zpkg.toml
git -C "$fixture" commit -q -m "parked branch"
parked_commit=$(git -C "$fixture" rev-parse HEAD)

python3 "$repo_root/templates/lib-core/gen_org_locks.py" \
  --repo "$fixture" \
  --org fixture-org \
  --prefix fixture \
  --interfaces fixture-interfaces \
  --branch DEN-2050/ores-locks-and-leases \
  --base-ref main \
  --commit

generated_commit=$(git -C "$fixture" rev-parse DEN-2050/ores-locks-and-leases)
test "$(git -C "$fixture" rev-parse "$generated_commit^")" = "$base_commit"
git -C "$fixture" show "$generated_commit:.zpkg.toml" | grep -q 'BASE_REF_MANIFEST'
# Gleam's formatter sorts imports lexically. A generated module that sorts
# before gleeunit (as fixture_locks does) catches the fleet-name-dependent
# formatting failure that shorter preflight package names used to miss.
git -C "$fixture" show "$generated_commit:locks/gleam/test/fixture_locks_test.gleam" \
  | head -n 4 \
  | sort -c
# The nested Rust package must remain independent when a consumer's root
# Cargo.toml declares a workspace but does not list locks/rust as a member.
git -C "$fixture" show "$generated_commit:locks/rust/Cargo.toml" \
  | grep -q '^\[workspace\]$'
git -C "$fixture" show "$generated_commit:locks/rust/Cargo.toml" \
  | grep -q '^resolver = "3"$'
if git -C "$fixture" show "$generated_commit:.zpkg.toml" | grep -q 'PARKED_BRANCH_MANIFEST'; then
  echo "generated branch inherited the parked checkout instead of --base-ref" >&2
  exit 1
fi
test "$(git -C "$fixture" rev-parse HEAD)" = "$parked_commit"
test -z "$(git -C "$fixture" status --porcelain)"

# An identical rerun is idempotent and leaves the existing branch alone.
python3 "$repo_root/templates/lib-core/gen_org_locks.py" \
  --repo "$fixture" \
  --org fixture-org \
  --prefix fixture \
  --interfaces fixture-interfaces \
  --branch DEN-2050/ores-locks-and-leases \
  --base-ref main \
  --commit
test "$(git -C "$fixture" rev-parse DEN-2050/ores-locks-and-leases)" = "$generated_commit"

# Different generated content must never force-move the branch.
if python3 "$repo_root/templates/lib-core/gen_org_locks.py" \
  --repo "$fixture" \
  --org other-org \
  --prefix other \
  --interfaces other-interfaces \
  --branch DEN-2050/ores-locks-and-leases \
  --base-ref main \
  --commit >/dev/null 2>&1; then
  echo "generator overwrote a divergent existing branch" >&2
  exit 1
fi
test "$(git -C "$fixture" rev-parse DEN-2050/ores-locks-and-leases)" = "$generated_commit"
test "$(git -C "$fixture" rev-parse HEAD)" = "$parked_commit"
test -z "$(git -C "$fixture" status --porcelain)"

# The companion generator appends exactly one deterministic commit to the
# existing generated branch, still without touching the parked checkout.
python3 "$repo_root/templates/lib-core/gen_org_fencing.py" \
  --repo "$fixture" \
  --org fixture-org \
  --prefix fixture \
  --branch DEN-2050/ores-locks-and-leases \
  --base-ref main \
  --commit
fencing_commit=$(git -C "$fixture" rev-parse DEN-2050/ores-locks-and-leases)
test "$fencing_commit" != "$generated_commit"
test "$(git -C "$fixture" rev-parse "$fencing_commit^")" = "$generated_commit"
git -C "$fixture" show "$fencing_commit:locks/persistence/fencing.config.json" \
  | grep -q '"postgresSchema": "fixture_locks"'
git -C "$fixture" show "$fencing_commit:locks/persistence/postgres/fencing.sql" \
  | grep -q '^CREATE SCHEMA IF NOT EXISTS fixture_locks;'
git -C "$fixture" show "$fencing_commit:locks/persistence/redis/fenced-write.lua" \
  | grep -q 'fixture-org-locks:{'
test "$(git -C "$fixture" rev-parse HEAD)" = "$parked_commit"
test -z "$(git -C "$fixture" status --porcelain)"

# An identical companion rerun is idempotent.
python3 "$repo_root/templates/lib-core/gen_org_fencing.py" \
  --repo "$fixture" \
  --org fixture-org \
  --prefix fixture \
  --branch DEN-2050/ores-locks-and-leases \
  --base-ref main \
  --commit
test "$(git -C "$fixture" rev-parse DEN-2050/ores-locks-and-leases)" = "$fencing_commit"

# Once metadata exists, a mismatched org/prefix can never overwrite it.
if python3 "$repo_root/templates/lib-core/gen_org_fencing.py" \
  --repo "$fixture" \
  --org other-org \
  --prefix other \
  --branch DEN-2050/ores-locks-and-leases \
  --base-ref main \
  --commit >/dev/null 2>&1; then
  echo "fencing generator overwrote assets for another org" >&2
  exit 1
fi
test "$(git -C "$fixture" rev-parse DEN-2050/ores-locks-and-leases)" = "$fencing_commit"
test "$(git -C "$fixture" rev-parse HEAD)" = "$parked_commit"
test -z "$(git -C "$fixture" status --porcelain)"

echo "generator safety checks passed"
