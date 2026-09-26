import { LockError } from "./errors.js";
import type { LockKey } from "./key.js";
import type { AcquireOptions, Lease, LeaseGrant } from "./lease.js";
import { generatedHolder, generatedRequestId, type FetchLike } from "./fiducia.js";

export interface BeamScaleCriticalSectionLeaseOptions {
  readonly baseUrl: string;
  readonly apiToken: string;
  readonly deploymentId: string;
  readonly fetch?: FetchLike;
  readonly generateHolder?: () => string;
}

interface BeamScaleToken {
  readonly runtimeEpoch: number;
  readonly ownerEpoch: number;
  readonly sequence: number;
}

interface BeamScaleResult {
  readonly op?: unknown;
  readonly operation?: unknown;
  readonly ok?: unknown;
  readonly token?: unknown;
  readonly expires_at_ms?: unknown;
  readonly error_code?: unknown;
  readonly remaining_ms?: unknown;
}

const MAX_U64 = 18_446_744_073_709_551_615n;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function nonnegativeSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function decodeToken(value: unknown): BeamScaleToken | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const token = value as Record<string, unknown>;
  const runtimeEpoch = positiveSafeInteger(token["runtime_epoch"]);
  const ownerEpoch = positiveSafeInteger(token["owner_epoch"]);
  const sequence = positiveSafeInteger(token["sequence"]);
  if (runtimeEpoch === undefined || ownerEpoch === undefined || sequence === undefined) return undefined;
  if (BigInt(sequence) > MAX_U64) return undefined;
  return Object.freeze({ runtimeEpoch, ownerEpoch, sequence });
}

function sameToken(left: BeamScaleToken, right: BeamScaleToken): boolean {
  return left.runtimeEpoch === right.runtimeEpoch
    && left.ownerEpoch === right.ownerEpoch
    && left.sequence === right.sequence;
}

function tokenRegistryKey(key: LockKey, holder: string, fencingToken: bigint): string {
  return JSON.stringify([key, holder, fencingToken.toString()]);
}

/**
 * BeamScale Durable Object / critical-section lease adapter.
 *
 * The runtime authority token is (runtime_epoch, owner_epoch, sequence).
 * The shared Lease fencing watermark is sequence, which remains monotonic
 * across owner failover because the runtime persists it with lease state.
 * The complete token is retained internally for renew/release.
 *
 * Acquire carries a durable request id. One ambiguous transport failure is
 * retried with that same identity, allowing BeamScale to replay the committed
 * grant without minting a second fencing sequence. Repeated ambiguity remains
 * fail-closed.
 */
export class BeamScaleCriticalSectionLease implements Lease {
  readonly #base: string;
  readonly #headers: Record<string, string>;
  readonly #deploymentId: string;
  readonly #fetch: FetchLike;
  readonly #generateHolder: () => string;
  readonly #tokens = new Map<string, BeamScaleToken>();

  constructor(options: BeamScaleCriticalSectionLeaseOptions) {
    this.#base = options.baseUrl.replace(/\/+$/, "");
    if (!options.deploymentId || !/^[A-Za-z0-9._-]{1,128}$/.test(options.deploymentId)) {
      throw new Error("beamscale: deploymentId must match [A-Za-z0-9._-]{1,128}");
    }
    this.#deploymentId = options.deploymentId;
    this.#headers = {
      "content-type": "application/json",
      authorization: `Bearer ${options.apiToken}`,
    };
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#generateHolder = options.generateHolder ?? generatedHolder;
  }

  async #post(
    operation: "acquire" | "renew" | "release",
    key: LockKey,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: BeamScaleResult }> {
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.#fetch(
        `${this.#base}/v1/critical-sections/${encodeURIComponent(this.#deploymentId)}/${operation}`,
        {
          method: "POST",
          headers: this.#headers,
          body: JSON.stringify(body),
          redirect: "manual",
        },
      );
    } catch (cause) {
      throw LockError.transport(key, cause);
    }

    let parsed: BeamScaleResult = {};
    const text = await response.text();
    if (text) {
      try {
        const value: unknown = JSON.parse(text);
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new Error("response was not an object");
        }
        parsed = value as BeamScaleResult;
      } catch (cause) {
        throw LockError.transport(key, new Error(`beamscale: invalid JSON response: ${String(cause)}`));
      }
    }
    return { status: response.status, body: parsed };
  }

  #remember(key: LockKey, holder: string, token: BeamScaleToken): bigint {
    const fencingToken = BigInt(token.sequence);
    this.#tokens.set(tokenRegistryKey(key, holder, fencingToken), token);
    return fencingToken;
  }

  #lookup(grant: LeaseGrant): BeamScaleToken {
    const token = this.#tokens.get(tokenRegistryKey(grant.key, grant.holder, grant.fencingToken));
    if (!token) {
      throw new LockError(
        "lost_lease",
        grant.key,
        "beamscale: full authority token is unavailable for this grant; renew/release cannot be proven",
      );
    }
    return token;
  }

  async acquire(key: LockKey, opts: AcquireOptions, wait: boolean): Promise<LeaseGrant> {
    const holder = opts.holder ?? this.#generateHolder();
    const requestId = opts.requestId ?? generatedRequestId();
    const started = Date.now();
    let ambiguousRetries = 0;

    for (;;) {
      let result: { status: number; body: BeamScaleResult };
      try {
        result = await this.#post("acquire", key, {
          key,
          holder,
          request_id: requestId,
          lease_ms: opts.ttlMs,
        });
      } catch (cause) {
        const kind = cause && typeof cause === "object"
          ? (cause as { kind?: unknown }).kind
          : undefined;
        if (kind === "transport" && ambiguousRetries === 0) {
          ambiguousRetries += 1;
          continue;
        }
        throw cause;
      }

      const { status, body } = result;
      if (status >= 200 && status < 300 && body.ok === true) {
        const token = decodeToken(body.token);
        const leaseExpiresMs = nonnegativeSafeInteger(body.expires_at_ms);
        if (!token || leaseExpiresMs === undefined) {
          throw LockError.transport(key, new Error("beamscale: acquire returned an invalid grant"));
        }
        const fencingToken = this.#remember(key, holder, token);
        return Object.freeze({ key, holder, fencingToken, ttlMs: opts.ttlMs, leaseExpiresMs });
      }
      if (status === 409 && body.error_code === "busy") {
        if (!wait) throw LockError.contention(key, "fiducia.try_acquire");
        const waited = Date.now() - started;
        if (waited >= opts.waitTimeoutMs || waited + opts.retryIntervalMs > opts.waitTimeoutMs) {
          throw LockError.timeout(key, "fiducia.acquire", waited);
        }
        await sleep(opts.retryIntervalMs);
        continue;
      }
      throw LockError.transport(
        key,
        new Error(`beamscale: acquire rejected with HTTP ${status} / ${String(body.error_code ?? "unknown")}`),
      );
    }
  }

  async renew(grant: LeaseGrant, ttlMs: number): Promise<LeaseGrant> {
    const token = this.#lookup(grant);
    const { status, body } = await this.#post("renew", grant.key, {
      key: grant.key,
      holder: grant.holder,
      lease_ms: ttlMs,
      token: {
        runtime_epoch: token.runtimeEpoch,
        owner_epoch: token.ownerEpoch,
        sequence: token.sequence,
      },
    });
    if (status === 409 && body.error_code === "stale_or_not_owner") {
      this.#tokens.delete(tokenRegistryKey(grant.key, grant.holder, grant.fencingToken));
      throw new LockError(
        "lost_lease",
        grant.key,
        "beamscale: renewal refused; durable critical-section authority is lost",
      );
    }
    if (!(status >= 200 && status < 300) || body.ok !== true) {
      throw LockError.transport(
        grant.key,
        new Error(`beamscale: renew rejected with HTTP ${status} / ${String(body.error_code ?? "unknown")}`),
      );
    }
    const renewedToken = decodeToken(body.token);
    const leaseExpiresMs = nonnegativeSafeInteger(body.expires_at_ms);
    if (!renewedToken || !sameToken(token, renewedToken) || leaseExpiresMs === undefined) {
      this.#tokens.delete(tokenRegistryKey(grant.key, grant.holder, grant.fencingToken));
      throw new LockError(
        "lost_lease",
        grant.key,
        "beamscale: renewal changed or omitted the full fencing token",
      );
    }
    return Object.freeze({ ...grant, ttlMs, leaseExpiresMs });
  }

  async release(grant: LeaseGrant): Promise<boolean> {
    const registryKey = tokenRegistryKey(grant.key, grant.holder, grant.fencingToken);
    const token = this.#lookup(grant);
    try {
      const { status, body } = await this.#post("release", grant.key, {
        key: grant.key,
        holder: grant.holder,
        token: {
          runtime_epoch: token.runtimeEpoch,
          owner_epoch: token.ownerEpoch,
          sequence: token.sequence,
        },
      });
      if (status === 409 && body.error_code === "stale_or_not_owner") {
        this.#tokens.delete(registryKey);
        return false;
      }
      if (!(status >= 200 && status < 300) || body.ok !== true) {
        throw LockError.transport(
          grant.key,
          new Error(`beamscale: release rejected with HTTP ${status} / ${String(body.error_code ?? "unknown")}`),
        );
      }
      this.#tokens.delete(registryKey);
      return true;
    } catch (cause) {
      if (cause instanceof LockError && cause.step === undefined) cause.step = "fiducia.release";
      throw cause;
    }
  }
}
