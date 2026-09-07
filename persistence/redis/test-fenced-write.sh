#!/usr/bin/env sh
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
redis_host=${REDIS_HOST:-127.0.0.1}
redis_port=${REDIS_PORT:-6379}
tag="ores-fence-ci-$$"
watermark="ores-locks:{$tag}:fence"
state="ores-locks:{$tag}:state"
digest_a=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
digest_b=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb

cleanup() {
  redis-cli -h "$redis_host" -p "$redis_port" DEL "$watermark" "$state" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

run_fence() {
  token=$1
  operation=$2
  digest=$3
  value=$4
  holder=${5:-}
  lease=${6:-}
  redis-cli -h "$redis_host" -p "$redis_port" --raw \
    --eval "$here/fenced-write.lua" "$watermark" "$state" , \
    "$token" "$operation" "$digest" "$value" "$holder" "$lease" \
    | paste -sd '|' -
}

assert_alias_rejected() {
  alias_key=$1
  invalid=$(
    redis-cli -h "$redis_host" -p "$redis_port" --raw \
      --eval "$here/fenced-write.lua" "$alias_key" "$alias_key" , \
      2 op-alias "$digest_b" corrupted worker-alias lease-alias 2>&1 || true
  )
  # A shared hash tag does not imply two distinct keys. Require our exact error,
  # not a later WRONGTYPE error after the script has already touched a key.
  if ! printf '%s' "$invalid" | grep -Fq 'ORES_FENCE watermark and state keys must be distinct'; then
    printf 'expected distinct-key rejection, got: %s\n' "$invalid" >&2
    return 1
  fi
}

cleanup

# Rejection on an absent key must not create either a hash or a state string.
assert_alias_rejected "$watermark"
test "$(redis-cli -h "$redis_host" -p "$redis_port" EXISTS "$watermark")" = "0"
test "$(redis-cli -h "$redis_host" -p "$redis_port" EXISTS "$state")" = "0"

reply=$(run_fence 1 op-1 "$digest_a" first worker-a lease-1)
test "$reply" = "advanced|1|1|"
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw GET "$state")" = "first"

# Token 2 would otherwise advance the hash and then SET over that same hash.
assert_alias_rejected "$watermark"
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw TYPE "$watermark")" = "hash"
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw HLEN "$watermark")" = "5"
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw HGET "$watermark" fencing_token)" = "1"
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw HGET "$watermark" operation_id)" = "op-1"
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw HGET "$watermark" payload_sha256)" = "$digest_a"
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw HGET "$watermark" holder)" = "worker-a"
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw HGET "$watermark" lease_id)" = "lease-1"
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw GET "$state")" = "first"

# Reject an alias of the existing state key before even attempting HGET.
assert_alias_rejected "$state"
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw TYPE "$state")" = "string"
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw GET "$state")" = "first"
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw HGET "$watermark" fencing_token)" = "1"

reply=$(run_fence 1 op-1 "$digest_a" replayed worker-a-retry lease-1)
test "$reply" = "replay|0|1|1"
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw GET "$state")" = "first"

reply=$(run_fence 1 op-other "$digest_a" reused worker-b lease-1)
test "$reply" = "token_reuse|0|1|1"
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw GET "$state")" = "first"

reply=$(run_fence 2 op-2 "$digest_b" second worker-b lease-2)
test "$reply" = "advanced|1|2|1"
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw GET "$state")" = "second"

reply=$(run_fence 1 op-late "$digest_a" stale worker-a lease-1)
test "$reply" = "stale|0|2|2"
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw GET "$state")" = "second"

reply=$(run_fence 18446744073709551615 op-max "$digest_a" maximum worker-max lease-max)
test "$reply" = "advanced|1|18446744073709551615|2"
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw HGET "$watermark" fencing_token)" = "18446744073709551615"
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw GET "$state")" = "maximum"

# A malformed token must fail without changing either key. redis-cli may return
# zero on a server-side error, so assert the error text and unchanged state.
invalid=$(
  redis-cli -h "$redis_host" -p "$redis_port" --raw \
    --eval "$here/fenced-write.lua" "$watermark" "$state" , \
    01 op-invalid "$digest_a" invalid "" "" 2>&1 || true
)
printf '%s' "$invalid" | grep -q 'ORES_FENCE'
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw GET "$state")" = "maximum"

echo "redis fencing checks passed"
