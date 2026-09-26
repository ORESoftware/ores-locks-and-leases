//! Composed local and distributed locking for the ORESoftware fleet.
//!
//! There are two deliberately separate coordination domains:
//!
//! * **local filesystem locks** — dependency-free, no-network, single-host
//!   mutual exclusion. [`LocalFileLock`] provides the portable mkdir/owner-token
//!   backend shared conceptually with the TypeScript, Go, and Gleam slices.
//!   zed-pkg's Rust hot path should prefer its stronger native descriptor/handle
//!   lock (`zed-lock`) when available.
//! * **distributed coordination** — a fenced lease authority around an optional
//!   Postgres advisory lock for state shared by more than one host.
//!
//! Distributed coordination has two layers, each individually switchable:
//!
//! * **fenced lease authority** — the outermost layer. Fiducia remains the
//!   historical/default adapter, while managed Cloudflare Durable Objects,
//!   Redis authorities, and Redlock composed with an independent fencing-token
//!   authority implement the same [`Lease`] seam. Every grant carries a
//!   monotonically increasing [`FencingToken`] that guarded writes should
//!   record, so a holder whose lease lapsed cannot clobber the next holder's
//!   work.
//! * **Postgres advisory lock** — the inner layer. Single-database mutual
//!   exclusion that the database itself releases: with
//!   [`PgScope::Transaction`] the lock is `pg_advisory_xact_lock` inside a
//!   transaction this crate opens and commits around the caller's work; with
//!   [`PgScope::Session`] it is `pg_advisory_lock` / `pg_advisory_unlock` on
//!   one dedicated connection and no transaction is opened at all.
//!
//! The distributed layer order is fixed and the same in every language slice
//! of this package: the fenced lease is acquired first and released last, the
//! advisory lock sits inside it, and the caller's work is innermost. The
//! portable local filesystem backend is not inserted into that historical
//! `plan` matrix; callers compose it explicitly when local state also needs
//! protection.
//!
//! The current v1 distributed contract keeps the historical `fiducia.*` step
//! names for compatibility; those step names mean the outer lease authority,
//! not a required backend. [`plan`] computes that sequence as data so it can be
//! checked against `conformance/cases/lock-plan.json`, and [`advisory_key`]
//! derives the `bigint` the advisory functions take from a string key so every
//! runtime locks the same integer for the same key.
//!
//! [`evaluate_fence`] is the dependency-free application-side decision
//! primitive. The concrete PostgreSQL/Supabase/Neon and Redis atomic adapters
//! live under `persistence/`; every datastore that owns protected state must
//! enforce its own watermark in the same transaction or script as the write.
//!
//! [`RenewalSupervisor`] provides sticky, cooperative lease-loss detection for
//! long-running work. Callers checkpoint it before every authoritative commit;
//! datastore fencing remains mandatory because a heartbeat cannot undo an
//! effect emitted before the checkpoint.
//!
//! With `pg` plus either `fiducia` or the generic `maintained` feature,
//! [`with_maintained_xact_lock`] renews any [`Lease`] implementation while the
//! inner PostgreSQL transaction is active and requires one final renewal before
//! commit. Cloudflare Durable Objects and Redis therefore use the same
//! fail-closed maintained path without depending on the Fiducia client.
//!
//! Nothing here depends on the network or on SeaORM unless the matching cargo
//! feature is enabled: the core (`key`, `plan`, `error`, `lease`, `local_file`,
//! `managed`, `redlock`, `fence`, `renewal`) is dependency-free and is what
//! `zed-lib-core` and friends import first.
//!
//! ```text
//! local-only: mkdir(lock) -> write owner -> work -> verify owner -> rmdir(lock)
//! distributed: lease.acquire -> pg.begin -> pg_advisory_xact_lock -> work/renew* -> lease.renew -> pg.commit -> lease.release
//! ```

pub mod beamscale;
pub mod error;
pub mod fence;
pub mod key;
pub mod lease;
pub mod local_file;
pub mod local_file_recovery;
pub mod local_file_scoped;
pub mod managed;
pub mod plan;
pub mod redlock;
pub mod renewal;

#[cfg(feature = "config")]
pub mod config;

#[cfg(feature = "pg")]
pub mod pg;

#[cfg(feature = "fiducia")]
pub mod fiducia;

#[cfg(feature = "pg")]
pub mod coordinated;

#[cfg(all(feature = "pg", any(feature = "fiducia", feature = "maintained")))]
pub mod maintained;

pub use beamscale::{
    BeamScaleAcquireResult, BeamScaleCriticalSectionGrant, BeamScaleCriticalSectionLease,
    BeamScaleCriticalSectionToken, BeamScaleCriticalSectionTransport, BeamScaleRenewResult,
};
#[cfg(feature = "config")]
pub use config::{
    BeamScaleCriticalSectionProviderConfig, CloudflareDurableObjectProviderConfig, EnvBinding,
    EnvKind, FiduciaProviderConfig, LOCK_CONFIG_SCHEMA_V1, LocalFileProviderConfig,
    LockConfigError, LockProfileConfig, MAX_CONFIG_ENVS, MAX_CONFIG_PROFILES,
    MAX_RENEW_INTERVAL_MS, MAX_RETRY_INTERVAL_MS, MAX_TTL_MS, MAX_WAIT_TIMEOUT_MS,
    OresLockConfigV1, OuterLeaseAuthority, PostgresLockScope, PostgresProviderConfig,
    ProviderSelection, RedisProviderConfig,
};
pub use error::{LockError, LockErrorKind};
pub use fence::{
    FenceDecision, FenceDecisionKind, FenceValidationError, FenceWatermark, FencedWriteRequest,
    FencingTokenText, MAX_FENCE_METADATA_BYTES, MAX_FENCING_TOKEN_TEXT, MAX_OPERATION_ID_BYTES,
    MAX_TENANT_SCOPE_BYTES, evaluate_fence,
};
pub use key::{AdvisoryKey, LockKey, advisory_key, fnv1a64};
pub use lease::{AcquireOptions, FencingToken, Lease, LeaseGrant, NoLease, WorkFuture, with_lease};
pub use local_file::{
    LocalFileLock, LocalFileLockError, LocalFileLockErrorKind, LocalFileLockOptions,
    local_file_lock_exists,
};
pub use local_file_recovery::{
    LocalFileLockInspection, LocalFileLockInspectionReason, LocalFileLockInspectionState,
    inspect_local_file_lock, recover_local_file_lock,
};
pub use local_file_scoped::{ScopedLocalFileLockError, with_local_file_lock};
pub use managed::{
    CloudflareDurableObjectLease, ManagedAcquireResult, ManagedGrant, ManagedLease,
    ManagedLeaseBackend, ManagedLeaseTransport, ManagedRenewResult, RedisLease,
};
pub use plan::{LockLayers, LockPlan, LockStep, PgScope, plan};
pub use redlock::{
    FencedRedlockLease, FencingTokenAuthority as RedlockFencingTokenAuthority, RedlockAcquireError,
    RedlockClient, RedlockFuture, RedlockHandle,
};

pub use renewal::{
    MAX_RENEWAL_CLOCK_MS, MAX_RENEWAL_TTL_MS, MonotonicClock, RenewalCheckpoint, RenewalDecision,
    RenewalError, RenewalLossReason, RenewalPolicy, RenewalSupervisor,
};

#[cfg(feature = "pg")]
pub use coordinated::{Guarded, with_session_lock, with_xact_lock};

#[cfg(all(feature = "pg", any(feature = "fiducia", feature = "maintained")))]
pub use maintained::{LeaseMaintenanceOptions, with_maintained_both, with_maintained_xact_lock};
