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

cleanup

reply=$(run_fence 1 op-1 "$digest_a" first worker-a lease-1)
test "$reply" = "advanced|1|1|"
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw GET "$state")" = "first"

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
