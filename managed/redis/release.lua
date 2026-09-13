-- Atomic fenced lease release for Redis/Valkey.
-- KEYS[1] lease hash.
-- ARGV[1] holder, ARGV[2] decimal fencing token.
-- Returns 1 only when this exact grant was deleted; 0 means authority was lost.

local lock_key = KEYS[1]
local holder = ARGV[1]
local token = ARGV[2]

if redis.call('HGET', lock_key, 'holder') ~= holder then return 0 end
if redis.call('HGET', lock_key, 'token') ~= token then return 0 end
return redis.call('DEL', lock_key)
