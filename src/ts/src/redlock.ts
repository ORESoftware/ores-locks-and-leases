import { LockError } from "./errors.js";
import type { LockKey } from "./key.js";
import type { AcquireOptions, Lease, LeaseGrant } from "./lease.js";

/**
 * Structural subset of the lock object exposed by common Redlock clients.
 * `expiration` is the Redlock library's already drift-adjusted Unix epoch in
 * milliseconds. It is required: fabricating `now + ttl` after acquisition can
 * overstate authority when quorum acquisition or fencing-token minting was slow.
 */
export interface RedlockHandle {
  readonly expiration: number;
  extend(ttlMs: number): Promise<RedlockHandle>;
  release(): Promise<unknown>;
}

/** Configure the underlying Redlock library with no/low internal retries. */
export interface RedlockClient {
  acquire(resources: readonly string[], ttlMs: number): Promise<RedlockHandle>;
}

/**
 * Strongly ordered source of fencing tokens.
 *
 * Implementations MUST return a token strictly greater than every token they
 * previously returned for the same key, including across process restarts and
 * failover. A process-local counter, wall clock, random UUID, or the Redlock
 * random lock value is not sufficient.
 */
export interface FencingTokenAuthority {
  nextFencingToken(
    key: LockKey,
    holder: string,
    requestId?: string,
  ): Promise<bigint>;
}

export type RedlockAcquireErrorKind = "contention" | "transport";

export interface FencedRedlockLeaseOptions {
  readonly redlock: RedlockClient;
  readonly fencing: FencingTokenAuthority;
  /**
   * Redlock libraries surface quorum contention and transport failures through
   * library-specific exceptions. Classify them here instead of guessing from
   * error strings. Defaults to `contention`, which is conservative for a clean
   * quorum refusal but should be overridden for production network clients.
   */
  readonly classifyAcquireError?: (error: unknown) => RedlockAcquireErrorKind;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

type HeldRedlock = {
  handle: RedlockHandle;
  grant: LeaseGrant;
};

function grantId(grant: Pick<LeaseGrant, "key" | "holder" | "fencingToken">): string {
  return `${grant.key}\u0000${grant.holder}\u0000${grant.fencingToken.toString(10)}`;
}

function generatedHolder(): string {
  return `redlock-${globalThis.crypto.randomUUID()}`;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validExpiration(expiration: number, now: number): boolean {
  return Number.isSafeInteger(expiration) && expiration > now;
}

async function releaseBestEffort(handle: RedlockHandle): Promise<void> {
  try {
    await handle.release();
  } catch {
    // The TTL remains the final cleanup bound. The caller receives no grant.
  }
}

/**
 * Redlock + independent fencing-token authority exposed through the common
 * `Lease` contract.
 *
 * Ordering is intentionally strict:
 *
 *   Redlock quorum acquire -> mint monotonic fence -> re-check lease expiry -> guarded work
 *
 * If token minting fails, or the Redlock validity window expires while the
 * token is being minted, the handle is released best-effort and no grant is
 * returned. Renewals extend only the existing Redlock lease and NEVER mint a
 * new token. A new token is minted only after a new acquisition.
 */
export class FencedRedlockLease implements Lease {
  readonly #redlock: RedlockClient;
  readonly #fencing: FencingTokenAuthority;
  readonly #classifyAcquireError: (error: unknown) => RedlockAcquireErrorKind;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #held = new Map<string, HeldRedlock>();

  constructor(options: FencedRedlockLeaseOptions) {
    this.#redlock = options.redlock;
    this.#fencing = options.fencing;
    this.#classifyAcquireError = options.classifyAcquireError ?? (() => "contention");
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  async acquire(key: LockKey, opts: AcquireOptions, wait: boolean): Promise<LeaseGrant> {
    if (!Number.isSafeInteger(opts.ttlMs) || opts.ttlMs <= 0) {
      throw LockError.invalidPlan(key, "Redlock ttlMs must be a positive safe integer");
    }
    if (!Number.isSafeInteger(opts.retryIntervalMs) || opts.retryIntervalMs < 0) {
      throw LockError.invalidPlan(key, "Redlock retryIntervalMs must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(opts.waitTimeoutMs) || opts.waitTimeoutMs < 0) {
      throw LockError.invalidPlan(key, "Redlock waitTimeoutMs must be a non-negative safe integer");
    }

    const holder = opts.holder ?? generatedHolder();
    const started = this.#now();

    for (;;) {
      let handle: RedlockHandle;
      try {
        handle = await this.#redlock.acquire([key.toString()], opts.ttlMs);
      } catch (error) {
        const kind = this.#classifyAcquireError(error);
        if (kind === "transport") {
          throw LockError.transport(key, error, wait ? "fiducia.acquire" : "fiducia.try_acquire");
        }
        if (!wait) {
          throw LockError.contention(key, "fiducia.try_acquire");
        }
        const waited = this.#now() - started;
        if (waited >= opts.waitTimeoutMs) {
          throw LockError.timeout(key, "fiducia.acquire", waited);
        }
        const remaining = opts.waitTimeoutMs - waited;
        await this.#sleep(Math.min(opts.retryIntervalMs, remaining));
        continue;
      }

      if (!validExpiration(handle.expiration, this.#now())) {
        await releaseBestEffort(handle);
        throw new LockError(
          "lost_lease",
          key,
          "Redlock grant was already expired or returned an invalid expiration",
        );
      }

      let fencingToken: bigint;
      try {
        fencingToken = await this.#fencing.nextFencingToken(key, holder, opts.requestId);
        if (fencingToken <= 0n) {
          throw new Error("fencing authority returned a non-positive token");
        }
      } catch (error) {
        await releaseBestEffort(handle);
        throw LockError.transport(key, error, "fiducia.acquire");
      }

      // Fencing allocation can itself block on a database/consensus authority.
      // Never begin guarded work if the Redlock validity window elapsed while
      // that stronger monotonic epoch was being allocated.
      if (!validExpiration(handle.expiration, this.#now())) {
        await releaseBestEffort(handle);
        throw new LockError(
          "lost_lease",
          key,
          "Redlock grant expired while allocating its fencing token",
        );
      }

      const grant: LeaseGrant = {
        key,
        holder,
        fencingToken,
        leaseExpiresMs: handle.expiration,
        ttlMs: opts.ttlMs,
      };
      this.#held.set(grantId(grant), { handle, grant });
      return grant;
    }
  }

  async renew(grant: LeaseGrant, ttlMs: number): Promise<LeaseGrant> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw LockError.invalidPlan(grant.key, "Redlock renewal ttlMs must be a positive safe integer");
    }
    const id = grantId(grant);
    const held = this.#held.get(id);
    if (!held) {
      throw new LockError(
        "lost_lease",
        grant.key,
        "Redlock grant is not held by this adapter instance; fenced authority is lost",
      );
    }

    let handle: RedlockHandle;
    try {
      handle = await held.handle.extend(ttlMs);
    } catch (error) {
      this.#held.delete(id);
      throw new LockError(
        "lost_lease",
        grant.key,
        `Redlock quorum refused renewal: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    if (!validExpiration(handle.expiration, this.#now())) {
      this.#held.delete(id);
      await releaseBestEffort(handle);
      throw new LockError(
        "lost_lease",
        grant.key,
        "Redlock renewal returned an already-expired or invalid validity window",
      );
    }

    const renewed: LeaseGrant = {
      ...grant,
      ttlMs,
      leaseExpiresMs: handle.expiration,
    };
    this.#held.set(id, { handle, grant: renewed });
    return renewed;
  }

  async release(grant: LeaseGrant): Promise<boolean> {
    const id = grantId(grant);
    const held = this.#held.get(id);
    if (!held) return false;

    try {
      await held.handle.release();
    } catch (error) {
      throw LockError.transport(grant.key, error, "fiducia.release");
    }
    this.#held.delete(id);
    return true;
  }
}
