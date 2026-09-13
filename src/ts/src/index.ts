/**
 * @oresoftware/locks-and-leases — composed distributed locking for the
 * ORESoftware fleet: a fenced lease authority around a Postgres advisory
 * lock, each layer individually switchable, with fencing tokens threaded
 * through to the guarded work.
 *
 * Fiducia, Cloudflare Durable Objects, and managed Redis all implement the
 * same `Lease` interface. The v1 conformance corpus retains historical
 * `fiducia.*` step names for the outer lease layer.
 *
 * ```text
 * lease.acquire ─► pg.begin ─► pg.advisory_xact_lock ─► work/renew* ─► lease.renew ─► pg.commit ─► lease.release
 * ```
 *
 * The TypeScript slice of ORESoftware/ores-locks-and-leases; held to the same
 * `conformance/cases/*.json` as the Rust, Go, Dart and Gleam slices.
 */

export { MAX_LOCK_KEY_BYTES, advisoryKey, fnv1a64, lockKey, type LockKey } from "./key.js";
export * from "./fence.js";
export * from "./renewal.js";
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
  REDIS_ACQUIRE_LUA,
  REDIS_RELEASE_LUA,
  REDIS_RENEW_LUA,
  UpstashRedisLease,
  type UpstashRedisLeaseOptions,
} from "./upstash-redis.js";
