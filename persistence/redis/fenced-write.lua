-- Atomic fencing for one Redis-resident value.
--
-- KEYS[1] = watermark hash key, e.g. ores-locks:{tenant/acme:jobs/rebuild}:fence
-- KEYS[2] = protected value key, e.g. ores-locks:{tenant/acme:jobs/rebuild}:state
--
-- ARGV[1] = canonical uint64 decimal fencing token
-- ARGV[2] = operation id (1..128 bytes)
-- ARGV[3] = lowercase payload SHA-256
-- ARGV[4] = serialized protected value
-- ARGV[5] = holder (optional, empty means absent)
-- ARGV[6] = lease id (optional, empty means absent)
--
-- Returns:
--   { decision, should_apply ("1"|"0"), current_token, previous_token_or_empty }
--
-- The two keys must be distinct and carry the same non-empty Redis Cluster
-- hash tag. This script deliberately never calls tonumber(): Redis Lua numbers
-- are doubles and cannot preserve the full Fiducia uint64 range.

local MAX_TOKEN = "18446744073709551615"

local function fail(message)
  return redis.error_reply("ORES_FENCE " .. message)
end

local function hash_tag(key)
  local open = string.find(key, "{", 1, true)
  if not open then
    return nil
  end
  local close = string.find(key, "}", open + 1, true)
  if not close or close == open + 1 then
    return nil
  end
  return string.sub(key, open + 1, close - 1)
end

local function canonical_token(value)
  if not value or #value == 0 or #value > 20 then
    return false
  end
  if #value > 1 and string.sub(value, 1, 1) == "0" then
    return false
  end
  if not string.match(value, "^%d+$") then
    return false
  end
  if #value == 20 and value > MAX_TOKEN then
    return false
  end
  return true
end

local function compare_decimal(left, right)
  if #left < #right then
    return -1
  end
  if #left > #right then
    return 1
  end
  if left < right then
    return -1
  end
  if left > right then
    return 1
  end
  return 0
end

local function valid_optional(value, max_bytes)
  return value == nil or value == "" or (#value >= 1 and #value <= max_bytes)
end

if #KEYS ~= 2 then
  return fail("expected exactly two keys")
end
if #ARGV < 4 or #ARGV > 6 then
  return fail("expected four required and up to two optional arguments")
end

local watermark_key = KEYS[1]
local state_key = KEYS[2]
-- Check before any Redis call: SET on the watermark key would destroy the hash.
if watermark_key == state_key then
  return fail("watermark and state keys must be distinct")
end
local watermark_tag = hash_tag(watermark_key)
local state_tag = hash_tag(state_key)
if not watermark_tag or not state_tag or watermark_tag ~= state_tag then
  return fail("watermark and state keys must use the same non-empty hash tag")
end

local incoming = ARGV[1]
local operation_id = ARGV[2]
local payload_sha256 = ARGV[3]
local serialized_value = ARGV[4]
local holder = ARGV[5] or ""
local lease_id = ARGV[6] or ""

if not canonical_token(incoming) then
  return fail("fencing token must be canonical unsigned-64 decimal text")
end
if not operation_id or #operation_id < 1 or #operation_id > 128 then
  return fail("operation id must contain 1..128 bytes")
end
if not payload_sha256
    or #payload_sha256 ~= 64
    or not string.match(payload_sha256, "^[0-9a-f]+$")
then
  return fail("payload SHA-256 must be 64 lowercase hexadecimal characters")
end
if not valid_optional(holder, 256) then
  return fail("holder must be absent or contain 1..256 bytes")
end
if not valid_optional(lease_id, 256) then
  return fail("lease id must be absent or contain 1..256 bytes")
end

local current = redis.call("HGET", watermark_key, "fencing_token")
if not current then
  redis.call(
    "HSET",
    watermark_key,
    "fencing_token", incoming,
    "operation_id", operation_id,
    "payload_sha256", payload_sha256,
    "holder", holder,
    "lease_id", lease_id
  )
  redis.call("SET", state_key, serialized_value)
  return { "advanced", "1", incoming, "" }
end

if not canonical_token(current) then
  return fail("stored watermark is not canonical unsigned-64 decimal text")
end

local comparison = compare_decimal(incoming, current)
if comparison > 0 then
  redis.call(
    "HSET",
    watermark_key,
    "fencing_token", incoming,
    "operation_id", operation_id,
    "payload_sha256", payload_sha256,
    "holder", holder,
    "lease_id", lease_id
  )
  redis.call("SET", state_key, serialized_value)
  return { "advanced", "1", incoming, current }
end

if comparison < 0 then
  return { "stale", "0", current, current }
end

local current_operation = redis.call("HGET", watermark_key, "operation_id")
local current_payload = redis.call("HGET", watermark_key, "payload_sha256")
if current_operation == operation_id and current_payload == payload_sha256 then
  return { "replay", "0", current, current }
end

return { "token_reuse", "0", current, current }
