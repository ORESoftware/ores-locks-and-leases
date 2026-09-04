//! The composed routines: fiducia lease *around* a Postgres advisory lock.
//!
//! Both layers are runtime-switchable through [`LockLayers`] — enable one,
//! both, or neither — and the order is the contract's:
//!
//! ```text
//! fiducia.acquire ─► pg.begin ─► pg.advisory_xact_lock ─► work ─► pg.commit ─► fiducia.release
//! fiducia.acquire ─► pg.advisory_lock ─► work ─► pg.advisory_unlock ─► fiducia.release
//! ```
//!
//! Every failure past a successful acquisition still unwinds what was held:
//! a failed inner acquisition releases the fiducia lease; a failed `work`
//! rolls the transaction back (or unlocks the session) and releases the
//! lease. The fencing token is handed to `work` so guarded writes can carry
//! it.

use std::fmt;

use sea_orm::{DatabaseTransaction, TransactionTrait};

use crate::error::{LockError, LockErrorKind};
use crate::key::LockKey;
use crate::lease::{AcquireOptions, Lease, LeaseGrant, WorkFuture, release_lost, tag_step};
use crate::pg::{self, DedicatedConnection};
use crate::plan::{LockLayers, LockStep};

/// What `work` receives: whichever layers are engaged, borrowed for the
/// duration of the guarded section.
#[derive(Debug)]
pub struct Guarded<'a> {
    pub key: &'a LockKey,
    /// The fiducia grant, when `layers.fiducia` is on. Its `fencing_token`
    /// is what guarded writes should record.
    pub grant: Option<&'a LeaseGrant>,
    /// The transaction holding the advisory lock, when `layers.pg_advisory`
    /// is on with [`PgScope::Transaction`]. Run every statement of the work
    /// through it; the lock is released when the routine commits it.
    pub txn: Option<&'a DatabaseTransaction>,
}

impl Guarded<'_> {
    pub fn fencing_token(&self) -> Option<u64> {
        self.grant.map(|grant| grant.fencing_token)
    }
}

/// Run `work` under a fiducia lease and/or a transaction-scoped advisory lock.
///
/// * `layers.fiducia` needs `lease`; `layers.pg_advisory` needs `db`.
///   A missing one is [`LockErrorKind::InvalidPlan`] before anything is
///   acquired.
/// * `wait == false` uses the non-blocking form of every acquisition and
///   fails fast with [`LockErrorKind::Contention`].
/// * The transaction is committed after `work` succeeds and rolled back when
///   it fails; the lease is released in both cases. A commit failure is
///   [`LockErrorKind::Database`] at `pg.commit`.
/// * If `work` and commit succeeded but the lease had already lapsed, the
///   result is [`LockErrorKind::LostLease`] — the effects are durable but may
///   have raced the next holder.
pub async fn with_xact_lock<L, C, T, E, F>(
    key: &LockKey,
    layers: LockLayers,
    wait: bool,
    opts: &AcquireOptions,
    lease: Option<&L>,
    db: Option<&C>,
    work: F,
) -> Result<T, LockError>
where
    L: Lease + Sync,
    C: TransactionTrait,
    E: fmt::Display,
    F: for<'a> FnOnce(Guarded<'a>) -> WorkFuture<'a, T, E>,
{
    let lease = pick_lease(key, layers, lease)?;
    let db = if layers.pg_advisory {
        Some(db.ok_or_else(|| {
            LockError::invalid_plan(
                key,
                "layers.pg_advisory is enabled but no database connection was supplied",
            )
        })?)
    } else {
        None
    };

    let grant = acquire_lease(key, wait, opts, lease).await?;

    let inner = async {
        match db {
            None => work(Guarded {
                key,
                grant: grant.as_ref(),
                txn: None,
            })
            .await
            .map_err(|cause| LockError::work(key, cause)),
            Some(db) => {
                let txn = db.begin().await.map_err(|err| {
                    LockError::new(LockErrorKind::Database, key, err.to_string())
                        .at(LockStep::PgBegin)
                })?;
                let locked = if wait {
                    pg::xact_lock(&txn, key).await
                } else {
                    pg::try_xact_lock(&txn, key).await
                };
                if let Err(err) = locked {
                    let _ = txn.rollback().await;
                    return Err(err);
                }
                let outcome = work(Guarded {
                    key,
                    grant: grant.as_ref(),
                    txn: Some(&txn),
                })
                .await
                .map_err(|cause| LockError::work(key, cause));
                match outcome {
                    Ok(value) => txn.commit().await.map(|_| value).map_err(|err| {
                        LockError::new(LockErrorKind::Database, key, err.to_string())
                            .at(LockStep::PgCommit)
                    }),
                    Err(err) => {
                        let _ = txn.rollback().await;
                        Err(err)
                    }
                }
            }
        }
    }
    .await;

    settle(key, lease, grant, inner).await
}

/// Run `work` under a fiducia lease and/or a *session*-scoped advisory lock.
/// No transaction is opened: this is the routine for work that must not run
/// inside one (DDL that cannot, long jobs that commit in batches, or work
/// that touches no database at all).
///
/// The session lock needs a [`DedicatedConnection`]; the routine unlocks it
/// after `work` whether or not `work` succeeded. An unlock that reports the
/// session did not hold the lock is [`LockErrorKind::Database`] at
/// `pg.advisory_unlock` (and wins over a successful `work`, because it means
/// the exclusion the caller relied on was not real).
pub async fn with_session_lock<L, T, E, F>(
    key: &LockKey,
    layers: LockLayers,
    wait: bool,
    opts: &AcquireOptions,
    lease: Option<&L>,
    conn: Option<&DedicatedConnection>,
    work: F,
) -> Result<T, LockError>
where
    L: Lease + Sync,
    E: fmt::Display,
    F: for<'a> FnOnce(Guarded<'a>) -> WorkFuture<'a, T, E>,
{
    let lease = pick_lease(key, layers, lease)?;
    let conn = if layers.pg_advisory {
        Some(conn.ok_or_else(|| {
            LockError::invalid_plan(
                key,
                "layers.pg_advisory is enabled with session scope but no dedicated connection was supplied",
            )
        })?)
    } else {
        None
    };

    let grant = acquire_lease(key, wait, opts, lease).await?;

    let inner = async {
        match conn {
            None => work(Guarded {
                key,
                grant: grant.as_ref(),
                txn: None,
            })
            .await
            .map_err(|cause| LockError::work(key, cause)),
            Some(conn) => {
                if wait {
                    pg::session_lock(conn, key).await?;
                } else {
                    pg::try_session_lock(conn, key).await?;
                }
                let outcome = work(Guarded {
                    key,
                    grant: grant.as_ref(),
                    txn: None,
                })
                .await
                .map_err(|cause| LockError::work(key, cause));
                let mut unlocked = pg::session_unlock(conn, key).await;
                if !matches!(&unlocked, Ok(true)) {
                    // A failed/mismatched unlock leaves the physical session
                    // unsafe to reuse. This dedicated pool has one session,
                    // so closing it by reference destroys that session before
                    // the cleanup error is returned.
                    if let Err(close_err) = conn.inner().close_by_ref().await {
                        let close_err = LockError::new(
                            LockErrorKind::Database,
                            key,
                            format!("failed to close the uncertain dedicated session: {close_err}"),
                        )
                        .at(LockStep::PgAdvisoryUnlock);
                        unlocked = Err(match unlocked {
                            Err(unlock_err) => close_err.after_inner_failure(&unlock_err),
                            Ok(false) => close_err.after_inner_failure(
                                &LockError::new(
                                    LockErrorKind::Database,
                                    key,
                                    "pg_advisory_unlock reported the session did not hold the lock",
                                )
                                .at(LockStep::PgAdvisoryUnlock),
                            ),
                            Ok(true) => close_err,
                        });
                    }
                }
                settle_session(key, outcome, unlocked)
            }
        }
    }
    .await;

    settle(key, lease, grant, inner).await
}

fn settle_session<T>(
    key: &LockKey,
    inner: Result<T, LockError>,
    unlocked: Result<bool, LockError>,
) -> Result<T, LockError> {
    let cleanup = match unlocked {
        Err(err) => Some(err),
        Ok(false) => Some(
            LockError::new(
                LockErrorKind::Database,
                key,
                "pg_advisory_unlock reported the session did not hold the lock",
            )
            .at(LockStep::PgAdvisoryUnlock),
        ),
        Ok(true) => None,
    };
    match (inner, cleanup) {
        (Err(inner_err), Some(cleanup_err)) => Err(cleanup_err.after_inner_failure(&inner_err)),
        (Err(inner_err), None) => Err(inner_err),
        (Ok(_), Some(cleanup_err)) => Err(cleanup_err),
        (Ok(value), None) => Ok(value),
    }
}

fn pick_lease<'l, L: Lease>(
    key: &LockKey,
    layers: LockLayers,
    lease: Option<&'l L>,
) -> Result<Option<&'l L>, LockError> {
    if !layers.fiducia {
        return Ok(None);
    }
    lease.map(Some).ok_or_else(|| {
        LockError::invalid_plan(
            key,
            "layers.fiducia is enabled but no lease authority was supplied",
        )
    })
}

async fn acquire_lease<L: Lease + Sync>(
    key: &LockKey,
    wait: bool,
    opts: &AcquireOptions,
    lease: Option<&L>,
) -> Result<Option<LeaseGrant>, LockError> {
    let Some(lease) = lease else {
        return Ok(None);
    };
    let step = if wait {
        LockStep::FiduciaAcquire
    } else {
        LockStep::FiduciaTryAcquire
    };
    lease
        .acquire(key, opts, wait)
        .await
        .map(Some)
        .map_err(|err| tag_step(err, step))
}

/// Release the lease (if any) and combine its outcome with the inner one.
async fn settle<L: Lease + Sync, T>(
    key: &LockKey,
    lease: Option<&L>,
    grant: Option<LeaseGrant>,
    inner: Result<T, LockError>,
) -> Result<T, LockError> {
    let (Some(lease), Some(grant)) = (lease, grant) else {
        return inner;
    };
    let released = lease
        .release(&grant)
        .await
        .map_err(|err| tag_step(err, LockStep::FiduciaRelease));
    match (inner, released) {
        (Err(inner_err), Err(release_err)) => Err(release_err.after_inner_failure(&inner_err)),
        (Err(inner_err), Ok(false)) => {
            Err(release_lost(key, &grant).after_inner_failure(&inner_err))
        }
        (Err(inner_err), Ok(true)) => Err(inner_err),
        (Ok(_), Err(release_err)) => Err(release_err),
        (Ok(_), Ok(false)) => Err(release_lost(key, &grant)),
        (Ok(value), Ok(true)) => Ok(value),
    }
}

/// A convenience for the most common tuple: both layers, transaction scope,
/// blocking wait, default options.
pub async fn with_both<L, C, T, E, F>(
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
    with_xact_lock(
        key,
        LockLayers::BOTH,
        true,
        &AcquireOptions::default(),
        Some(lease),
        Some(db),
        work,
    )
    .await
}

#[cfg(test)]
mod tests {
    use std::future::Future;

    use super::*;
    use crate::lease::fake::FakeLease;

    fn key() -> LockKey {
        LockKey::new("test/coordinated/cleanup").expect("valid test key")
    }

    fn block_on<F: Future>(future: F) -> F::Output {
        use std::task::{Context, Poll, Waker};
        let mut cx = Context::from_waker(Waker::noop());
        let mut future = std::pin::pin!(future);
        loop {
            if let Poll::Ready(value) = future.as_mut().poll(&mut cx) {
                return value;
            }
        }
    }

    #[test]
    fn session_cleanup_failure_wins_over_work_failure() {
        let key = key();
        let inner = Err::<(), _>(LockError::work(&key, "work failed"));
        let cleanup = Err(
            LockError::new(LockErrorKind::Database, &key, "unlock transport failed")
                .at(LockStep::PgAdvisoryUnlock),
        );
        let err = settle_session(&key, inner, cleanup).expect_err("cleanup must fail");
        assert_eq!(err.kind, LockErrorKind::Database);
        assert_eq!(err.step, Some(LockStep::PgAdvisoryUnlock));
        assert!(err.message.contains("work failed"));
    }

    #[test]
    fn outer_release_failure_wins_over_inner_failure() {
        let key = key();
        let lease = FakeLease {
            error_on_release: true,
            ..FakeLease::default()
        };
        let grant = block_on(lease.acquire(&key, &AcquireOptions::default(), true))
            .expect("acquire fake lease");
        let inner = Err::<(), _>(LockError::work(&key, "work failed"));
        let err = block_on(settle(&key, Some(&lease), Some(grant), inner))
            .expect_err("release must fail");
        assert_eq!(err.kind, LockErrorKind::Transport);
        assert_eq!(err.step, Some(LockStep::FiduciaRelease));
        assert!(err.message.contains("work failed"));
    }
}
