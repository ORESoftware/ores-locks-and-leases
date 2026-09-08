/**
 * Fail-closed Fiducia + PostgreSQL transaction coordination.
 *
 * The legacy `withXactLock` API keeps its original behavior. This module adds
 * an opt-in path for long-running work: periodically renew the outer Fiducia
 * grant, require a final renewal immediately before commit, and roll back the
 * PostgreSQL transaction whenever fenced authority cannot be proven.
 */

import { LockError, cleanupFailure, tagStep } from "./errors.js";
import { advisoryKey, type LockKey } from "./key.js";
import {
  acquireLease,
  runWork,
  settle,
  settled,
  type AcquireOptions,
  type Lease,
  type LeaseGrant,
} from "./lease.js";
import type { PgPool, PgPoolClient, PgQueryable } from "./pg.js";

/** Renewal cadence for a maintained transaction. */
export interface LeaseMaintenanceOptions {
  /** Positive integer milliseconds, no greater than half of `ttlMs`. */
  readonly renewIntervalMs: number;
}

export const DEFAULT_LEASE_MAINTENANCE_OPTIONS: LeaseMaintenanceOptions = {
  renewIntervalMs: 20_000,
};

/** What maintained transaction work receives. */
export interface MaintainedXactGuarded {
  readonly key: LockKey;
  readonly grant: LeaseGrant;
  /** The checked-out client whose open transaction holds the advisory lock. */
  readonly client: PgQueryable;
  /** Aborted when periodic renewal fails; work should stop promptly. */
  readonly signal: AbortSignal;
}

/** Validate before acquiring either coordination layer. */
export function validateLeaseMaintenanceOptions(
  key: LockKey,
  acquire: AcquireOptions,
  maintenance: LeaseMaintenanceOptions,
  wait: boolean,
): void {
  requirePositiveInteger(key, acquire.ttlMs, "fiducia lease TTL");
  requirePositiveInteger(key, maintenance.renewIntervalMs, "fiducia renewal interval");
  if (maintenance.renewIntervalMs > acquire.ttlMs / 2) {
    throw LockError.invalidPlan(
      key,
      `fiducia renewal interval ${maintenance.renewIntervalMs} ms is unsafe for TTL ${acquire.ttlMs} ms; it must be no greater than half the TTL`,
    );
  }
  if (!Number.isSafeInteger(acquire.waitTimeoutMs) || acquire.waitTimeoutMs < 0) {
    throw LockError.invalidPlan(key, "PostgreSQL advisory-lock wait timeout must be a non-negative safe integer");
  }
  if (wait) requirePositiveInteger(key, acquire.retryIntervalMs, "PostgreSQL advisory-lock retry interval");
}

function requirePositiveInteger(key: LockKey, value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw LockError.invalidPlan(key, `${name} must be a positive safe integer number of milliseconds`);
  }
}

function renewalError(key: LockKey, cause: unknown): LockError {
  const error = cause instanceof LockError ? cause : LockError.transport(key, cause);
  tagStep(error, "fiducia.renew");
  return error;
}

async function renewChecked(lease: Lease, original: LeaseGrant, ttlMs: number): Promise<LeaseGrant> {
  let renewed: LeaseGrant;
  try {
    renewed = await lease.renew(original, ttlMs);
  } catch (cause) {
    throw renewalError(original.key, cause);
  }

  const changed = renewed.key !== original.key
    ? "key"
    : renewed.holder !== original.holder
      ? "holder"
      : renewed.fencingToken !== original.fencingToken
        ? "fencing token"
        : undefined;
  if (changed !== undefined) {
    throw new LockError(
      "lost_lease",
      original.key,
      `fiducia renewal changed the grant ${changed}; fenced authority cannot be proven`,
      { step: "fiducia.renew" },
    );
  }
  return renewed;
}

class LeaseMaintainer {
  readonly signal: AbortSignal;
  readonly whenFailed: Promise<LockError>;

  #controller = new AbortController();
  #resolveFailure!: (error: LockError) => void;
  #failure: LockError | undefined;
  #stopped = false;
  #wake: (() => void) | undefined;
  #task: Promise<void>;

  constructor(
    private readonly lease: Lease,
    private readonly grant: LeaseGrant,
    private readonly ttlMs: number,
    private readonly intervalMs: number,
  ) {
    this.signal = this.#controller.signal;
    this.whenFailed = new Promise<LockError>((resolve) => {
      this.#resolveFailure = resolve;
    });
    this.#task = this.#run();
  }

  get failure(): LockError | undefined {
    return this.#failure;
  }

  async stop(): Promise<void> {
    if (!this.#stopped) {
      this.#stopped = true;
      this.#wake?.();
    }
    await this.#task;
  }

  async #run(): Promise<void> {
    while (!this.#stopped) {
      await new Promise<void>((resolve) => {
        let timer: number | undefined;
        const wake = (): void => {
          if (timer !== undefined) clearTimeout(timer);
          if (this.#wake === wake) this.#wake = undefined;
          resolve();
        };
        this.#wake = wake;
        timer = setTimeout(wake, this.intervalMs);
      });
      if (this.#stopped) return;

      try {
        await renewChecked(this.lease, this.grant, this.ttlMs);
      } catch (cause) {
        const error = renewalError(this.grant.key, cause);
        this.#failure = error;
        this.#controller.abort(error);
        this.#resolveFailure(error);
        return;
      }
    }
  }
}

function firstBool(rows: Array<Record<string, unknown>>): boolean {
  const row = rows[0];
  if (!row) return false;
  const value = Object.values(row)[0];
  return value === true || value === "t";
}

async function tryXactLock(client: PgQueryable, key: LockKey, wait: boolean): Promise<boolean> {
  const step = wait ? "pg.advisory_xact_lock" : "pg.try_advisory_xact_lock";
  try {
    const result = await client.query(
      "SELECT pg_try_advisory_xact_lock($1)",
      [advisoryKey(key).toString()],
    );
    return firstBool(result.rows);
  } catch (cause) {
    throw LockError.database(key, step, cause);
  }
}

async function sleepOrRenewalFailure(milliseconds: number, maintainer: LeaseMaintainer): Promise<void> {
  if (maintainer.failure) throw maintainer.failure;

  let timer: number | undefined;
  const outcome = await Promise.race<undefined | LockError>([
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), milliseconds);
    }),
    maintainer.whenFailed,
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (outcome instanceof LockError) throw outcome;
}

async function acquireMaintainedXactLock(
  client: PgQueryable,
  key: LockKey,
  wait: boolean,
  acquire: AcquireOptions,
  maintainer: LeaseMaintainer,
): Promise<void> {
  const started = Date.now();
  while (true) {
    if (maintainer.failure) throw maintainer.failure;
    if (await tryXactLock(client, key, wait)) return;
    if (!wait) throw LockError.contention(key, "pg.try_advisory_xact_lock");

    const elapsed = Date.now() - started;
    if (elapsed >= acquire.waitTimeoutMs) {
      throw LockError.timeout(key, "pg.advisory_xact_lock", acquire.waitTimeoutMs);
    }
    await sleepOrRenewalFailure(
      Math.min(acquire.retryIntervalMs, acquire.waitTimeoutMs - elapsed),
      maintainer,
    );
  }
}

async function rollback(
  client: PgQueryable,
  key: LockKey,
  inner: unknown,
): Promise<unknown> {
  try {
    await client.query("ROLLBACK");
    return inner;
  } catch (cause) {
    return cleanupFailure(key, LockError.database(key, "pg.rollback", cause), inner);
  }
}

async function runMaintainedTransaction<T>(
  key: LockKey,
  wait: boolean,
  acquire: AcquireOptions,
  maintenance: LeaseMaintenanceOptions,
  lease: Lease,
  grant: LeaseGrant,
  pool: PgPool,
  work: (guarded: MaintainedXactGuarded) => Promise<T>,
): Promise<T> {
  const maintainer = new LeaseMaintainer(
    lease,
    grant,
    acquire.ttlMs,
    maintenance.renewIntervalMs,
  );
  let client: PgPoolClient | undefined;
  let began = false;
  let poisonClient = true;
  let value: T | undefined;
  let inner: unknown | undefined;

  try {
    try {
      client = await pool.connect();
    } catch (cause) {
      inner = LockError.database(key, "pg.begin", cause);
    }

    if (inner === undefined && client !== undefined) {
      try {
        await client.query("BEGIN");
        began = true;
        await acquireMaintainedXactLock(client, key, wait, acquire, maintainer);
        value = await runWork(
          key,
          { key, grant, client, signal: maintainer.signal },
          work,
        );
      } catch (cause) {
        inner = cause;
      }
    }

    await maintainer.stop();
    if (maintainer.failure) {
      inner = inner === undefined
        ? maintainer.failure
        : cleanupFailure(key, maintainer.failure, inner);
    }

    if (inner === undefined) {
      try {
        await renewChecked(lease, grant, acquire.ttlMs);
      } catch (cause) {
        inner = renewalError(key, cause);
      }
    }

    if (inner !== undefined) {
      if (began && client !== undefined) inner = await rollback(client, key, inner);
      throw inner;
    }

    try {
      await client!.query("COMMIT");
      began = false;
      poisonClient = false;
      return value as T;
    } catch (cause) {
      throw LockError.database(key, "pg.commit", cause);
    }
  } finally {
    await maintainer.stop();
    client?.release(poisonClient);
  }
}

/**
 * Hold a Fiducia lease around one PostgreSQL advisory-lock transaction.
 *
 * Waiting uses repeated `pg_try_advisory_xact_lock` calls so renewal failure
 * can interrupt the wait. Periodic renewal aborts `guarded.signal`; after work
 * settles, a final successful renewal is mandatory before `COMMIT`. All
 * protected database statements must use `guarded.client`.
 */
export async function withMaintainedXactLock<T>(
  key: LockKey,
  wait: boolean,
  acquire: AcquireOptions,
  maintenance: LeaseMaintenanceOptions,
  lease: Lease,
  pool: PgPool,
  work: (guarded: MaintainedXactGuarded) => Promise<T>,
): Promise<T> {
  validateLeaseMaintenanceOptions(key, acquire, maintenance, wait);
  const grant = await acquireLease(key, wait, acquire, lease);
  const inner = await settled(
    runMaintainedTransaction(key, wait, acquire, maintenance, lease, grant, pool, work),
  );
  return settle(key, lease, grant, inner);
}

/** Maintained both-layer path with the package defaults. */
export function withMaintainedBoth<T>(
  key: LockKey,
  lease: Lease,
  pool: PgPool,
  work: (guarded: MaintainedXactGuarded) => Promise<T>,
): Promise<T> {
  return withMaintainedXactLock(
    key,
    true,
    { ttlMs: 60_000, waitTimeoutMs: 30_000, retryIntervalMs: 250 },
    DEFAULT_LEASE_MAINTENANCE_OPTIONS,
    lease,
    pool,
    work,
  );
}
