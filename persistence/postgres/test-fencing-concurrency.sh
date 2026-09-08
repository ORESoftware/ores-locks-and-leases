#!/usr/bin/env sh
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH= cd -- "$here/../.." && pwd)
database_url=${ORES_LOCKS_TEST_DATABASE_URL:-}
if [ -z "$database_url" ]; then
  echo "ORES_LOCKS_TEST_DATABASE_URL is required" >&2
  exit 2
fi
for command in node psql; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "$command is required" >&2
    exit 2
  fi
done

tenant="tenant/concurrency-$$"
resource="resource/concurrency"
digest_a=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
digest_b=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
scratch=$(mktemp -d "${TMPDIR:-/tmp}/ores-fence-pg.XXXXXX")

psql_db() {
  node "$root/scripts/run-psql.mjs" "$@"
}

cleanup() {
  psql_db -v ON_ERROR_STOP=1 -q \
    -v tenant="$tenant" \
    -c "DELETE FROM ores_locks.fencing_watermarks WHERE tenant_scope = :'tenant'" \
    >/dev/null 2>&1 || true
  find "$scratch" -depth -delete >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

psql_db -v ON_ERROR_STOP=1 -q -f "$here/fencing.sql"
psql_db -v ON_ERROR_STOP=1 -q \
  -v tenant="$tenant" \
  -c "DELETE FROM ores_locks.fencing_watermarks WHERE tenant_scope = :'tenant'"

writer() {
  token=$1
  operation=$2
  digest=$3
  delay=$4
  output=$5
  psql_db -v ON_ERROR_STOP=1 -qAt \
    -v tenant="$tenant" \
    -v resource="$resource" \
    -v token="$token" \
    -v operation="$operation" \
    -v digest="$digest" \
    -v delay="$delay" >"$output" <<'SQL'
BEGIN;
SELECT decision
FROM ores_locks.try_advance_fence(
  :'tenant', :'resource', :'token', :'operation', :'digest', NULL, NULL
);
SELECT pg_sleep(:'delay'::double precision);
COMMIT;
SQL
}

# Two transactions race the absent-row INSERT path. The lower token may win
# first or may be stale, but after both commit the higher token and operation
# must agree in the same row.
writer 10 op-10 "$digest_a" 0.20 "$scratch/writer-10" &
pid_10=$!
writer 11 op-11 "$digest_b" 0.00 "$scratch/writer-11" &
pid_11=$!
wait "$pid_10"
wait "$pid_11"

final=$(psql_db -v ON_ERROR_STOP=1 -qAt \
  -v tenant="$tenant" -v resource="$resource" \
  -c "SELECT fencing_token::text || '|' || operation_id FROM ores_locks.fencing_watermarks WHERE tenant_scope = :'tenant' AND resource_key = :'resource'")
test "$final" = "11|op-11"

# A larger first-write storm must converge to the maximum token regardless of
# scheduling. Every writer uses one transaction and the same composite key.
pids=
for token in 100 101 102 103 104 105 106 107 108 109 110 111 112 113 114 115; do
  writer "$token" "op-$token" "$digest_a" 0.00 "$scratch/writer-$token" &
  pids="$pids $!"
done
for pid in $pids; do
  wait "$pid"
done

final=$(psql_db -v ON_ERROR_STOP=1 -qAt \
  -v tenant="$tenant" -v resource="$resource" \
  -c "SELECT fencing_token::text || '|' || operation_id FROM ores_locks.fencing_watermarks WHERE tenant_scope = :'tenant' AND resource_key = :'resource'")
test "$final" = "115|op-115"

# A later advance rolled back by the caller must not change the durable
# watermark or operation identity.
psql_db -v ON_ERROR_STOP=1 -q \
  -v tenant="$tenant" -v resource="$resource" <<'SQL'
BEGIN;
SELECT * FROM ores_locks.try_advance_fence(
  :'tenant', :'resource', '116', 'op-116',
  repeat('b', 64), NULL, NULL
);
ROLLBACK;
SQL
final=$(psql_db -v ON_ERROR_STOP=1 -qAt \
  -v tenant="$tenant" -v resource="$resource" \
  -c "SELECT fencing_token::text || '|' || operation_id FROM ores_locks.fencing_watermarks WHERE tenant_scope = :'tenant' AND resource_key = :'resource'")
test "$final" = "115|op-115"

echo "postgres concurrent fencing checks passed"
