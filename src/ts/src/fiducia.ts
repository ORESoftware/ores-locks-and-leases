/**
 * `Lease` over the fiducia-cloud node HTTP protocol, using only `fetch`. It
 * speaks the same three endpoints the official clients do
 * (`/v1/locks/acquire`, `/v1/locks/renew`, `/v1/locks/release`) with the
 * same headers, so a service that already holds a `@fiducia/client` keeps it
 * for everything else and hands this adapter the same base URL and
 * credentials.
 *
 * The node never holds a request open: `acquire` returns at once with
 * `acquired: false` when the key is held, so the client owns the wait. This
 * adapter polls at `retryIntervalMs` until the grant arrives or
 * `waitTimeoutMs` elapses.
 */

import { LockError } from "./errors.js";
import type { LockKey } from "./key.js";
import type { AcquireOptions, Lease, LeaseGrant } from "./lease.js";

export type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string; redirect: "manual" }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

export interface FiduciaLeaseOptions {
  /** Base URL of the fiducia node or edge, e.g. `https://fiducia.example` or `http://localhost:8090`. */
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

export function cleartextRefusal(baseUrl: string, hasCredential: boolean, allow: boolean): string | undefined {
  if (!hasCredential || allow || !baseUrl.startsWith("http://")) return undefined;
  const host = new URL(baseUrl).hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1") return undefined;
  if (LOCAL_SUFFIXES.some((s) => host.endsWith(s))) return undefined;
  return `fiducia: refusing to send a credential over cleartext http to "${host}"; use https or allowCleartextInternal`;
}

/** An unguessable holder identity; holder names carry queue identity and cancellation authority. */
export function generatedHolder(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return "ores-locks-" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asUint(value: unknown): bigint | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === "bigint" && value >= 0n) return value;
  return undefined;
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

  /** POST `body`, return `result.output`. Non-2xx and transport failures throw plain Errors; callers map them. */
  async #post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.#refusal) throw new Error(this.#refusal);
    const response = await this.#fetch(this.#base + path, {
      method: "POST",
      headers: this.#headers,
      body: JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? Number(v) : v)),
      redirect: "manual",
    });
    const text = await response.text();
    if (response.status >= 300) throw new Error(`fiducia: HTTP ${response.status}: ${text.trim()}`);
    if (!text) return {};
    const parsed: unknown = JSON.parse(text);
    const output = (parsed as { result?: { output?: unknown } })?.result?.output;
    return output && typeof output === "object" ? (output as Record<string, unknown>) : {};
  }

  async acquire(key: LockKey, opts: AcquireOptions, wait: boolean): Promise<LeaseGrant> {
    const holder = opts.holder ?? this.#generateHolder();
    const started = Date.now();
    for (;;) {
      let out: Record<string, unknown>;
      try {
        out = await this.#post("/v1/locks/acquire", { key, holder, ttl_ms: opts.ttlMs });
      } catch (cause) {
        throw LockError.transport(key, cause);
      }
      if (out["acquired"] === true) {
        const fencingToken = asUint(out["fencing_token"]);
        if (fencingToken === undefined) throw LockError.transport(key, new Error("fiducia: acquired without a fencing token"));
        const expires = asUint(out["lease_expires_ms"]);
        return expires === undefined
          ? { key, holder, fencingToken, ttlMs: opts.ttlMs }
          : { key, holder, fencingToken, ttlMs: opts.ttlMs, leaseExpiresMs: Number(expires) };
      }
      if (!wait) throw LockError.contention(key, "fiducia.try_acquire");
      const waited = Date.now() - started;
      if (waited + opts.retryIntervalMs > opts.waitTimeoutMs) throw LockError.timeout(key, "fiducia.acquire", waited);
      await sleep(opts.retryIntervalMs);
    }
  }

  async renew(grant: LeaseGrant, ttlMs: number): Promise<LeaseGrant> {
    let out: Record<string, unknown>;
    try {
      out = await this.#post("/v1/locks/renew", { key: grant.key, holder: grant.holder, fencing_token: grant.fencingToken, ttl_ms: ttlMs });
    } catch (cause) {
      throw LockError.transport(grant.key, cause);
    }
    // `renewed: false` is lost fenced authority: fiducia has already reaped the
    // grant and may have promoted another holder.
    if (out["renewed"] !== true) throw new LockError("lost_lease", grant.key, "fiducia: lock renewal lost fenced authority");
    const expires = asUint(out["lease_expires_ms"]);
    return expires === undefined ? { ...grant, ttlMs } : { ...grant, ttlMs, leaseExpiresMs: Number(expires) };
  }

  async release(grant: LeaseGrant): Promise<boolean> {
    try {
      const out = await this.#post("/v1/locks/release", { key: grant.key, holder: grant.holder, fencing_token: grant.fencingToken });
      return out["released"] === true;
    } catch (cause) {
      throw LockError.transport(grant.key, cause, "fiducia.release");
    }
  }
}
