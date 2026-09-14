-- Atomic fenced lease acquisition for Redis/Valkey.
-- KEYS[1] lease hash, KEYS[2] persistent fencing counter.
-- ARGV[1] holder, ARGV[2] TTL milliseconds.
-- Both keys MUST share one Redis Cluster hash tag.
--
-- Returns {1, token, pttl, replayed} when acquired/replayed or
-- {0, '', pttl, 0} on contention. `replayed` is 1 only when an active grant for
-- the same holder is returned. Re-acquiring with the current holder never
-- extends its TTL or mints another fencing token; clients can follow a replay
-- with explicit token-bound renewal before exposing authority to guarded work.
--
-- The counter is a decimal string and is incremented digit-by-digit so Redis
-- Lua double precision never participates in fencing-token arithmetic.

local lock_key = KEYS[1]
local fence_key = KEYS[2]
local holder = ARGV[1]
local ttl_ms = ARGV[2]

if redis.call('EXISTS', lock_key) == 1 then
  local pttl = redis.call('PTTL', lock_key)
  if pttl <= 0 then
    return redis.error_reply('ores-locks: active lease is missing a positive TTL')
  end
  local current_holder = redis.call('HGET', lock_key, 'holder')
  local current_token = redis.call('HGET', lock_key, 'token')
  if not current_holder or not current_token then
    return redis.error_reply('ores-locks: corrupt active lease')
  end
  if current_holder == holder then
    return {1, current_token, pttl, 1}
  end
  return {0, '', pttl, 0}
end

local current = redis.call('GET', fence_key) or '0'
if not string.match(current, '^%d+$') then
  return redis.error_reply('ores-locks: corrupt decimal fencing counter')
end
current = string.gsub(current, '^0+', '')
if current == '' then current = '0' end

local carry = 1
local reversed = {}
for i = string.len(current), 1, -1 do
  local digit = string.byte(current, i) - 48 + carry
  if digit >= 10 then
    digit = digit - 10
    carry = 1
  else
    carry = 0
  end
  table.insert(reversed, string.char(48 + digit))
end
if carry == 1 then table.insert(reversed, '1') end

local next_chars = {}
for i = #reversed, 1, -1 do table.insert(next_chars, reversed[i]) end
local next_token = table.concat(next_chars)
local max_safe_json_integer = '9007199254740991'
if string.len(next_token) > 16 or
   (string.len(next_token) == 16 and next_token > max_safe_json_integer) then
  return redis.error_reply('ores-locks: safe-integer fencing token exhausted')
end

redis.call('SET', fence_key, next_token)
redis.call('HSET', lock_key, 'holder', holder, 'token', next_token)
redis.call('PEXPIRE', lock_key, ttl_ms)
return {1, next_token, redis.call('PTTL', lock_key), 0}
