//! Composed distributed locking for the ORESoftware fleet.
//!
//! Two coordination layers, each individually switchable:
//!
//! * **fiducia-cloud lease** — the outermost layer. Cross-host, TTL-bounded,
//!   and *fenced*: every grant carries a monotonically increasing
//!   [`FencingToken`] that guarded writes should record, so a holder whose
//!   lease lapsed cannot clobber the next holder's work.
//! * **Postgres advisory lock** — the inner layer. Single-database mutual
//!   exclusion that the database itself releases: with
//!   [`PgScope::Transaction`] the lock is `pg_advisory_xact_lock` inside a
//!   transaction this crate opens and commits around the caller's work; with
//!   [`PgScope::Session`] it is `pg_advisory_lock` / `pg_advisory_unlock` on
//!   one dedicated connection and no transaction is opened at all.
//!
//! The layer order is fixed and the same in every language slice of this
//! package: fiducia is acquired first and released last, the advisory lock
//! sits inside it, and the caller's work is innermost. [`plan`] computes that
//! sequence as data so it can be checked against
//! `conformance/cases/lock-plan.json`, and [`advisory_key`] derives the
//! `bigint` the advisory functions take from a string key so every runtime
//! locks the same integer for the same key.
//!
//! Nothing here depends on the network or on SeaORM unless the matching
//! cargo feature is enabled: the core (`key`, `plan`, `error`, `lease`) is
//! dependency-free and is what `zed-lib-core` and friends import first.
//!
//! ```text
//! fiducia.acquire ─► pg.begin ─► pg.advisory_xact_lock ─► work ─► pg.commit ─► fiducia.release
//! ```

pub mod error;
pub mod key;
pub mod lease;
pub mod plan;

#[cfg(feature = "pg")]
pub mod pg;

#[cfg(feature = "fiducia")]
pub mod fiducia;

#[cfg(feature = "pg")]
pub mod coordinated;

pub use error::{LockError, LockErrorKind};
pub use key::{AdvisoryKey, LockKey, advisory_key, fnv1a64};
pub use lease::{AcquireOptions, FencingToken, Lease, LeaseGrant, NoLease, WorkFuture, with_lease};
pub use plan::{LockLayers, LockPlan, LockStep, PgScope, plan};

#[cfg(feature = "pg")]
pub use coordinated::{Guarded, with_session_lock, with_xact_lock};
