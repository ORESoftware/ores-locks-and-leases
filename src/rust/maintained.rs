//! A fail-closed Fiducia + PostgreSQL transaction routine.
//!
//! The legacy [`crate::with_xact_lock`] intentionally preserves its original
//! acquire/work/commit/release behavior. This module provides an opt-in path
//! for long-running work: the Fiducia grant is renewed while PostgreSQL begin,
//! lock acquisition, and user work are in flight, then renewed once more as a
//! mandatory commit-admission check. A failed or malformed renewal rolls the
//! transaction back, so successful return means the caller still held the
//! same fenced authority immediately before commit.

use std::cmp::min;
use std::fmt;
use std::time::Duration;

use sea_orm::{DatabaseTransaction, TransactionTrait};
use tokio::time::{Instant, Interval, MissedTickBehavior, interval_at, sleep_until};

use crate::LockKey;
use crate::coordinated::Guarded;
use crate::error::{LockError, LockErrorKind};
use crate::lease::{AcquireOptions, Lease, LeaseGrant, WorkFuture, release_lost, tag_step};
use crate::pg;
use crate::plan::LockStep;

/// Renewal cadence for [`with_maintained_xact_lock`].
///
/// The interval must be positive and no greater than half of the acquisition
/// TTL. That leaves at least one full interval of safety margin when one tick
/// is delayed by runtime scheduling or a transient slow response.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LeaseMaintenanceOptions {
    pub renew_interval: Duration,
}

impl Default for LeaseMaintenanceOptions {
    fn default() -> Self {
        Self {
            renew_interval: Duration::from_secs(20),
        }
    }
}

impl LeaseMaintenanceOptions {
    pub fn renew_interval(mut self, renew_interval: Duration) -> Self {
        self.renew_interval = renew_interval;
        self
    }

    pub fn renew_interval_ms(&self) -> u64 {
        u64::try_from(self.renew_interval.as_millis()).unwrap_or(u64::MAX)
    }

    /// Validate before either coordination layer is acquired.
    pub fn validate(
        &self,
        key: &LockKey,
        acquire: &AcquireOptions,
        wait: bool,
    ) -> Result<(), LockError> {
        if acquire.ttl.is_zero() {
            return Err(LockError::invalid_plan(
                key,
                "fiducia lease TTL must be greater than zero",
            ));
        }
        if self.renew_interval.is_zero() {
            return Err(LockError::invalid_plan(
                key,
                "fiducia renewal interval must be greater than zero",
            ));
        }
        if self.renew_interval > acquire.ttl / 2 {
            return Err(LockError::invalid_plan(
                key,
                format!(
                    "fiducia renewal interval {} ms is unsafe for TTL {} ms; it must be no greater than half the TTL",
                    self.renew_interval_ms(),
                    acquire.ttl_ms()
                ),
            ));
        }
        if wait && acquire.retry_interval.is_zero() {
            return Err(LockError::invalid_plan(
                key,
                "PostgreSQL advisory-lock retry interval must be greater than zero when wait is enabled",
            ));
        }
        Ok(())
    }
}

/// Run work while holding both a Fiducia lease and
/// `pg_try_advisory_xact_lock`/`pg_advisory_xact_lock` semantics in one
/// PostgreSQL transaction.
///
/// This differs from [`crate::with_xact_lock`] in four safety-critical ways:
///
/// 1. blocking advisory acquisition is implemented as bounded try-lock polling
///    so the Fiducia lease can be renewed and loss can interrupt the wait;
/// 2. the lease is renewed while PostgreSQL begin, lock acquisition, and user
///    work are pending;
/// 3. every renewal must preserve key, holder and fencing token; and
/// 4. a final renewal is required before commit. Any failure rolls back.
///
/// The work future is dropped before rollback when a periodic renewal fails.
/// Therefore all protected database effects must use `guarded.txn`; unrelated
/// external side effects cannot be rolled back by this routine.
pub async fn with_maintained_xact_lock<L, C, T, E, F>(
    key: &LockKey,
    wait: bool,
    acquire: &AcquireOptions,
    maintenance: &LeaseMaintenanceOptions,
    lease: &L,
    db: &C,
    work: F,
) -> Result<T, LockError>
where
    L: Lease + Sync,
    C: TransactionTrait,
    E: fmt::Display,
    F: for<'a> FnOnce(Guarded<'a>) -> WorkFuture<'a, T, E>,
{
    maintenance.validate(key, acquire, wait)?;

    let grant = lease.acquire(key, acquire, wait).await.map_err(|err| {
        tag_step(
            err,
            if wait {
                LockStep::FiduciaAcquire
            } else {
                LockStep::FiduciaTryAcquire
            },
        )
    })?;

    let mut renewals = interval_at(
        Instant::now() + maintenance.renew_interval,
        maintenance.renew_interval,
    );
    renewals.set_missed_tick_behavior(MissedTickBehavior::Delay);

    let begin_result = {
        let begin = db.begin();
        tokio::pin!(begin);
        loop {
            tokio::select! {
                result = &mut begin => break result,
                _ = renewals.tick() => {
                    if let Err(error) = renew_checked(lease, &grant, acquire.ttl).await {
                        return settle_lease(key, lease, &grant, Err(error)).await;
                    }
                }
            }
        }
    };

    let txn = match begin_result {
        Ok(txn) => txn,
        Err(cause) => {
            let inner = LockError::new(LockErrorKind::Database, key, cause.to_string())
                .at(LockStep::PgBegin);
            return settle_lease(key, lease, &grant, Err(inner)).await;
        }
    };

    if let Err(error) =
        acquire_transaction_lock(&txn, key, wait, acquire, lease, &grant, &mut renewals).await
    {
        return rollback_then_settle(key, lease, &grant, txn, error).await;
    }

    let work_result = {
        let work_future = work(Guarded {
            key,
            grant: Some(&grant),
            txn: Some(&txn),
        });
        tokio::pin!(work_future);

        loop {
            tokio::select! {
                result = &mut work_future => {
                    break result.map_err(|cause| LockError::work(key, cause));
                }
                _ = renewals.tick() => {
                    if let Err(error) = renew_checked(lease, &grant, acquire.ttl).await {
                        break Err(error);
                    }
                }
            }
        }
    };

    let value = match work_result {
        Ok(value) => value,
        Err(error) => {
            return rollback_then_settle(key, lease, &grant, txn, error).await;
        }
    };

    // Commit admission: even if the periodic loop renewed one microsecond ago,
    // require one synchronous authority check after work and before commit.
    if let Err(error) = renew_checked(lease, &grant, acquire.ttl).await {
        return rollback_then_settle(key, lease, &grant, txn, error).await;
    }

    let committed = match txn.commit().await {
        Ok(()) => Ok(value),
        Err(cause) => Err(
            LockError::new(LockErrorKind::Database, key, cause.to_string()).at(LockStep::PgCommit),
        ),
    };
    settle_lease(key, lease, &grant, committed).await
}

/// Convenience spelling for the maintained both-layer path with default
/// acquisition and maintenance options.
pub async fn with_maintained_both<L, C, T, E, F>(
    key: &LockKey,
    lease: &L,
    db: &C,
    work: F,
) -> Result<T, LockError>
where
    L: Lease + Sync,
    C: TransactionTrait,
    E: fmt::Display,
    F: for<'a> FnOnce(Guarded<'a>) -> WorkFuture<'a, T, E>,
{
    with_maintained_xact_lock(
        key,
        true,
        &AcquireOptions::default(),
        &LeaseMaintenanceOptions::default(),
        lease,
        db,
        work,
    )
    .await
}

async fn acquire_transaction_lock<L: Lease + Sync>(
    txn: &DatabaseTransaction,
    key: &LockKey,
    wait: bool,
    acquire: &AcquireOptions,
    lease: &L,
    grant: &LeaseGrant,
    renewals: &mut Interval,
) -> Result<(), LockError> {
    let started = Instant::now();

    loop {
        match pg::try_xact_lock(txn, key).await {
            Ok(()) => return Ok(()),
            Err(error) if wait && error.kind == LockErrorKind::Contention => {}
            Err(error) => return Err(error),
        }

        let elapsed = started.elapsed();
        if elapsed >= acquire.wait_timeout {
            return Err(LockError::timeout(
                key,
                LockStep::PgAdvisoryXactLock,
                acquire.wait_timeout_ms(),
            ));
        }

        let remaining = acquire.wait_timeout.saturating_sub(elapsed);
        let retry_at = Instant::now() + min(acquire.retry_interval, remaining);
        loop {
            tokio::select! {
                _ = sleep_until(retry_at) => break,
                _ = renewals.tick() => {
                    renew_checked(lease, grant, acquire.ttl).await?;
                }
            }
        }
    }
}

async fn renew_checked<L: Lease + Sync>(
    lease: &L,
    original: &LeaseGrant,
    ttl: Duration,
) -> Result<LeaseGrant, LockError> {
    let renewed = lease
        .renew(original, ttl)
        .await
        .map_err(|err| tag_step(err, LockStep::FiduciaRenew))?;
    validate_renewed_grant(original, &renewed)?;
    Ok(renewed)
}

fn validate_renewed_grant(original: &LeaseGrant, renewed: &LeaseGrant) -> Result<(), LockError> {
    let mismatch = if renewed.key != original.key {
        Some("key")
    } else if renewed.holder != original.holder {
        Some("holder")
    } else if renewed.fencing_token != original.fencing_token {
        Some("fencing token")
    } else {
        None
    };

    if let Some(field) = mismatch {
        return Err(LockError::new(
            LockErrorKind::LostLease,
            &original.key,
            format!("fiducia renewal changed the grant {field}; fenced authority cannot be proven"),
        )
        .at(LockStep::FiduciaRenew));
    }
    Ok(())
}

async fn rollback_then_settle<L: Lease + Sync, T>(
    key: &LockKey,
    lease: &L,
    grant: &LeaseGrant,
    txn: DatabaseTransaction,
    inner: LockError,
) -> Result<T, LockError> {
    let inner = match txn.rollback().await {
        Ok(()) => inner,
        Err(cause) => LockError::new(LockErrorKind::Database, key, cause.to_string())
            .at(LockStep::PgRollback)
            .after_inner_failure(&inner),
    };
    settle_lease(key, lease, grant, Err(inner)).await
}

async fn settle_lease<L: Lease + Sync, T>(
    key: &LockKey,
    lease: &L,
    grant: &LeaseGrant,
    inner: Result<T, LockError>,
) -> Result<T, LockError> {
    let cleanup = match lease.release(grant).await {
        Ok(true) => None,
        Ok(false) => Some(release_lost(key, grant)),
        Err(error) => Some(tag_step(error, LockStep::FiduciaRelease)),
    };

    match (inner, cleanup) {
        (Ok(value), None) => Ok(value),
        (Err(error), None) => Err(error),
        (Ok(_), Some(cleanup)) => Err(cleanup),
        (Err(inner), Some(cleanup)) => Err(cleanup.after_inner_failure(&inner)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grant() -> LeaseGrant {
        LeaseGrant {
            key: LockKey::new("tests/maintained").unwrap(),
            holder: "holder-a".into(),
            fencing_token: 41,
            lease_expires_ms: Some(1_700_000_000_000),
            ttl_ms: 60_000,
        }
    }

    #[test]
    fn maintenance_interval_is_fail_closed() {
        let key = LockKey::new("tests/options").unwrap();
        let acquire = AcquireOptions::default().ttl(Duration::from_millis(100));
        assert!(
            LeaseMaintenanceOptions::default()
                .renew_interval(Duration::from_millis(50))
                .validate(&key, &acquire, true)
                .is_ok()
        );
        for interval in [Duration::ZERO, Duration::from_millis(51)] {
            let error = LeaseMaintenanceOptions::default()
                .renew_interval(interval)
                .validate(&key, &acquire, true)
                .unwrap_err();
            assert_eq!(error.kind, LockErrorKind::InvalidPlan);
        }
    }

    #[test]
    fn renewal_must_preserve_fenced_identity() {
        let original = grant();
        assert!(validate_renewed_grant(&original, &original).is_ok());

        let mut changed = original.clone();
        changed.fencing_token += 1;
        let error = validate_renewed_grant(&original, &changed).unwrap_err();
        assert_eq!(error.kind, LockErrorKind::LostLease);
        assert_eq!(error.step, Some(LockStep::FiduciaRenew));

        let mut changed = original.clone();
        changed.holder = "holder-b".into();
        assert!(validate_renewed_grant(&original, &changed).is_err());

        let mut changed = original.clone();
        changed.key = LockKey::new("tests/other").unwrap();
        assert!(validate_renewed_grant(&original, &changed).is_err());
    }
}
