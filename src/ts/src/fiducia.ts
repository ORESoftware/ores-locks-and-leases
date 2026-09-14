/**
 * `Lease` over the fiducia-cloud node HTTP protocol, using only `fetch`. It
 * speaks the same lock endpoints the official clients do. Blocking acquisition
 * keeps one stable request_id across polls and explicit cancellation so timeout
 * or caller cancellation can safely reconcile a raced grant before returning.
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
  /** Source of stable logical acquisition ids when `AcquireOptions.requestId` is absent. */
  readonly generateRequestId?: () => string;
}

const LOCAL_SUFFIXES = [".svc", ".cluster.local", ".internal", ".local"];

export function cleartextRefusal(baseUrl: string, hasCredential: boolean, allow: boolean): string | undefined {
  if (!hasCredential || allow || !baseUrl.startsWith("http://")) return undefined;
  const host = new URL(baseUrl).hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1") return undefined;
  if (LOCAL_SUFFIXES.some((s) => host.endsWith(s))) return undefined;
  return `fiducia: refusing to send a credential over cleartext http to "${host}"; use https or allowCleartextInternal`;
}

function generatedIdentity(prefix: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** An unguessable holder identity; holder names carry queue identity and cancellation authority. */
export function generatedHolder(): string {
  return generatedIdentity("ores-locks-");
}

/** Stable per-acquisition identity used by acquire polling and `/v1/locks/cancel`. */
export function generatedRequestId(): string {
  return generatedIdentity("ores-lock-request-");
}

function sleepOrAbort(ms: number, signal: AbortSignal | undefined): Promise<"elapsed" | "aborted"> {
  if (signal?.aborted) return Promise.resolve("aborted");
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve("elapsed");
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve("aborted");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function asUint(value: unknown): bigint | undefined {
  // JSON.parse has already rounded an unsafe numeric literal. Refuse it
  // rather than release or renew a different fencing token. Decimal strings
  // remain accepted for a future lossless Fiducia wire revision.
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

function cancelledCause(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("fiducia: acquisition cancelled by caller");
}

export class FiduciaLease implements Lease {
  readonly #base: string;
  readonly #headers: Record<string, string>;
  readonly #fetch: FetchLike;
  readonly #refusal: string | undefined;
  readonly #generateHolder: () => string;
  readonly #generateRequestId: () => string;

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
    this.#generateRequestId = options.generateRequestId ?? generatedRequestId;
  }

  /** POST `body`, return `result.output`. Non-2xx and transport failures throw plain Errors; callers map them. */
  async #post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.#refusal) throw new Error(this.#refusal);
    const response = await this.#fetch(this.#base + path, {
      method: "POST",
      headers: this.#headers,
      body: JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? encodeWireInteger(v) : v)),
      redirect: "manual",
    });
    const text = await response.text();
    if (response.status >= 300) throw new Error(`fiducia: HTTP ${response.status}: ${text.trim()}`);
    if (!text) return {};
    const parsed: unknown = JSON.parse(text);
    const output = (parsed as { result?: { output?: unknown } })?.result?.output;
    return output && typeof output === "object" ? (output as Record<string, unknown>) : {};
  }

  /**
   * Establish a safe terminal state for a queued acquisition. A cancellation
   * response may report that promotion won the race; that grant must be
   * released by its exact holder + fencing token before cancellation returns.
   */
  async #cancelQueuedAcquire(key: LockKey, holder: string, requestId: string): Promise<void> {
    const out = await this.#post("/v1/locks/cancel", {
      keys: [key],
      holder,
      request_id: requestId,
    });

    if (out["cancelled"] === true && out["acquired"] !== true) return;
    if (out["acquired"] !== true) {
      throw new Error("fiducia: cancel did not establish a safe terminal acquisition state");
    }

    const grant = out["grant"];
    if (!grant || typeof grant !== "object") {
      throw new Error("fiducia: cancel reported a raced grant without grant authority");
    }
    const raced = grant as Record<string, unknown>;
    const racedHolder = raced["holder"];
    const fencingToken = asUint(raced["fencing_token"]);
    if (racedHolder !== holder || fencingToken === undefined || fencingToken === 0n) {
      throw new Error("fiducia: cancel returned mismatched or malformed raced-grant authority");
    }

    const released = await this.#post("/v1/locks/release", {
      key,
      holder,
      fencing_token: fencingToken,
    });
    if (released["released"] !== true) {
      throw new Error("fiducia: raced grant release was a no-op; ownership safety is unknown");
    }
  }

  async #cancelBeforeTerminal(
    key: LockKey,
    holder: string,
    requestId: string,
    terminal: LockError,
  ): Promise<never> {
    try {
      await this.#cancelQueuedAcquire(key, holder, requestId);
    } catch (cause) {
      throw LockError.transport(key, cause, "fiducia.acquire");
    }
    throw terminal;
  }

  async acquire(key: LockKey, opts: AcquireOptions, wait: boolean): Promise<LeaseGrant> {
    const holder = opts.holder ?? this.#generateHolder();
    const requestId = opts.requestId ?? this.#generateRequestId();
    const started = Date.now();
    let attempted = false;

    for (;;) {
      if (opts.signal?.aborted) {
        if (!attempted) throw LockError.transport(key, cancelledCause(opts.signal), "fiducia.acquire");
        return this.#cancelBeforeTerminal(
          key,
          holder,
          requestId,
          LockError.transport(key, cancelledCause(opts.signal), "fiducia.acquire"),
        );
      }

      let out: Record<string, unknown>;
      try {
        attempted = true;
        out = await this.#post("/v1/locks/acquire", {
          key,
          holder,
          ttl_ms: opts.ttlMs,
          request_id: requestId,
          ...(wait ? { wait_timeout_ms: opts.waitTimeoutMs } : {}),
        });
      } catch (cause) {
        throw LockError.transport(key, cause);
      }
      if (out["acquired"] === true) {
        const fencingToken = asUint(out["fencing_token"]);
        if (fencingToken === undefined || fencingToken === 0n) {
          throw LockError.transport(key, new Error("fiducia: acquired without a positive fencing token"));
        }
        const expires = asUint(out["lease_expires_ms"]);
        return expires === undefined
          ? { key, holder, fencingToken, ttlMs: opts.ttlMs }
          : { key, holder, fencingToken, ttlMs: opts.ttlMs, leaseExpiresMs: Number(expires) };
      }
      if (!wait) throw LockError.contention(key, "fiducia.try_acquire");

      // Cancellation that arrives while the acquire request is in flight wins
      // over the local timeout budget. Reconcile the exact logical request
      // before reporting the caller's cancellation.
      if (opts.signal?.aborted) {
        return this.#cancelBeforeTerminal(
          key,
          holder,
          requestId,
          LockError.transport(key, cancelledCause(opts.signal), "fiducia.acquire"),
        );
      }

      const waited = Date.now() - started;
      if (waited + opts.retryIntervalMs > opts.waitTimeoutMs) {
        return this.#cancelBeforeTerminal(
          key,
          holder,
          requestId,
          LockError.timeout(key, "fiducia.acquire", waited),
        );
      }

      const sleep = await sleepOrAbort(opts.retryIntervalMs, opts.signal);
      if (sleep === "aborted" && opts.signal) {
        return this.#cancelBeforeTerminal(
          key,
          holder,
          requestId,
          LockError.transport(key, cancelledCause(opts.signal), "fiducia.acquire"),
        );
      }
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
