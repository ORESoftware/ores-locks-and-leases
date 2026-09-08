#!/usr/bin/env sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
database_url=${ORES_LOCKS_TEST_DATABASE_URL:-}
[ -n "$database_url" ] || {
  echo "ORES_LOCKS_TEST_DATABASE_URL is required" >&2
  exit 2
}
command -v psql >/dev/null 2>&1 || {
  echo "psql is required" >&2
  exit 2
}

scratch=$(mktemp -d "${TMPDIR:-/tmp}/ores-fence-postgres.XXXXXX")
tenant="tenant/race-$$"
resource="example/jobs/race-$$"
cleanup() {
  psql "$database_url" -X -q -v ON_ERROR_STOP=1 \
    -v tenant="$tenant" -v resource="$resource" <<'SQL' >/dev/null 2>&1 || true
DELETE FROM ores_locks.fencing_watermarks
WHERE tenant_scope = :'tenant' AND resource_key = :'resource';
SQL
  find "$scratch" -depth -delete >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

psql "$database_url" -X -q -v ON_ERROR_STOP=1 -f "$root/fencing.sql"

writer() {
  token=$1
  psql "$database_url" -X -A -t -v ON_ERROR_STOP=1 \
    -v tenant="$tenant" -v resource="$resource" -v token="$token" <<'SQL'
BEGIN;
SELECT pg_sleep(0.15);
SELECT decision || '|' || should_apply::text || '|' || current_token
FROM ores_locks.try_advance_fence(
  :'tenant',
  :'resource',
  :'token',
  'op-' || :'token',
  repeat('a', 64),
  'worker-' || :'token',
  'lease-' || :'token'
);
COMMIT;
SQL
}

# Separate sessions race to create the first row. The insert-loop/row-lock
# protocol must serialize them and retain the numerically greatest token,
# independent of process scheduling.
for token in $(seq 1 32); do
  writer "$token" >"$scratch/writer-$token.out" 2>"$scratch/writer-$token.err" &
done
wait

for token in $(seq 1 32); do
  test ! -s "$scratch/writer-$token.err" || {
    cat "$scratch/writer-$token.err" >&2
    exit 1
  }
  grep -Eq '^(advanced|stale)\|(true|false)\|[0-9]+$' "$scratch/writer-$token.out"
done

final_token=$(psql "$database_url" -X -A -t -v ON_ERROR_STOP=1 \
  -v tenant="$tenant" -v resource="$resource" <<'SQL'
SELECT fencing_token::text
FROM ores_locks.fencing_watermarks
WHERE tenant_scope = :'tenant' AND resource_key = :'resource';
SQL
)
test "$final_token" = "32"

replay=$(psql "$database_url" -X -A -t -v ON_ERROR_STOP=1 \
  -v tenant="$tenant" -v resource="$resource" <<'SQL'
SELECT decision || '|' || should_apply::text || '|' || current_token
FROM ores_locks.try_advance_fence(
  :'tenant', :'resource', '32', 'op-32', repeat('a', 64),
  'worker-retry', 'lease-32'
);
SQL
)
test "$replay" = "replay|false|32"

stale=$(psql "$database_url" -X -A -t -v ON_ERROR_STOP=1 \
  -v tenant="$tenant" -v resource="$resource" <<'SQL'
SELECT decision || '|' || should_apply::text || '|' || current_token
FROM ores_locks.try_advance_fence(
  :'tenant', :'resource', '31', 'op-late', repeat('b', 64),
  'worker-late', 'lease-late'
);
SQL
)
test "$stale" = "stale|false|32"

echo "postgres fencing concurrency checks passed"
