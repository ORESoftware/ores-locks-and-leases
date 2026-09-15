import { LockError } from "./errors.js";
import type { LockKey } from "./key.js";
import type { AcquireOptions, Lease, LeaseGrant } from "./lease.js";
import type { LockStep } from "./plan.js";
import { generatedHolder } from "./fiducia.js";
import type {
  CloudflareDurableObjectRpcNamespace,
  CloudflareDurableObjectRpcStub,
} from "./cloudflare-do-rpc-types.js";

export interface CloudflareDurableObjectRpcLeaseOptions {
  readonly namespace: CloudflareDurableObjectRpcNamespace;
  readonly generateHolder?: () => string;
  /** Stable id for one logical acquire across retries. */
  readonly generateRequestId?: () => string;
}

const MAX_FENCING_TOKEN = BigInt(Number.MAX_SAFE_INTEGER);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asBigInt(value: unknown): bigint | undefined {
  let parsed: bigint;
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) parsed = BigInt(value);
  else if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) parsed = BigInt(value);
  else return undefined;
  return parsed <= MAX_FENCING_TOKEN ? parsed : undefined;
}

function asSafeMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function defaultRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return generatedHolder();
}

function authorityError(key: LockKey, code: string): LockError {
  if (code === "fencing_token_exhausted") {
    return LockError.transport(key, new Error("cloudflare-do-rpc: fencing token domain exhausted"));
  }
  return LockError.invalidPlan(key, `cloudflare-do-rpc rejected typed request: ${code}`);
}

/** Direct Workers-RPC Lease adapter for a bound Durable Object namespace. */
export class CloudflareDurableObjectRpcLease implements Lease {
  readonly #namespace: CloudflareDurableObjectRpcNamespace;
  readonly #generateHolder: () => string;
  readonly #generateRequestId: () => string;

  constructor(options: CloudflareDurableObjectRpcLeaseOptions) {
    this.#namespace = options.namespace;
    this.#generateHolder = options.generateHolder ?? generatedHolder;
    this.#generateRequestId = options.generateRequestId ?? defaultRequestId;
  }

  async #call<T>(
    key: LockKey,
    step: LockStep,
    invoke: (stub: CloudflareDurableObjectRpcStub) => Promise<T>,
  ): Promise<T> {
    try {
      // RPC exceptions invalidate that stub; reacquire a stub for every call.
      return await invoke(this.#namespace.getByName(key));
    } catch (cause) {
      throw LockError.transport(key, cause, step);
    }
  }

  async acquire(key: LockKey, opts: AcquireOptions, wait: boolean): Promise<LeaseGrant> {
    const holder = opts.holder ?? this.#generateHolder();
    const requestId = opts.requestId ?? this.#generateRequestId();
    const started = Date.now();
    const step: LockStep = wait ? "fiducia.acquire" : "fiducia.try_acquire";

    for (;;) {
      const out = await this.#call(key, step, (stub) => stub.acquire({
        holder,
        ttl_ms: opts.ttlMs,
        request_id: requestId,
      }));
      if ("error" in out) throw authorityError(key, out.error);
      if (out.acquired) {
        const fencingToken = asBigInt(out.fencing_token);
        const leaseExpiresMs = asSafeMs(out.lease_expires_ms);
        if (fencingToken === undefined || leaseExpiresMs === undefined) {
          throw LockError.transport(key, new Error("cloudflare-do-rpc: malformed acquired grant"), step);
        }
        const grant: LeaseGrant = { key, holder, fencingToken, ttlMs: opts.ttlMs, leaseExpiresMs };
        if (out.replayed) return this.renew(grant, opts.ttlMs);
        return grant;
      }

      if (!wait) throw LockError.contention(key, step);
      const waited = Date.now() - started;
      if (waited + opts.retryIntervalMs > opts.waitTimeoutMs) {
        throw LockError.timeout(key, step, waited);
      }
      await sleep(opts.retryIntervalMs);
    }
  }

  async renew(grant: LeaseGrant, ttlMs: number): Promise<LeaseGrant> {
    const out = await this.#call(grant.key, "fiducia.renew", (stub) => stub.renew({
      holder: grant.holder,
      fencing_token: grant.fencingToken.toString(),
      ttl_ms: ttlMs,
    }));
    if ("error" in out) throw authorityError(grant.key, out.error);
    if (!out.renewed) {
      throw new LockError("lost_lease", grant.key, `cloudflare-do-rpc: renewal refused (${out.reason})`, {
        step: "fiducia.renew",
      });
    }
    const leaseExpiresMs = asSafeMs(out.lease_expires_ms);
    if (leaseExpiresMs === undefined) {
      throw LockError.transport(grant.key, new Error("cloudflare-do-rpc: malformed renewal"), "fiducia.renew");
    }
    return { ...grant, ttlMs, leaseExpiresMs };
  }

  async release(grant: LeaseGrant): Promise<boolean> {
    const out = await this.#call(grant.key, "fiducia.release", (stub) => stub.release({
      holder: grant.holder,
      fencing_token: grant.fencingToken.toString(),
    }));
    if ("error" in out) throw authorityError(grant.key, out.error);
    return out.released;
  }
}
