#!/usr/bin/env sh
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
redis_host=${REDIS_HOST:-127.0.0.1}
redis_port=${REDIS_PORT:-6379}
tag="ores-fence-ci-$$"
watermark="ores-locks:{$tag}:fence"
state="ores-locks:{$tag}:state"
orphan_watermark="ores-locks:{$tag-orphan}:fence"
orphan_state="ores-locks:{$tag-orphan}:state"
missing_state_watermark="ores-locks:{$tag-missing-state}:fence"
missing_state="ores-locks:{$tag-missing-state}:state"
partial_watermark="ores-locks:{$tag-partial}:fence"
partial_state="ores-locks:{$tag-partial}:state"
bad_payload_watermark="ores-locks:{$tag-bad-payload}:fence"
bad_payload_state="ores-locks:{$tag-bad-payload}:state"
wrong_watermark="ores-locks:{$tag-wrong-watermark}:fence"
wrong_watermark_state="ores-locks:{$tag-wrong-watermark}:state"
wrong_state_watermark="ores-locks:{$tag-wrong-state}:fence"
wrong_state="ores-locks:{$tag-wrong-state}:state"
concurrent_watermark="ores-locks:{$tag-concurrent}:fence"
concurrent_state="ores-locks:{$tag-concurrent}:state"
concurrent_output_10="${TMPDIR:-/tmp}/ores-fence-10-$$"
concurrent_output_11="${TMPDIR:-/tmp}/ores-fence-11-$$"
digest_a=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
digest_b=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
all_keys="$watermark $state $orphan_watermark $orphan_state $missing_state_watermark $missing_state $partial_watermark $partial_state $bad_payload_watermark $bad_payload_state $wrong_watermark $wrong_watermark_state $wrong_state_watermark $wrong_state $concurrent_watermark $concurrent_state"

cleanup() {
  # shellcheck disable=SC2086 -- the list contains generated keys without spaces.
  redis-cli -h "$redis_host" -p "$redis_port" DEL $all_keys >/dev/null 2>&1 || true
  rm -f "$concurrent_output_10" "$concurrent_output_11"
}
trap cleanup EXIT HUP INT TERM

run_fence_for() {
  target_watermark=$1
  target_state=$2
  token=$3
  operation=$4
  digest=$5
  value=$6
  holder=${7:-}
  lease=${8:-}
  redis-cli -h "$redis_host" -p "$redis_port" --raw \
    --eval "$here/fenced-write.lua" "$target_watermark" "$target_state" , \
    "$token" "$operation" "$digest" "$value" "$holder" "$lease" \
    | paste -sd '|' -
}

run_fence() {
  run_fence_for "$watermark" "$state" "$@"
}

expect_fence_error() {
  expected=$1
  shift
  invalid=$(run_fence_for "$@" 2>&1 || true)
  if ! printf '%s' "$invalid" | grep -Fq "ORES_FENCE $expected"; then
    printf 'expected ORES_FENCE %s, got: %s\n' "$expected" "$invalid" >&2
    return 1
  fi
}

assert_alias_rejected() {
  alias_key=$1
  expect_fence_error \
    "watermark and state keys must be distinct" \
    "$alias_key" "$alias_key" 2 op-alias "$digest_b" corrupted \
    worker-alias lease-alias
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

# A malformed incoming token must fail without changing either key.
expect_fence_error \
  "fencing token must be canonical unsigned-64 decimal text" \
  "$watermark" "$state" 01 op-invalid "$digest_a" invalid "" ""
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw GET "$state")" = "maximum"

# Hash-slot and identity validation happen before any key access or mutation.
mismatch_watermark="ores-locks:{$tag-slot-a}:fence"
mismatch_state="ores-locks:{$tag-slot-b}:state"
expect_fence_error \
  "watermark and state keys must use the same non-empty hash tag" \
  "$mismatch_watermark" "$mismatch_state" 1 op-slot "$digest_a" slot "" ""
test "$(redis-cli -h "$redis_host" -p "$redis_port" EXISTS "$mismatch_watermark")" = "0"
test "$(redis-cli -h "$redis_host" -p "$redis_port" EXISTS "$mismatch_state")" = "0"

# An orphan state value is not silently adopted by a first fencing write.
redis-cli -h "$redis_host" -p "$redis_port" SET "$orphan_state" orphan >/dev/null
expect_fence_error \
  "orphan protected state exists without a watermark" \
  "$orphan_watermark" "$orphan_state" 1 op-orphan "$digest_a" replacement "" ""
test "$(redis-cli -h "$redis_host" -p "$redis_port" EXISTS "$orphan_watermark")" = "0"
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw GET "$orphan_state")" = "orphan"

# A valid watermark whose protected state disappeared is corruption. Even a
# newer token must not silently reconstruct the value.
redis-cli -h "$redis_host" -p "$redis_port" HSET "$missing_state_watermark" \
  fencing_token 1 operation_id op-1 payload_sha256 "$digest_a" \
  holder worker-a lease_id lease-a >/dev/null
expect_fence_error \
  "protected state is missing for the existing watermark" \
  "$missing_state_watermark" "$missing_state" 2 op-2 "$digest_b" replacement \
  worker-b lease-b
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw HGET "$missing_state_watermark" fencing_token)" = "1"
test "$(redis-cli -h "$redis_host" -p "$redis_port" EXISTS "$missing_state")" = "0"

# A partial watermark is never healed by a newer token.
redis-cli -h "$redis_host" -p "$redis_port" HSET "$partial_watermark" \
  fencing_token 1 payload_sha256 "$digest_a" holder worker-a lease_id lease-a >/dev/null
redis-cli -h "$redis_host" -p "$redis_port" SET "$partial_state" original >/dev/null
expect_fence_error \
  "stored watermark operation_id is missing or invalid" \
  "$partial_watermark" "$partial_state" 2 op-2 "$digest_b" replacement \
  worker-b lease-b
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw HGET "$partial_watermark" fencing_token)" = "1"
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw GET "$partial_state")" = "original"

# Invalid stored digest metadata also fails before a newer write.
redis-cli -h "$redis_host" -p "$redis_port" HSET "$bad_payload_watermark" \
  fencing_token 1 operation_id op-1 payload_sha256 "$(printf '%s' "$digest_a" | tr a A)" \
  holder worker-a lease_id lease-a >/dev/null
redis-cli -h "$redis_host" -p "$redis_port" SET "$bad_payload_state" original >/dev/null
expect_fence_error \
  "stored watermark payload_sha256 is missing or invalid" \
  "$bad_payload_watermark" "$bad_payload_state" 2 op-2 "$digest_b" replacement \
  worker-b lease-b
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw HGET "$bad_payload_watermark" fencing_token)" = "1"
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw GET "$bad_payload_state")" = "original"

# A malformed stored token is rejected before a newer writer can replace it.
redis-cli -h "$redis_host" -p "$redis_port" DEL \
  "$bad_payload_watermark" "$bad_payload_state" >/dev/null
redis-cli -h "$redis_host" -p "$redis_port" HSET "$bad_payload_watermark" \
  fencing_token 01 operation_id op-1 payload_sha256 "$digest_a" \
  holder worker-a lease_id lease-a >/dev/null
redis-cli -h "$redis_host" -p "$redis_port" SET "$bad_payload_state" original >/dev/null
expect_fence_error \
  "stored watermark is not canonical unsigned-64 decimal text" \
  "$bad_payload_watermark" "$bad_payload_state" 2 op-2 "$digest_b" replacement \
  worker-b lease-b
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw HGET "$bad_payload_watermark" fencing_token)" = "01"
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw GET "$bad_payload_state")" = "original"

# Unexpected hash fields are corruption, not a source of new authority.
redis-cli -h "$redis_host" -p "$redis_port" DEL \
  "$bad_payload_watermark" "$bad_payload_state" >/dev/null
redis-cli -h "$redis_host" -p "$redis_port" HSET "$bad_payload_watermark" \
  fencing_token 1 operation_id op-1 payload_sha256 "$digest_a" \
  holder worker-a lease_id lease-a forged_authority yes >/dev/null
redis-cli -h "$redis_host" -p "$redis_port" SET "$bad_payload_state" original >/dev/null
expect_fence_error \
  "stored watermark must contain exactly five fields" \
  "$bad_payload_watermark" "$bad_payload_state" 2 op-2 "$digest_b" replacement \
  worker-b lease-b
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw HGET "$bad_payload_watermark" fencing_token)" = "1"
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw GET "$bad_payload_state")" = "original"

# Wrong Redis data types return stable ORES_FENCE errors and remain untouched.
redis-cli -h "$redis_host" -p "$redis_port" SET "$wrong_watermark" not-a-hash >/dev/null
redis-cli -h "$redis_host" -p "$redis_port" SET "$wrong_watermark_state" original >/dev/null
expect_fence_error \
  "watermark key must contain a hash" \
  "$wrong_watermark" "$wrong_watermark_state" 2 op-2 "$digest_b" replacement \
  worker-b lease-b
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw GET "$wrong_watermark")" = "not-a-hash"
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw GET "$wrong_watermark_state")" = "original"

redis-cli -h "$redis_host" -p "$redis_port" HSET "$wrong_state_watermark" \
  fencing_token 1 operation_id op-1 payload_sha256 "$digest_a" \
  holder worker-a lease_id lease-a >/dev/null
redis-cli -h "$redis_host" -p "$redis_port" HSET "$wrong_state" field value >/dev/null
expect_fence_error \
  "protected state key must contain a string" \
  "$wrong_state_watermark" "$wrong_state" 2 op-2 "$digest_b" replacement \
  worker-b lease-b
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw TYPE "$wrong_state")" = "hash"
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw HGET "$wrong_state_watermark" fencing_token)" = "1"

# Concurrent first writes serialize in Redis. Regardless of scheduling, token
# 11 wins and the state/value pair cannot diverge.
run_fence_for "$concurrent_watermark" "$concurrent_state" \
  10 op-10 "$digest_a" ten worker-10 lease-10 >"$concurrent_output_10" &
pid_10=$!
run_fence_for "$concurrent_watermark" "$concurrent_state" \
  11 op-11 "$digest_b" eleven worker-11 lease-11 >"$concurrent_output_11" &
pid_11=$!
wait "$pid_10"
wait "$pid_11"
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw HGET "$concurrent_watermark" fencing_token)" = "11"
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw GET "$concurrent_state")" = "eleven"
rm -f "$concurrent_output_10" "$concurrent_output_11"

echo "redis fencing checks passed"
