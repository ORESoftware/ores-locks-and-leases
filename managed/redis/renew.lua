-- Atomic fenced lease renewal for Redis/Valkey.
-- KEYS[1] lease hash.
-- ARGV[1] holder, ARGV[2] decimal fencing token, ARGV[3] TTL milliseconds.
-- Returns {1, pttl} when renewed or {0, -2} after authority is lost.

local lock_key = KEYS[1]
local holder = ARGV[1]
local token = ARGV[2]
local ttl_ms = ARGV[3]

if redis.call('HGET', lock_key, 'holder') ~= holder then return {0, -2} end
if redis.call('HGET', lock_key, 'token') ~= token then return {0, -2} end
redis.call('PEXPIRE', lock_key, ttl_ms)
return {1, redis.call('PTTL', lock_key)}
