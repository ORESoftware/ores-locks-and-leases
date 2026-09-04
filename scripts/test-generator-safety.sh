#!/bin/sh
# Prove that --commit derives both content and parentage from --base-ref while
# leaving a parked checkout untouched, and that reruns never overwrite a
# divergent existing branch.
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

echo "generator safety checks passed"
