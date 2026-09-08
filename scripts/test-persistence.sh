#!/usr/bin/env sh
# Exercise the canonical and generated PostgreSQL/Redis fencing adapters.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
database_url=${ORES_LOCKS_TEST_DATABASE_URL:-}
redis_host=${REDIS_HOST:-127.0.0.1}
redis_port=${REDIS_PORT:-6379}
adversarial_corpus=${ORES_LOCKS_ADVERSARIAL_CORPUS:-$root/conformance/cases/fence-decision.json}

if [ -z "$database_url" ]; then
  echo "ORES_LOCKS_TEST_DATABASE_URL is required" >&2
  exit 2
fi

for command in psql redis-cli python3 node; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "$command is required" >&2
    exit 2
  fi
done

log() { printf '[persistence] %s\n' "$*"; }

psql_db() {
  PGDATABASE="$database_url" psql "$@"
}


log "canonical PostgreSQL adapter"
psql_db -v ON_ERROR_STOP=1 \
  -f "$root/persistence/postgres/test-fencing.sql"

log "adversarial PostgreSQL boundaries and rollback"
psql_db -v ON_ERROR_STOP=1 \
  -f "$root/persistence/postgres/test-fencing-adversarial.sql"

log "concurrent PostgreSQL first-writer and rollback proof"
ORES_LOCKS_TEST_DATABASE_URL="$database_url" \
  sh "$root/persistence/postgres/test-fencing-concurrency.sh"

log "canonical and adversarial Redis adapter"
REDIS_HOST="$redis_host" REDIS_PORT="$redis_port" \
  sh "$root/persistence/redis/test-fenced-write.sh"

if node -e '
  const corpus=require(process.argv[1]);
  process.exit(corpus?.schema === "ores.locks-and-leases.fence-corpus/v2"
    && Array.isArray(corpus.storeSequence)
    && corpus.storeSequence.length >= 64 ? 0 : 1);
' "$adversarial_corpus"; then
  log "deterministic stateful sequence against PostgreSQL and Redis"
  ORES_LOCKS_TEST_DATABASE_URL="$database_url" \
  REDIS_HOST="$redis_host" REDIS_PORT="$redis_port" \
    node "$root/scripts/test-adversarial-datastores.mjs" \
      --corpus "$adversarial_corpus" \
      --receipt "$root/target/adversarial/store-receipt.json"
else
  log "stateful adversarial sequence skipped (compact corpus has no generated sequence)"
fi

scratch=$(mktemp -d "${TMPDIR:-/tmp}/ores-locks-persistence.XXXXXX")
cleanup() {
  if [ -d "$scratch" ]; then
    find "$scratch" -depth -delete
  fi
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$scratch/locks"
cat > "$scratch/locks/.zpkg.toml" <<'MANIFEST'
[package]
org = "preflight-example"
name = "preflight-locks"
version = "0.1.0"

[scripts]
test = "echo preflight"
MANIFEST
cat > "$scratch/locks/README.md" <<'README'
# preflight-locks
README
cat > "$scratch/locks/catalog.json" <<'CATALOG'
{"org":"preflight-example","prefix":"preflight","entries":[]}
CATALOG

log "generated consumer adapters"
python3 "$root/templates/lib-core/gen_org_fencing.py" \
  --repo "$scratch" \
  --org preflight-example \
  --prefix preflight

python3 -m json.tool \
  "$scratch/locks/persistence/fencing.config.json" >/dev/null
grep -q '^CREATE SCHEMA IF NOT EXISTS preflight_locks;' \
  "$scratch/locks/persistence/postgres/fencing.sql"
grep -q 'preflight-example-locks:{' \
  "$scratch/locks/persistence/redis/test-fenced-write.sh"
grep -q 'newer token never silently repairs it' \
  "$scratch/locks/persistence/redis/fenced-write.lua"

psql_db -v ON_ERROR_STOP=1 \
  -f "$scratch/locks/persistence/postgres/test-fencing.sql"
REDIS_HOST="$redis_host" REDIS_PORT="$redis_port" \
  sh "$scratch/locks/persistence/redis/test-fenced-write.sh"

log "canonical and generated persistence checks passed"
