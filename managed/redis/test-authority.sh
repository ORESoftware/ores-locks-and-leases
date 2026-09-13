#!/usr/bin/env sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
redis_host=${REDIS_HOST:-127.0.0.1}
redis_port=${REDIS_PORT:-6379}
tag="ores-locks-managed-$$"
lease_key="ores-locks:{${tag}}:lease"
fence_key="ores-locks:{${tag}}:fence"

redis() {
  redis-cli --raw -h "$redis_host" -p "$redis_port" "$@"
}

cleanup() {
  redis DEL "$lease_key" "$fence_key" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM
cleanup

acquire() {
  redis EVAL "$(cat "$root/acquire.lua")" 2 "$lease_key" "$fence_key" "$1" "$2"
}

renew() {
  redis EVAL "$(cat "$root/renew.lua")" 1 "$lease_key" "$1" "$2" "$3"
}

release() {
  redis EVAL "$(cat "$root/release.lua")" 1 "$lease_key" "$1" "$2"
}

line() {
  printf '%s\n' "$1" | sed -n "${2}p"
}

first=$(acquire holder-a 5000)
[ "$(line "$first" 1)" = "1" ]
[ "$(line "$first" 2)" = "1" ]

contended=$(acquire holder-b 5000)
[ "$(line "$contended" 1)" = "0" ]

wrong_renew=$(renew holder-a 999 5000)
[ "$(line "$wrong_renew" 1)" = "0" ]

renewed=$(renew holder-a 1 5000)
[ "$(line "$renewed" 1)" = "1" ]

[ "$(release holder-b 1)" = "0" ]
[ "$(release holder-a 1)" = "1" ]

second=$(acquire holder-b 5000)
[ "$(line "$second" 1)" = "1" ]
[ "$(line "$second" 2)" = "2" ]

# A stale holder/token pair cannot delete the newly acquired grant.
[ "$(release holder-a 1)" = "0" ]
[ "$(redis EXISTS "$lease_key")" = "1" ]
[ "$(release holder-b 2)" = "1" ]

# The fencing counter survives lease deletion and cannot wrap the u64 contract.
[ "$(redis GET "$fence_key")" = "2" ]
redis SET "$fence_key" 18446744073709551615 >/dev/null
overflow=$(acquire holder-c 5000 2>&1 || true)
printf '%s\n' "$overflow" | grep -q 'unsigned-64 fencing token overflow'
[ "$(redis EXISTS "$lease_key")" = "0" ]

printf '[managed-redis] live lease authority checks passed\n'
