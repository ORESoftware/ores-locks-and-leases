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
scratch=$(mktemp -d "${TMPDIR:-/tmp}/ores-fence-redis.XXXXXX")

cleanup() {
  redis-cli -h "$redis_host" -p "$redis_port" --scan --pattern "ores-locks:{${tag}*}:*" \
    | while IFS= read -r key; do
        [ -z "$key" ] || redis-cli -h "$redis_host" -p "$redis_port" DEL "$key" >/dev/null 2>&1 || true
      done
  find "$scratch" -depth -delete >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

run_for_keys() {
  watermark_key=$1
  state_key=$2
  token=$3
  operation=$4
  digest=$5
  value=$6
  holder=${7:-}
  lease=${8:-}
  redis-cli -h "$redis_host" -p "$redis_port" --raw \
    --eval "$here/fenced-write.lua" "$watermark_key" "$state_key" , \
    "$token" "$operation" "$digest" "$value" "$holder" "$lease" \
    | paste -sd '|' -
}

run_fence() {
  run_for_keys "$watermark" "$state" "$@"
}

expect_error() {
  expected=$1
  shift
  output=$(run_for_keys "$@" 2>&1 || true)
  if ! printf '%s' "$output" | grep -Fq "ORES_FENCE $expected"; then
    printf 'expected Redis fencing error %s, got: %s\n' "$expected" "$output" >&2
    return 1
  fi
}

assert_base_state() {
  test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw TYPE "$watermark")" = "hash"
  test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw HLEN "$watermark")" = "5"
  test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw HGET "$watermark" fencing_token)" = "$1"
  test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw GET "$state")" = "$2"
}

# Identity and Cluster-slot failures occur before either key is read or written.
expect_error "watermark and state keys must be distinct" \
  "$watermark" "$watermark" 1 op-alias "$digest_a" corrupt "" ""
test "$(redis-cli -h "$redis_host" -p "$redis_port" EXISTS "$watermark")" = "0"

slot_watermark="ores-locks:{${tag}-a}:fence"
slot_state="ores-locks:{${tag}-b}:state"
expect_error "watermark and state keys must use the same non-empty hash tag" \
  "$slot_watermark" "$slot_state" 1 op-slot "$digest_a" corrupt "" ""
test "$(redis-cli -h "$redis_host" -p "$redis_port" EXISTS "$slot_watermark")" = "0"
test "$(redis-cli -h "$redis_host" -p "$redis_port" EXISTS "$slot_state")" = "0"

# Orphan and wrong-type storage fail closed rather than being repaired.
redis-cli -h "$redis_host" -p "$redis_port" SET "$state" orphan >/dev/null
expect_error "protected state exists without a fencing watermark" \
  "$watermark" "$state" 1 op-orphan "$digest_a" replace "" ""
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw GET "$state")" = "orphan"
redis-cli -h "$redis_host" -p "$redis_port" DEL "$state" >/dev/null
redis-cli -h "$redis_host" -p "$redis_port" SET "$watermark" wrong-type >/dev/null
expect_error "watermark key must be absent or a hash" \
  "$watermark" "$state" 1 op-type "$digest_a" replace "" ""
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw GET "$watermark")" = "wrong-type"
redis-cli -h "$redis_host" -p "$redis_port" DEL "$watermark" >/dev/null

reply=$(run_fence 1 op-1 "$digest_a" first worker-a lease-1)
test "$reply" = "advanced|1|1|"
assert_base_state 1 first

reply=$(run_fence 1 op-1 "$digest_a" replayed worker-a-retry lease-1)
test "$reply" = "replay|0|1|1"
assert_base_state 1 first

reply=$(run_fence 1 op-other "$digest_a" reused worker-b lease-1)
test "$reply" = "token_reuse|0|1|1"
assert_base_state 1 first

reply=$(run_fence 2 op-2 "$digest_b" second worker-b lease-2)
test "$reply" = "advanced|1|2|1"
assert_base_state 2 second

reply=$(run_fence 1 op-late "$digest_a" stale worker-a lease-1)
test "$reply" = "stale|0|2|2"
assert_base_state 2 second

# Every stored-field corruption fails before a larger token can overwrite it.
for field in operation_id payload_sha256 holder lease_id; do
  old=$(redis-cli -h "$redis_host" -p "$redis_port" --raw HGET "$watermark" "$field")
  case "$field" in
    operation_id) bad= ;;
    payload_sha256) bad=not-a-digest ;;
    holder) bad=$(printf 'h%.0s' $(seq 1 257)) ;;
    lease_id) bad=$(printf 'l%.0s' $(seq 1 257)) ;;
  esac
  redis-cli -h "$redis_host" -p "$redis_port" HSET "$watermark" "$field" "$bad" >/dev/null
  expect_error "stored watermark" \
    "$watermark" "$state" 3 op-3 "$digest_a" third worker-c lease-3
  test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw HGET "$watermark" fencing_token)" = "2"
  test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw GET "$state")" = "second"
  redis-cli -h "$redis_host" -p "$redis_port" HSET "$watermark" "$field" "$old" >/dev/null
done

redis-cli -h "$redis_host" -p "$redis_port" HSET "$watermark" unexpected forged >/dev/null
expect_error "stored watermark has an unexpected field set" \
  "$watermark" "$state" 3 op-extra "$digest_a" third worker-c lease-3
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw HGET "$watermark" fencing_token)" = "2"
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw GET "$state")" = "second"
redis-cli -h "$redis_host" -p "$redis_port" HDEL "$watermark" unexpected >/dev/null

redis-cli -h "$redis_host" -p "$redis_port" DEL "$state" >/dev/null
expect_error "fencing watermark exists without protected state" \
  "$watermark" "$state" 3 op-missing-state "$digest_a" third worker-c lease-3
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw HGET "$watermark" fencing_token)" = "2"
redis-cli -h "$redis_host" -p "$redis_port" SET "$state" second >/dev/null

# Invalid incoming values are rejected without changing either key.
for token in 01 +1 -1 18446744073709551616; do
  expect_error "fencing token must be canonical" \
    "$watermark" "$state" "$token" op-invalid "$digest_a" invalid "" ""
  assert_base_state 2 second
done
expect_error "operation id must contain" \
  "$watermark" "$state" 3 "" "$digest_a" invalid "" ""
expect_error "payload SHA-256" \
  "$watermark" "$state" 3 op-invalid not-a-digest invalid "" ""
assert_base_state 2 second

reply=$(run_fence 18446744073709551615 op-max "$digest_a" maximum worker-max lease-max)
test "$reply" = "advanced|1|18446744073709551615|2"
assert_base_state 18446744073709551615 maximum

# Concurrent first writes are serialized by Redis. Regardless of scheduling,
# the maximum token is the authoritative final watermark and exact replay is a
# no-op. Every process writes its result for deterministic post-run inspection.
race_tag="${tag}-race"
race_watermark="ores-locks:{$race_tag}:fence"
race_state="ores-locks:{$race_tag}:state"
for token in $(seq 1 32); do
  (
    run_for_keys "$race_watermark" "$race_state" "$token" "op-$token" \
      "$digest_b" "value-$token" "worker-$token" "lease-$token" \
      >"$scratch/race-$token.out"
  ) &
done
wait

test "$(find "$scratch" -name 'race-*.out' -type f | wc -l | tr -d ' ')" = "32"
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw HGET "$race_watermark" fencing_token)" = "32"
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw HGET "$race_watermark" operation_id)" = "op-32"
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw GET "$race_state")" = "value-32"
race_reply=$(run_for_keys "$race_watermark" "$race_state" 32 op-32 "$digest_b" replayed worker-retry lease-32)
test "$race_reply" = "replay|0|32|32"
test "$(redis-cli -h "$redis_host" -p "$redis_port" --raw GET "$race_state")" = "value-32"

echo "redis fencing adversarial checks passed"
