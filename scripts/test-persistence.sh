#!/usr/bin/env sh
# Exercise the canonical and generated PostgreSQL/Redis fencing adapters.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
database_url=${ORES_LOCKS_TEST_DATABASE_URL:-}
redis_host=${REDIS_HOST:-127.0.0.1}
redis_port=${REDIS_PORT:-6379}

if [ -z "$database_url" ]; then
  echo "ORES_LOCKS_TEST_DATABASE_URL is required" >&2
  exit 2
fi

for command in psql redis-cli python3; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "$command is required" >&2
    exit 2
  fi
done

log() { printf '[persistence] %s\n' "$*"; }

log "canonical PostgreSQL adapter"
psql "$database_url" -v ON_ERROR_STOP=1 \
  -f "$root/persistence/postgres/test-fencing.sql"

log "canonical PostgreSQL adversarial matrix"
psql "$database_url" -v ON_ERROR_STOP=1 \
  -f "$root/persistence/postgres/test-fencing-adversarial.sql"
ORES_LOCKS_TEST_DATABASE_URL="$database_url" \
  sh "$root/persistence/postgres/test-fencing-concurrency.sh"

log "canonical Redis adapter and adversarial matrix"
REDIS_HOST="$redis_host" REDIS_PORT="$redis_port" \
  sh "$root/persistence/redis/test-fenced-write.sh"

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
grep -q 'stored fencing watermark is malformed; refusing mutation' \
  "$scratch/locks/persistence/postgres/fencing.sql"
grep -q 'preflight-example-locks:{' \
  "$scratch/locks/persistence/redis/test-fenced-write.sh"
grep -q 'stored watermark has an unexpected field set' \
  "$scratch/locks/persistence/redis/fenced-write.lua"

psql "$database_url" -v ON_ERROR_STOP=1 \
  -f "$scratch/locks/persistence/postgres/test-fencing.sql"
REDIS_HOST="$redis_host" REDIS_PORT="$redis_port" \
  sh "$scratch/locks/persistence/redis/test-fenced-write.sh"

log "canonical and generated persistence checks passed"
