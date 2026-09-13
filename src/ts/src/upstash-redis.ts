import { LockError } from "./errors.js";
import type { LockKey } from "./key.js";
import type { AcquireOptions, Lease, LeaseGrant } from "./lease.js";
import { generatedHolder, type FetchLike } from "./fiducia.js";

export interface UpstashRedisLeaseOptions {
  /** Upstash Redis REST URL, e.g. `https://...upstash.io`. */
  readonly restUrl: string;
  /** Upstash Redis REST token. Use a read/write token, never the readonly token. */
  readonly token: string;
  /** Prefix for authority keys. Defaults to `ores-locks`. */
  readonly namespace?: string;
  /** Swap the transport for tests/custom agents. Defaults to global `fetch`. */
  readonly fetch?: FetchLike;
  /** Source of holder ids when `AcquireOptions.holder` is absent. */
  readonly generateHolder?: () => string;
}

const MAX_FENCING_TOKEN = "9007199254740991";
const MAX_FENCING_TOKEN_BIGINT = BigInt(MAX_FENCING_TOKEN);

/**
 * Atomic acquire script for a Redis/Valkey authority. The fence counter is a
 * decimal string and is incremented digit-by-digit, avoiding Redis Lua's double
 * precision. The fourth result element is `1` only for a same-holder replay.
 */
export const REDIS_ACQUIRE_LUA = `
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
if string.len(next_token) > 16 or
   (string.len(next_token) == 16 and next_token > '${MAX_FENCING_TOKEN}') then
  return redis.error_reply('ores-locks: safe-integer fencing token exhausted')
end

redis.call('SET', fence_key, next_token)
redis.call('HSET', lock_key, 'holder', holder, 'token', next_token)
redis.call('PEXPIRE', lock_key, ttl_ms)
return {1, next_token, redis.call('PTTL', lock_key), 0}
`;

/** Atomic renewal: extend only the exact holder+token grant. */
export const REDIS_RENEW_LUA = `
local lock_key = KEYS[1]
local holder = ARGV[1]
local token = ARGV[2]
local ttl_ms = ARGV[3]
if redis.call('HGET', lock_key, 'holder') ~= holder then return {0, -2} end
if redis.call('HGET', lock_key, 'token') ~= token then return {0, -2} end
redis.call('PEXPIRE', lock_key, ttl_ms)
return {1, redis.call('PTTL', lock_key)}
`;

/** Atomic release: delete only the exact holder+token grant. */
export const REDIS_RELEASE_LUA = `
local lock_key = KEYS[1]
local holder = ARGV[1]
local token = ARGV[2]
if redis.call('HGET', lock_key, 'holder') ~= holder then return 0 end
if redis.call('HGET', lock_key, 'token') ~= token then return 0 end
return redis.call('DEL', lock_key)
`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validateTtl(key: LockKey, ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw LockError.invalidPlan(key, "redis lease ttlMs must be a positive safe integer");
  }
}

function utf8Hex(value: string): string {
  return Array.from(new TextEncoder().encode(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function redisKeys(namespace: string, key: LockKey): readonly [string, string] {
  // Both keys share the same Redis Cluster hash tag so EVAL stays single-slot.
  const tag = utf8Hex(key);
  return [`${namespace}:{${tag}}:lease`, `${namespace}:{${tag}}:fence`] as const;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function asFlag(value: unknown): boolean {
  return value === 1 || value === "1";
}

function asBigInt(value: unknown): bigint | undefined {
  let parsed: bigint;
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) parsed = BigInt(value);
  else if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) parsed = BigInt(value);
  else return undefined;
  return parsed <= MAX_FENCING_TOKEN_BIGINT ? parsed : undefined;
}

function asNonNegativeMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Concrete managed Redis `Lease` using Upstash's Redis-compatible REST API.
 *
 * The Lua scripts are ordinary Redis EVAL scripts and are also copied under
 * `managed/redis/` for Redis Cloud/Valkey callers using native RESP clients.
 * Upstash is used here because it gives this package a dependency-free HTTPS
 * transport suitable for Node, Workers, serverless and edge runtimes.
 */
export class UpstashRedisLease implements Lease {
  readonly #base: string;
  readonly #headers: Record<string, string>;
  readonly #namespace: string;
  readonly #fetch: FetchLike;
  readonly #generateHolder: () => string;

  constructor(options: UpstashRedisLeaseOptions) {
    this.#base = options.restUrl.replace(/\/+$/, "");
    this.#headers = {
      "content-type": "application/json",
      authorization: `Bearer ${options.token}`,
    };
    this.#namespace = options.namespace ?? "ores-locks";
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#generateHolder = options.generateHolder ?? generatedHolder;
  }

  async #command(key: LockKey, command: readonly unknown[]): Promise<unknown> {
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.#fetch(this.#base, {
        method: "POST",
        headers: this.#headers,
        body: JSON.stringify(command),
        redirect: "manual",
      });
    } catch (cause) {
      throw LockError.transport(key, cause);
    }
    const text = await response.text();
    if (response.status >= 300) {
      throw LockError.transport(key, new Error(`redis-rest: HTTP ${response.status}: ${text.trim()}`));
    }
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch (cause) {
      throw LockError.transport(key, new Error(`redis-rest: invalid JSON response: ${String(cause)}`));
    }
    if (!parsed || typeof parsed !== "object") {
      throw LockError.transport(key, new Error("redis-rest: response was not an object"));
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record["error"] === "string") {
      throw LockError.transport(key, new Error(`redis-rest: ${record["error"]}`));
    }
    return record["result"];
  }

  async acquire(key: LockKey, opts: AcquireOptions, wait: boolean): Promise<LeaseGrant> {
    validateTtl(key, opts.ttlMs);
    const holder = opts.holder ?? this.#generateHolder();
    const [lockKey, fenceKey] = redisKeys(this.#namespace, key);
    const started = Date.now();

    for (;;) {
      const raw = await this.#command(key, ["EVAL", REDIS_ACQUIRE_LUA, 2, lockKey, fenceKey, holder, opts.ttlMs]);
      const result = asArray(raw);
      if (!result || result.length < 2) {
        throw LockError.transport(key, new Error("redis-rest: malformed acquire result"));
      }
      if (asFlag(result[0])) {
        const fencingToken = asBigInt(result[1]);
        if (fencingToken === undefined) {
          throw LockError.transport(key, new Error("redis-rest: acquired without a valid fencing token"));
        }
        const pttl = asNonNegativeMs(result[2]);
        const grant: LeaseGrant = pttl === undefined
          ? { key, holder, fencingToken, ttlMs: opts.ttlMs }
          : { key, holder, fencingToken, ttlMs: opts.ttlMs, leaseExpiresMs: Date.now() + pttl };
        // A same-holder replay intentionally did not extend TTL in the acquire
        // script. Recover an ambiguous prior acquire with the only operation that
        // may extend authority: token-bound renewal.
        if (asFlag(result[3])) return this.renew(grant, opts.ttlMs);
        return grant;
      }
      if (!wait) throw LockError.contention(key, "fiducia.try_acquire");
      const waited = Date.now() - started;
      if (waited + opts.retryIntervalMs > opts.waitTimeoutMs) {
        throw LockError.timeout(key, "fiducia.acquire", waited);
      }
      await sleep(opts.retryIntervalMs);
    }
  }

  async renew(grant: LeaseGrant, ttlMs: number): Promise<LeaseGrant> {
    validateTtl(grant.key, ttlMs);
    const [lockKey] = redisKeys(this.#namespace, grant.key);
    const raw = await this.#command(grant.key, [
      "EVAL",
      REDIS_RENEW_LUA,
      1,
      lockKey,
      grant.holder,
      grant.fencingToken.toString(),
      ttlMs,
    ]);
    const result = asArray(raw);
    if (!result || result.length < 1) {
      throw LockError.transport(grant.key, new Error("redis-rest: malformed renew result"));
    }
    if (!asFlag(result[0])) {
      throw new LockError("lost_lease", grant.key, "redis: renewal refused; fenced authority is lost");
    }
    const pttl = asNonNegativeMs(result[1]);
    return pttl === undefined
      ? { ...grant, ttlMs }
      : { ...grant, ttlMs, leaseExpiresMs: Date.now() + pttl };
  }

  async release(grant: LeaseGrant): Promise<boolean> {
    const [lockKey] = redisKeys(this.#namespace, grant.key);
    try {
      const raw = await this.#command(grant.key, [
        "EVAL",
        REDIS_RELEASE_LUA,
        1,
        lockKey,
        grant.holder,
        grant.fencingToken.toString(),
      ]);
      return asFlag(raw);
    } catch (cause) {
      if (cause instanceof LockError && cause.step === undefined) cause.step = "fiducia.release";
      throw cause;
    }
  }
}
