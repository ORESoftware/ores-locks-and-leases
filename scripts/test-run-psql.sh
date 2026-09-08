#!/usr/bin/env sh
# Prove the PostgreSQL URL launcher maps credentials into libpq's environment
# without forwarding the source URL or secrets in psql's argument vector.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if ! command -v node >/dev/null 2>&1; then
  echo "node is required" >&2
  exit 2
fi

scratch=$(mktemp -d "${TMPDIR:-/tmp}/ores-psql-launcher.XXXXXX")
cleanup() {
  find "$scratch" -depth -delete >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

cat >"$scratch/psql" <<'FAKE_PSQL'
#!/usr/bin/env sh
set -eu

test "${PGHOST:-}" = db.example.test
test "${PGPORT:-}" = 6543
test "${PGUSER:-}" = 'user name'
test "${PGPASSWORD:-}" = 'p@ss'
test "${PGDATABASE:-}" = 'locks db'
test "${PGSSLMODE:-}" = require
test "${PGCONNECT_TIMEOUT:-}" = 7
test "${PGAPPNAME:-}" = ores-locks
test -z "${PGHOSTADDR:-}"
test -z "${PGSERVICE:-}"
test -z "${PGSERVICEFILE:-}"
test -z "${PGPASSFILE:-}"
test -z "${PGOPTIONS:-}"
test -z "${ORES_LOCKS_TEST_DATABASE_URL:-}"
test "$#" -eq 4
test "$1" = -v
test "$2" = ON_ERROR_STOP=1
test "$3" = -c
test "$4" = 'SELECT 1'
printf 'passed\n' >"$ORES_PSQL_TEST_RECEIPT"
FAKE_PSQL
chmod +x "$scratch/psql"

url='postgresql://user%20name:p%40ss@db.example.test:6543/locks%20db?sslmode=require&connect_timeout=7&application_name=ores-locks'
PATH="$scratch:$PATH" \
PGHOST=stale.example.test \
PGHOSTADDR=192.0.2.10 \
PGPORT=9999 \
PGUSER=stale \
PGPASSWORD=stale \
PGDATABASE=stale \
PGSERVICE=stale \
PGSERVICEFILE=/tmp/stale-service \
PGPASSFILE=/tmp/stale-passfile \
PGOPTIONS='-c search_path=forged' \
PGSSLMODE=disable \
PGCONNECT_TIMEOUT=99 \
ORES_PSQL_TEST_RECEIPT="$scratch/receipt" \
ORES_LOCKS_TEST_DATABASE_URL="$url" \
  node "$root/scripts/run-psql.mjs" -v ON_ERROR_STOP=1 -c 'SELECT 1'
test "$(cat "$scratch/receipt")" = passed

expect_failure() {
  name=$1
  candidate=$2
  expected=$3
  if PATH="$scratch:$PATH" \
    ORES_LOCKS_TEST_DATABASE_URL="$candidate" \
    node "$root/scripts/run-psql.mjs" --version \
      >"$scratch/$name.stdout" 2>"$scratch/$name.stderr"; then
    echo "$name unexpectedly succeeded" >&2
    exit 1
  fi
  grep -Fq "$expected" "$scratch/$name.stderr"
  if grep -Fq 'p@ss' "$scratch/$name.stderr" \
    || grep -Fq 'p%40ss' "$scratch/$name.stderr"; then
    echo "$name leaked a password" >&2
    exit 1
  fi
}

expect_failure wrong-scheme \
  'https://user:p%40ss@db.example.test/locks' \
  'must use postgres:// or postgresql://'
expect_failure duplicate-parameter \
  'postgres://user:p%40ss@db.example.test/locks?sslmode=require&sslmode=disable' \
  'duplicate PostgreSQL URL parameter: sslmode'
expect_failure unsupported-parameter \
  'postgres://user:p%40ss@db.example.test/locks?password=shadow' \
  'unsupported PostgreSQL URL parameter: password'
expect_failure fragment \
  'postgres://user:p%40ss@db.example.test/locks#fragment' \
  'must not include a fragment'

if (
  unset ORES_LOCKS_TEST_DATABASE_URL
  PATH="$scratch:$PATH" node "$root/scripts/run-psql.mjs" --version
) >"$scratch/missing.stdout" 2>"$scratch/missing.stderr"; then
  echo "missing URL unexpectedly succeeded" >&2
  exit 1
fi
grep -Fq 'ORES_LOCKS_TEST_DATABASE_URL is required' "$scratch/missing.stderr"

echo "credential-safe psql launcher checks passed"
