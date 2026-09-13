import { LockError } from "./errors.js";
import type { LockKey } from "./key.js";
import type { AcquireOptions, Lease, LeaseGrant } from "./lease.js";
import { generatedHolder, type FetchLike } from "./fiducia.js";

export interface CloudflareDurableObjectLeaseOptions {
  /** Public URL of the Worker that fronts the Durable Object namespace. */
  readonly baseUrl: string;
  /** Bearer secret configured as `ORES_LOCKS_API_TOKEN` on the Worker. */
  readonly apiToken: string;
  /** Swap the transport for tests/custom agents. Defaults to global `fetch`. */
  readonly fetch?: FetchLike;
  /** Source of holder ids when `AcquireOptions.holder` is absent. */
  readonly generateHolder?: () => string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asBigInt(value: unknown): bigint | undefined {
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return undefined;
}

function asSafeMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return undefined;
}

/**
 * `Lease` backed by the deployable Cloudflare Durable Object authority in
 * `managed/cloudflare-do`.
 *
 * One lock key maps to one Durable Object instance. That instance persists the
 * current holder, TTL, and a decimal-string fencing counter in strongly
 * consistent storage. Fencing tokens stay strings on JSON boundaries so the
 * full unsigned-64 domain is never rounded by JavaScript.
 */
export class CloudflareDurableObjectLease implements Lease {
  readonly #base: string;
  readonly #headers: Record<string, string>;
  readonly #fetch: FetchLike;
  readonly #generateHolder: () => string;

  constructor(options: CloudflareDurableObjectLeaseOptions) {
    this.#base = options.baseUrl.replace(/\/+$/, "");
    this.#headers = {
      "content-type": "application/json",
      authorization: `Bearer ${options.apiToken}`,
    };
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#generateHolder = options.generateHolder ?? generatedHolder;
  }

  async #post(path: string, key: LockKey, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.#fetch(this.#base + path, {
        method: "POST",
        headers: this.#headers,
        body: JSON.stringify(body, (_key, value) => (typeof value === "bigint" ? value.toString() : value)),
        redirect: "manual",
      });
    } catch (cause) {
      throw LockError.transport(key, cause);
    }

    const text = await response.text();
    if (response.status >= 300) {
      throw LockError.transport(key, new Error(`cloudflare-do: HTTP ${response.status}: ${text.trim()}`));
    }
    if (!text) return {};
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object") throw new Error("response was not an object");
      return parsed as Record<string, unknown>;
    } catch (cause) {
      throw LockError.transport(key, new Error(`cloudflare-do: invalid JSON response: ${String(cause)}`));
    }
  }

  async acquire(key: LockKey, opts: AcquireOptions, wait: boolean): Promise<LeaseGrant> {
    const holder = opts.holder ?? this.#generateHolder();
    const started = Date.now();
    for (;;) {
      const out = await this.#post("/v1/leases/acquire", key, { key, holder, ttl_ms: opts.ttlMs });
      if (out["acquired"] === true) {
        const fencingToken = asBigInt(out["fencing_token"]);
        if (fencingToken === undefined) {
          throw LockError.transport(key, new Error("cloudflare-do: acquired without a valid fencing token"));
        }
        const leaseExpiresMs = asSafeMs(out["lease_expires_ms"]);
        return leaseExpiresMs === undefined
          ? { key, holder, fencingToken, ttlMs: opts.ttlMs }
          : { key, holder, fencingToken, ttlMs: opts.ttlMs, leaseExpiresMs };
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
    const out = await this.#post("/v1/leases/renew", grant.key, {
      key: grant.key,
      holder: grant.holder,
      fencing_token: grant.fencingToken.toString(),
      ttl_ms: ttlMs,
    });
    if (out["renewed"] !== true) {
      throw new LockError("lost_lease", grant.key, "cloudflare-do: renewal refused; fenced authority is lost");
    }
    const leaseExpiresMs = asSafeMs(out["lease_expires_ms"]);
    return leaseExpiresMs === undefined ? { ...grant, ttlMs } : { ...grant, ttlMs, leaseExpiresMs };
  }

  async release(grant: LeaseGrant): Promise<boolean> {
    try {
      const out = await this.#post("/v1/leases/release", grant.key, {
        key: grant.key,
        holder: grant.holder,
        fencing_token: grant.fencingToken.toString(),
      });
      return out["released"] === true;
    } catch (cause) {
      if (cause instanceof LockError && cause.step === undefined) cause.step = "fiducia.release";
      throw cause;
    }
  }
}
