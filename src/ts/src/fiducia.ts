/**
 * `Lease` over the fiducia-cloud lock HTTP protocol, using only `fetch`.
 *
 * The adapter deliberately keeps the small `Lease` surface while matching the
 * current fiducia-clients wire contract. In particular a blocking acquisition
 * has one stable request identity for its entire lifetime, carries the server
 * wait budget on every poll, renews the exact key set, and releases by fenced
 * grant identity rather than by a redundant member key.
 *
 * Prefer the public edge/load-balancer endpoint for hosted traffic so Fiducia's
 * HTTP idempotency/replay boundary remains in front of the node. The internal
 * constructor is only for a trusted in-cluster hop.
 */

import { LockError } from "./errors.js";
import type { LockKey } from "./key.js";
import type { AcquireOptions, Lease, LeaseGrant } from "./lease.js";

export type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string; redirect: "manual" }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

export interface FiduciaLeaseOptions {
  /** Base URL of the Fiducia edge/load balancer, or a trusted in-cluster node endpoint. */
  readonly baseUrl: string;
  /** Trusted internal hop: `x-fiducia-internal-auth` + `x-fiducia-org-id`. */
  readonly internal?: { readonly secret: string; readonly orgId: string };
  /** Public edge: `Authorization: Bearer`. */
  readonly apiKey?: string;
  /** Send a credential over cleartext http to a non-local host. Only for fully trusted paths. */
  readonly allowCleartextInternal?: boolean;
  /** Swap the transport (tests, custom agents). Defaults to global `fetch`. */
  readonly fetch?: FetchLike;
  /** Source of holder ids when `AcquireOptions.holder` is absent. */
  readonly generateHolder?: () => string;
}

const LOCAL_SUFFIXES = [".svc", ".cluster.local", ".internal", ".local"];
const MAX_ERROR_BODY_CHARS = 8_192;

export function cleartextRefusal(baseUrl: string, hasCredential: boolean, allow: boolean): string | undefined {
  if (!hasCredential || allow || !baseUrl.startsWith("http://")) return undefined;
  const host = new URL(baseUrl).hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1") return undefined;
  if (LOCAL_SUFFIXES.some((s) => host.endsWith(s))) return undefined;
  return `fiducia: refusing to send a credential over cleartext http to "${host}"; use https or allowCleartextInternal`;
}

function randomIdentity(prefix: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** An unguessable holder identity; holder names carry ownership authority. */
export function generatedHolder(): string {
  return randomIdentity("ores-locks-");
}

/** Per-acquisition identity. It must remain distinct from the holder identity. */
function generatedRequestId(): string {
  return randomIdentity("ores-lock-request-");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asUint(value: unknown): bigint | undefined {
  // JSON.parse has already rounded an unsafe numeric literal. Refuse it rather
  // than renew/release a different fencing token. Decimal strings remain
  // accepted for a future lossless Fiducia wire revision.
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === "bigint" && value >= 0n) return value;
  return undefined;
}

function encodeWireInteger(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(
      `fiducia: fencing token ${value} cannot be represented exactly by the current numeric JSON wire format`,
    );
  }
  return Number(value);
}

function boundedErrorBody(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_ERROR_BODY_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_ERROR_BODY_CHARS)}…`;
}

export class FiduciaLease implements Lease {
  readonly #base: string;
  readonly #headers: Record<string, string>;
  readonly #fetch: FetchLike;
  readonly #refusal: string | undefined;
  readonly #generateHolder: () => string;

  constructor(options: FiduciaLeaseOptions) {
    this.#base = options.baseUrl.replace(/\/+$/, "");
    this.#headers = { "content-type": "application/json" };
    if (options.internal) {
      this.#headers["x-fiducia-internal-auth"] = options.internal.secret;
      this.#headers["x-fiducia-org-id"] = options.internal.orgId;
    }
    if (options.apiKey) this.#headers["authorization"] = `Bearer ${options.apiKey}`;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#refusal = cleartextRefusal(this.#base, Boolean(options.internal || options.apiKey), options.allowCleartextInternal ?? false);
    this.#generateHolder = options.generateHolder ?? generatedHolder;
  }

  /** POST `body`, return `result.output`. Redirects stay disabled at the transport boundary. */
  async #post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.#refusal) throw new Error(this.#refusal);
    const response = await this.#fetch(this.#base + path, {
      method: "POST",
      headers: this.#headers,
      body: JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? encodeWireInteger(v) : v)),
      redirect: "manual",
    });
    const text = await response.text();
    if (response.status >= 300) throw new Error(`fiducia: HTTP ${response.status}: ${boundedErrorBody(text)}`);
    if (!text) return {};
    const parsed: unknown = JSON.parse(text);
    const output = (parsed as { result?: { output?: unknown } })?.result?.output;
    return output && typeof output === "object" ? (output as Record<string, unknown>) : {};
  }

  async acquire(key: LockKey, opts: AcquireOptions, wait: boolean): Promise<LeaseGrant> {
    const holder = opts.holder ?? this.#generateHolder();
    // One identity for the complete logical acquire. Reusing it across polls is
    // what lets Fiducia preserve FIFO position and deduplicate retries.
    const requestId = generatedRequestId();
    const started = Date.now();
    let attempt = 0;

    for (;;) {
      let out: Record<string, unknown>;
      try {
        out = await this.#post("/v1/locks/acquire", {
          key,
          holder,
          ttl_ms: opts.ttlMs,
          wait,
          wait_timeout_ms: wait ? opts.waitTimeoutMs : undefined,
          request_id: requestId,
        });
      } catch (cause) {
        // A transport failure is ownership-ambiguous. Never convert it into
        // contention; the caller must not perform guarded work.
        throw LockError.transport(key, cause);
      }

      if (out["acquired"] === true) {
        const fencingToken = asUint(out["fencing_token"]);
        if (fencingToken === undefined || fencingToken === 0n) {
          throw LockError.transport(key, new Error("fiducia: acquired without a positive fencing token"));
        }

        let expires = asUint(out["lease_expires_ms"]);
        // A grant discovered by a retry can be older than this response. Prove
        // current fenced authority before returning it to application work,
        // matching the official high-level clients' safety rule.
        if (attempt > 0 || out["renewed"] === false) {
          const renewed = await this.renew(
            { key, holder, fencingToken, ttlMs: opts.ttlMs, ...(expires === undefined ? {} : { leaseExpiresMs: Number(expires) }) },
            opts.ttlMs,
          );
          expires = renewed.leaseExpiresMs === undefined ? undefined : BigInt(renewed.leaseExpiresMs);
        }

        return expires === undefined
          ? { key, holder, fencingToken, ttlMs: opts.ttlMs }
          : { key, holder, fencingToken, ttlMs: opts.ttlMs, leaseExpiresMs: Number(expires) };
      }

      if (!wait) throw LockError.contention(key, "fiducia.try_acquire");
      const waited = Date.now() - started;
      if (waited + opts.retryIntervalMs > opts.waitTimeoutMs) {
        throw LockError.timeout(key, "fiducia.acquire", waited);
      }
      attempt += 1;
      await sleep(opts.retryIntervalMs);
    }
  }

  async renew(grant: LeaseGrant, ttlMs: number): Promise<LeaseGrant> {
    let out: Record<string, unknown>;
    try {
      out = await this.#post("/v1/locks/renew", {
        keys: [grant.key],
        holder: grant.holder,
        fencing_token: grant.fencingToken,
        ttl_ms: ttlMs,
      });
    } catch (cause) {
      throw LockError.transport(grant.key, cause);
    }
    if (out["renewed"] !== true) {
      throw new LockError("lost_lease", grant.key, "fiducia: lock renewal lost fenced authority");
    }
    const expires = asUint(out["lease_expires_ms"]);
    return expires === undefined ? { ...grant, ttlMs } : { ...grant, ttlMs, leaseExpiresMs: Number(expires) };
  }

  async release(grant: LeaseGrant): Promise<boolean> {
    try {
      const out = await this.#post("/v1/locks/release", {
        holder: grant.holder,
        fencing_token: grant.fencingToken,
      });
      return out["released"] === true;
    } catch (cause) {
      throw LockError.transport(grant.key, cause, "fiducia.release");
    }
  }
}
