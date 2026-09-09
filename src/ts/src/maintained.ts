/**
 * Fail-closed Fiducia + PostgreSQL transaction coordination.
 *
 * The legacy `withXactLock` API keeps its original behavior. This module adds
 * an opt-in path for long-running work: periodically renew the outer Fiducia
 * grant, require a final renewal immediately before commit, and roll back the
 * PostgreSQL transaction whenever fenced authority cannot be proven.
 */

import { LockError, cleanupFailure, tagStep } from "./errors.js";
import { advisoryKey, lockKey, type LockKey } from "./key.js";
import {
  acquireLease,
  runWork,
  settle,
  settled,
  type AcquireOptions,
  type Lease,
  type LeaseGrant,
} from "./lease.js";
import type { LockStep } from "./plan.js";
import type { PgPool, PgPoolClient, PgQueryable } from "./pg.js";
import { MAX_RENEWAL_CLOCK_MS, MAX_RENEWAL_TTL_MS } from "./renewal.js";

const MAX_FENCING_TOKEN = 18_446_744_073_709_551_615n;
const ACQUIRE_FIELDS = new Set(["ttlMs", "waitTimeoutMs", "retryIntervalMs", "holder"]);
const MAINTENANCE_FIELDS = new Set(["renewIntervalMs"]);
const GRANT_FIELDS = new Set(["key", "holder", "fencingToken", "leaseExpiresMs", "ttlMs"]);

/** Renewal cadence for a maintained transaction. */
export interface LeaseMaintenanceOptions {
  /** Positive integer milliseconds, no greater than half of `ttlMs`. */
  readonly renewIntervalMs: number;
}

export const DEFAULT_LEASE_MAINTENANCE_OPTIONS: LeaseMaintenanceOptions = Object.freeze({
  renewIntervalMs: 20_000,
});

/** DOM-independent listener options exposed by the maintained guard. */
export interface LeaseAbortListenerOptions {
  readonly once?: boolean;
  readonly capture?: boolean;
  readonly passive?: boolean;
}

/** A cancellation callback. No browser `Event` type is required. */
export type LeaseAbortListener = () => void;

/**
 * Portable subset of `AbortSignal` used by maintained work.
 *
 * The implementation delegates to the platform signal, while generated and
 * server-only consumers do not need the DOM type library merely to compile
 * this package's declarations.
 */
export interface LeaseAbortSignal {
  readonly aborted: boolean;
  readonly reason: unknown;
  /** Throw the exact cancellation reason after authority loss. */
  throwIfAborted(): void;
  addEventListener(
    type: "abort",
    listener: LeaseAbortListener,
    options?: boolean | LeaseAbortListenerOptions,
  ): void;
  removeEventListener(
    type: "abort",
    listener: LeaseAbortListener,
    options?: boolean | LeaseAbortListenerOptions,
  ): void;
}

/** What maintained transaction work receives. */
export interface MaintainedXactGuarded {
  readonly key: LockKey;
  /** Frozen authority snapshot; its token is the datastore fencing input. */
  readonly grant: LeaseGrant;
  /** The checked-out client whose open transaction holds the advisory lock. */
  readonly client: PgQueryable;
  /** Aborted when periodic renewal fails; work should stop promptly. */
  readonly signal: LeaseAbortSignal;
}

interface ValidatedInputs {
  readonly acquire: Readonly<AcquireOptions>;
  readonly maintenance: Readonly<LeaseMaintenanceOptions>;
}

/**
 * Validate every runtime input before acquiring either coordination layer.
 *
 * The maintained path uses a fixed renewal cadence. The acquired grant and
 * every renewal must therefore report exactly `acquire.ttlMs`; effective-TTL
 * drift is terminal rather than silently scheduling against stale timing.
 */
export function validateLeaseMaintenanceOptions(
  key: LockKey,
  acquire: AcquireOptions,
  maintenance: LeaseMaintenanceOptions,
  wait: boolean,
): void {
  validatedInputs(key, acquire, maintenance, wait);
}

function validatedInputs(
  key: LockKey,
  acquire: AcquireOptions,
  maintenance: LeaseMaintenanceOptions,
  wait: boolean,
): ValidatedInputs {
  if (typeof wait !== "boolean") {
    throw LockError.invalidPlan(key, "wait must be a boolean");
  }

  const acquireSnapshot = snapshotAcquireOptions(key, acquire);
  const maintenanceSnapshot = snapshotMaintenanceOptions(key, maintenance);

  requirePositiveInteger(key, acquireSnapshot.ttlMs, "fiducia lease TTL");
  if (acquireSnapshot.ttlMs > MAX_RENEWAL_TTL_MS) {
    throw LockError.invalidPlan(
      key,
      `fiducia lease TTL must be no greater than ${MAX_RENEWAL_TTL_MS} ms`,
    );
  }
  requirePositiveInteger(key, maintenanceSnapshot.renewIntervalMs, "fiducia renewal interval");
  if (maintenanceSnapshot.renewIntervalMs > acquireSnapshot.ttlMs / 2) {
    throw LockError.invalidPlan(
      key,
      `fiducia renewal interval ${maintenanceSnapshot.renewIntervalMs} ms is unsafe for TTL ${acquireSnapshot.ttlMs} ms; it must be no greater than half the TTL`,
    );
  }
  if (!Number.isSafeInteger(acquireSnapshot.waitTimeoutMs) || acquireSnapshot.waitTimeoutMs < 0) {
    throw LockError.invalidPlan(key, "PostgreSQL advisory-lock wait timeout must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(acquireSnapshot.retryIntervalMs) || acquireSnapshot.retryIntervalMs < 0) {
    throw LockError.invalidPlan(key, "PostgreSQL advisory-lock retry interval must be a non-negative safe integer");
  }
  if (wait) {
    requirePositiveInteger(key, acquireSnapshot.retryIntervalMs, "PostgreSQL advisory-lock retry interval");
  }

  return Object.freeze({
    acquire: acquireSnapshot,
    maintenance: maintenanceSnapshot,
  });
}

function snapshotAcquireOptions(key: LockKey, value: unknown): Readonly<AcquireOptions> {
  const fields = closedInputFields(
    key,
    value,
    ACQUIRE_FIELDS,
    ["ttlMs", "waitTimeoutMs", "retryIntervalMs"],
    "acquire options",
  );
  const hasHolder = Object.hasOwn(fields, "holder");
  const holder = fields.holder;
  if (hasHolder && (typeof holder !== "string" || holder.length === 0)) {
    throw LockError.invalidPlan(key, "acquire option holder must be omitted or a non-empty string");
  }

  const snapshot: AcquireOptions = hasHolder
    ? {
        ttlMs: fields.ttlMs as number,
        waitTimeoutMs: fields.waitTimeoutMs as number,
        retryIntervalMs: fields.retryIntervalMs as number,
        holder: holder as string,
      }
    : {
        ttlMs: fields.ttlMs as number,
        waitTimeoutMs: fields.waitTimeoutMs as number,
        retryIntervalMs: fields.retryIntervalMs as number,
      };
  return Object.freeze(snapshot);
}

function snapshotMaintenanceOptions(
  key: LockKey,
  value: unknown,
): Readonly<LeaseMaintenanceOptions> {
  const fields = closedInputFields(
    key,
    value,
    MAINTENANCE_FIELDS,
    ["renewIntervalMs"],
    "maintenance options",
  );
  return Object.freeze({ renewIntervalMs: fields.renewIntervalMs as number });
}

function closedInputFields(
  key: LockKey,
  value: unknown,
  allowed: ReadonlySet<string>,
  required: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw LockError.invalidPlan(key, `${label} must be a non-array object`);
  }

  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (cause) {
    throw new LockError("invalid_plan", key, `${label} properties could not be inspected`, { cause });
  }

  const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const name of Reflect.ownKeys(descriptors)) {
    if (typeof name !== "string" || !allowed.has(name)) {
      throw LockError.invalidPlan(key, `${label} contains an unknown own property`);
    }
    const descriptor = descriptors[name];
    if (!descriptor || !("value" in descriptor)) {
      throw LockError.invalidPlan(key, `${label} properties must be own data properties`);
    }
    fields[name] = descriptor.value;
  }
  for (const name of required) {
    if (!Object.hasOwn(fields, name)) {
      throw LockError.invalidPlan(key, `${label} is missing required own property ${name}`);
    }
  }
  return fields;
}

function requirePositiveInteger(key: LockKey, value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw LockError.invalidPlan(key, `${name} must be a positive safe integer number of milliseconds`);
  }
}

function authorityGrantError(
  expectedKey: LockKey,
  step: LockStep,
  kind: "transport" | "lost_lease",
  message: string,
  cause?: unknown,
): LockError {
  return new LockError(kind, expectedKey, message, {
    step,
    ...(cause === undefined ? {} : { cause }),
  });
}

function snapshotAuthorityGrant(
  expectedKey: LockKey,
  value: unknown,
  step: LockStep,
  kind: "transport" | "lost_lease",
): LeaseGrant {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw authorityGrantError(expectedKey, step, kind, "Fiducia returned a non-object lease grant");
  }

  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (cause) {
    throw authorityGrantError(
      expectedKey,
      step,
      kind,
      "Fiducia lease-grant properties could not be inspected",
      cause,
    );
  }

  const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const name of Reflect.ownKeys(descriptors)) {
    if (typeof name !== "string" || !GRANT_FIELDS.has(name)) {
      throw authorityGrantError(expectedKey, step, kind, "Fiducia lease grant contains an unknown own property");
    }
    const descriptor = descriptors[name];
    if (!descriptor || !("value" in descriptor)) {
      throw authorityGrantError(expectedKey, step, kind, "Fiducia lease-grant fields must be own data properties");
    }
    fields[name] = descriptor.value;
  }
  for (const name of ["key", "holder", "fencingToken", "ttlMs"] as const) {
    if (!Object.hasOwn(fields, name)) {
      throw authorityGrantError(expectedKey, step, kind, `Fiducia lease grant is missing ${name}`);
    }
  }

  let key: LockKey;
  try {
    key = lockKey(fields.key as string);
  } catch (cause) {
    throw authorityGrantError(expectedKey, step, kind, "Fiducia lease grant contains an invalid key", cause);
  }
  if (key !== expectedKey) {
    throw authorityGrantError(expectedKey, step, kind, "Fiducia lease grant changed the lock key");
  }

  const holder = fields.holder;
  if (typeof holder !== "string" || holder.length === 0) {
    throw authorityGrantError(expectedKey, step, kind, "Fiducia lease grant holder must be a non-empty string");
  }

  const fencingToken = fields.fencingToken;
  if (typeof fencingToken !== "bigint" || fencingToken < 0n || fencingToken > MAX_FENCING_TOKEN) {
    throw authorityGrantError(expectedKey, step, kind, "Fiducia lease grant token must be an unsigned 64-bit bigint");
  }

  const ttlMs = fields.ttlMs;
  if (!Number.isSafeInteger(ttlMs) || (ttlMs as number) <= 0 || (ttlMs as number) > MAX_RENEWAL_TTL_MS) {
    throw authorityGrantError(
      expectedKey,
      step,
      kind,
      `Fiducia lease grant TTL must be within 1..=${MAX_RENEWAL_TTL_MS} ms`,
    );
  }

  const hasDeadline = Object.hasOwn(fields, "leaseExpiresMs");
  const leaseExpiresMs = fields.leaseExpiresMs;
  if (
    hasDeadline &&
    (typeof leaseExpiresMs !== "number" ||
      !Number.isSafeInteger(leaseExpiresMs) ||
      leaseExpiresMs <= 0 ||
      leaseExpiresMs > MAX_RENEWAL_CLOCK_MS)
  ) {
    throw authorityGrantError(
      expectedKey,
      step,
      kind,
      "Fiducia lease grant deadline must be omitted or a positive safe integer",
    );
  }

  const snapshot: LeaseGrant = hasDeadline
    ? {
        key,
        holder,
        fencingToken,
        leaseExpiresMs: leaseExpiresMs as number,
        ttlMs: ttlMs as number,
      }
    : { key, holder, fencingToken, ttlMs: ttlMs as number };
  return Object.freeze(snapshot);
}

function validateMaintainedAcquiredGrant(
  key: LockKey,
  acquire: Readonly<AcquireOptions>,
  grant: LeaseGrant,
  step: LockStep,
): void {
  const changed = acquire.holder !== undefined && grant.holder !== acquire.holder
    ? "holder"
    : grant.ttlMs !== acquire.ttlMs
      ? "TTL"
      : undefined;
  if (changed !== undefined) {
    throw new LockError(
      "lost_lease",
      key,
      `fiducia acquisition returned an invalid grant ${changed}; maintained authority cannot be proven`,
      { step },
    );
  }
}

function renewalError(key: LockKey, cause: unknown): LockError {
  const error = cause instanceof LockError ? cause : LockError.transport(key, cause);
  tagStep(error, "fiducia.renew");
  return error;
}

async function renewChecked(lease: Lease, original: LeaseGrant, ttlMs: number): Promise<LeaseGrant> {
  let raw: LeaseGrant;
  try {
    raw = await lease.renew(original, ttlMs);
  } catch (cause) {
    throw renewalError(original.key, cause);
  }

  const renewed = snapshotAuthorityGrant(original.key, raw, "fiducia.renew", "lost_lease");
  const changed = renewed.holder !== original.holder
    ? "holder"
    : renewed.fencingToken !== original.fencingToken
      ? "fencing token"
      : renewed.ttlMs !== ttlMs
        ? "TTL"
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
  readonly signal: LeaseAbortSignal;
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
    const source = this.#controller.signal;
    this.signal = Object.freeze({
      get aborted(): boolean {
        return source.aborted;
      },
      get reason(): unknown {
        return source.reason;
      },
      throwIfAborted(): void {
        source.throwIfAborted();
      },
      addEventListener(
        type: "abort",
        listener: LeaseAbortListener,
        options?: boolean | LeaseAbortListenerOptions,
      ): void {
        source.addEventListener(type, listener, options);
      },
      removeEventListener(
        type: "abort",
        listener: LeaseAbortListener,
        options?: boolean | LeaseAbortListenerOptions,
      ): void {
        source.removeEventListener(type, listener, options);
      },
    });
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
  acquire: Readonly<AcquireOptions>,
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
  acquire: Readonly<AcquireOptions>,
  maintenance: Readonly<LeaseMaintenanceOptions>,
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
          Object.freeze({ key, grant, client, signal: maintainer.signal }),
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
 * settles, a final successful same-token, same-TTL renewal is mandatory before
 * `COMMIT`. All protected database statements must use `guarded.client`.
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
  const inputs = validatedInputs(key, acquire, maintenance, wait);
  const acquireStep: LockStep = wait ? "fiducia.acquire" : "fiducia.try_acquire";
  const rawGrant = await acquireLease(key, wait, inputs.acquire, lease);
  const grant = snapshotAuthorityGrant(key, rawGrant, acquireStep, "transport");
  try {
    validateMaintainedAcquiredGrant(key, inputs.acquire, grant, acquireStep);
  } catch (error) {
    return settle<T>(key, lease, grant, { ok: false, error });
  }
  const inner = await settled(
    runMaintainedTransaction(
      key,
      wait,
      inputs.acquire,
      inputs.maintenance,
      lease,
      grant,
      pool,
      work,
    ),
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
