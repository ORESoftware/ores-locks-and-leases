-- Atomic fenced lease acquisition for Redis/Valkey.
-- KEYS[1] lease hash, KEYS[2] persistent fencing counter.
-- ARGV[1] holder, ARGV[2] TTL milliseconds.
-- Both keys MUST share one Redis Cluster hash tag.
--
-- Returns {1, token, pttl} when acquired or {0, '', pttl} on contention.
-- The counter is a decimal string and is incremented digit-by-digit so neither
-- Redis Lua double precision nor Redis INCR's signed-64 ceiling truncates u64.

local lock_key = KEYS[1]
local fence_key = KEYS[2]
local holder = ARGV[1]
local ttl_ms = ARGV[2]

if redis.call('EXISTS', lock_key) == 1 then
  return {0, '', redis.call('PTTL', lock_key)}
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
local max_u64 = '18446744073709551615'
if string.len(next_token) > 20 or (string.len(next_token) == 20 and next_token > max_u64) then
  return redis.error_reply('ores-locks: unsigned-64 fencing token overflow')
end

redis.call('SET', fence_key, next_token)
redis.call('HSET', lock_key, 'holder', holder, 'token', next_token)
redis.call('PEXPIRE', lock_key, ttl_ms)
return {1, next_token, redis.call('PTTL', lock_key)}
