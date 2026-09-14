/**
 * @oresoftware/locks-and-leases — local and distributed locking for the
 * ORESoftware fleet.
 *
 * Local single-host filesystem locks are deliberately separate from the
 * distributed fenced-lease + Postgres plan. Fiducia, Cloudflare Durable
 * Objects, and managed Redis all implement the distributed `Lease` interface.
 * The v1 conformance corpus retains historical `fiducia.*` step names for the
 * outer distributed lease layer.
 *
 * ```text
 * local-only: mkdir(lock) -> write owner -> work -> verify owner -> rmdir(lock)
 * distributed: lease.acquire -> pg.begin -> pg_advisory_xact_lock -> work/renew* -> lease.renew -> pg.commit -> lease.release
 * ```
 *
 * The TypeScript slice of ORESoftware/ores-locks-and-leases; distributed
 * contracts are held to the same `conformance/cases/*.json` as the Rust, Go,
 * Dart and Gleam slices.
 */

export { MAX_LOCK_KEY_BYTES, advisoryKey, fnv1a64, lockKey, type LockKey } from "./key.js";
export * from "./fence.js";
export * from "./renewal.js";
export {
  LocalFileLock,
  LocalFileLockError,
  DEFAULT_LOCAL_FILE_LOCK_OPTIONS,
  acquire_local_file_lock,
  local_file_lock_exists,
  try_acquire_local_file_lock,
  type LocalFileLockErrorKind,
  type LocalFileLockOptions,
} from "./local-file.js";
export {
  inspect_local_file_lock,
  recover_local_file_lock,
  type LocalFileLockInspection,
  type LocalFileLockInspectionState,
} from "./local-file-recovery.js";
export {
  ScopedLocalFileLockError,
  with_local_file_lock,
  type ScopedLocalFileLockErrorKind,
} from "./local-file-scoped.js";
export {
  ALL_STEPS,
  LAYERS_BOTH,
  LAYERS_FIDUCIA_ONLY,
  LAYERS_NONE,
  LAYERS_PG_ONLY,
  plan,
  type LockLayers,
  type LockPlan,
  type LockStep,
  type PgScope,
} from "./plan.js";
export { LockError, type LockErrorKind } from "./errors.js";
export {
  DEFAULT_ACQUIRE_OPTIONS,
  withLease,
  type AcquireOptions,
  type FencingToken,
  type Guarded,
  type Lease,
  type LeaseGrant,
} from "./lease.js";
export {
  withSessionLock,
  withXactLock,
  type PgPool,
  type PgPoolClient,
  type PgQueryable,
  type SessionGuarded,
  type XactGuarded,
} from "./pg.js";
export {
  DEFAULT_LEASE_MAINTENANCE_OPTIONS,
  validateLeaseMaintenanceOptions,
  withMaintainedBoth,
  withMaintainedXactLock,
  type LeaseAbortListener,
  type LeaseAbortListenerOptions,
  type LeaseAbortSignal,
  type LeaseMaintenanceOptions,
  type MaintainedXactGuarded,
} from "./maintained.js";
export { FiduciaLease, cleartextRefusal, generatedHolder, type FetchLike, type FiduciaLeaseOptions } from "./fiducia.js";
export {
  CloudflareDurableObjectLease,
  type CloudflareDurableObjectLeaseOptions,
} from "./cloudflare-do.js";
export {
  CloudflareDurableObjectRpcLease,
  type CloudflareDurableObjectRpcLeaseOptions,
} from "./cloudflare-do-rpc.js";
export type {
  CloudflareDurableObjectAcquireError,
  CloudflareDurableObjectAcquireRequest,
  CloudflareDurableObjectAcquireResult,
  CloudflareDurableObjectReleaseError,
  CloudflareDurableObjectReleaseRequest,
  CloudflareDurableObjectReleaseResult,
  CloudflareDurableObjectRenewError,
  CloudflareDurableObjectRenewRequest,
  CloudflareDurableObjectRenewResult,
  CloudflareDurableObjectRpcNamespace,
  CloudflareDurableObjectRpcStub,
} from "./cloudflare-do-rpc-types.js";
export {
  REDIS_ACQUIRE_LUA,
  REDIS_RELEASE_LUA,
  REDIS_RENEW_LUA,
  UpstashRedisLease,
  type UpstashRedisLeaseOptions,
} from "./upstash-redis.js";
