//! The outer layer: a fenced, TTL-bounded lease from a lease authority.
//!
//! [`Lease`] is the seam between this crate and fiducia-cloud (or any
//! authority with the same three verbs). The `fiducia` feature ships the
//! adapter over the official async client; tests use in-memory fakes.

use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use crate::error::{LockError, LockErrorKind};
use crate::key::LockKey;
use crate::plan::LockStep;

/// A monotonically increasing token minted on every grant. Guarded writes
/// should record it (`WHERE fencing_token < $new`) so a holder whose lease
/// lapsed cannot overwrite a newer holder's work.
pub type FencingToken = u64;

/// Acquisition tuning shared by every layer. Contract model `AcquireOptions`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcquireOptions {
    /// Lease TTL for the fiducia layer. The lease lapses if never renewed or
    /// released — size it to the *longest* the guarded work can take.
    pub ttl: Duration,
    /// Total time to keep waiting before giving up. Ignored when `wait` is
    /// false.
    pub wait_timeout: Duration,
    /// Poll interval while waiting on the fiducia layer.
    pub retry_interval: Duration,
    /// Caller identity for the fiducia layer; also the release key. `None`
    /// lets the adapter generate an unguessable id.
    pub holder: Option<String>,
}

impl Default for AcquireOptions {
    fn default() -> Self {
        Self {
            ttl: Duration::from_secs(60),
            wait_timeout: Duration::from_secs(30),
            retry_interval: Duration::from_millis(250),
            holder: None,
        }
    }
}

impl AcquireOptions {
    pub fn ttl(mut self, ttl: Duration) -> Self {
        self.ttl = ttl;
        self
    }
    pub fn wait_timeout(mut self, wait_timeout: Duration) -> Self {
        self.wait_timeout = wait_timeout;
        self
    }
    pub fn retry_interval(mut self, retry_interval: Duration) -> Self {
        self.retry_interval = retry_interval;
        self
    }
    pub fn holder(mut self, holder: impl Into<String>) -> Self {
        self.holder = Some(holder.into());
        self
    }
    pub fn ttl_ms(&self) -> u64 {
        duration_ms(self.ttl)
    }
    pub fn wait_timeout_ms(&self) -> u64 {
        duration_ms(self.wait_timeout)
    }
    pub fn retry_interval_ms(&self) -> u64 {
        duration_ms(self.retry_interval)
    }
}

pub(crate) fn duration_ms(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

/// A held grant. Contract model `LeaseGrant`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeaseGrant {
    pub key: LockKey,
    pub holder: String,
    pub fencing_token: FencingToken,
    /// Absolute expiry in Unix milliseconds when the authority reports it.
    pub lease_expires_ms: Option<u64>,
    pub ttl_ms: u64,
}

/// A lease authority: three verbs, fenced.
///
/// Implementations map their native failures onto [`LockErrorKind`]:
/// contention (`wait == false`, held elsewhere), timeout (budget elapsed),
/// transport (unknown ownership), lost_lease (renewal refused).
pub trait Lease {
    /// Acquire `key`. With `wait`, block up to `opts.wait_timeout`; without it,
    /// return [`LockErrorKind::Contention`] at once if the key is held.
    fn acquire(
        &self,
        key: &LockKey,
        opts: &AcquireOptions,
        wait: bool,
    ) -> impl Future<Output = Result<LeaseGrant, LockError>> + Send;

    /// Extend a grant without changing its fencing token. A refusal is
    /// [`LockErrorKind::LostLease`], never a warning.
    fn renew(
        &self,
        grant: &LeaseGrant,
        ttl: Duration,
    ) -> impl Future<Output = Result<LeaseGrant, LockError>> + Send;

    /// Release a grant. `Ok(false)` is a committed no-op: the authority
    /// matched no grant, which almost always means the lease had already
    /// lapsed while the work ran.
    fn release(&self, grant: &LeaseGrant) -> impl Future<Output = Result<bool, LockError>> + Send;
}

/// The lease type to name when a routine's fiducia layer is disabled:
/// `None::<&NoLease>`. Every verb is an `invalid_plan` error.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoLease;

impl Lease for NoLease {
    async fn acquire(
        &self,
        key: &LockKey,
        _opts: &AcquireOptions,
        _wait: bool,
    ) -> Result<LeaseGrant, LockError> {
        Err(LockError::invalid_plan(
            key,
            "no lease authority configured",
        ))
    }
    async fn renew(&self, grant: &LeaseGrant, _ttl: Duration) -> Result<LeaseGrant, LockError> {
        Err(LockError::invalid_plan(
            &grant.key,
            "no lease authority configured",
        ))
    }
    async fn release(&self, grant: &LeaseGrant) -> Result<bool, LockError> {
        Err(LockError::invalid_plan(
            &grant.key,
            "no lease authority configured",
        ))
    }
}

/// The future a guarded closure returns. Boxed so the closure can borrow the
/// grant (and, with the `pg` feature, the transaction) for exactly as long as
/// the routine holds them.
pub type WorkFuture<'a, T, E> = Pin<Box<dyn Future<Output = Result<T, E>> + Send + 'a>>;

/// Run `work` under a fiducia lease only — no database layer. This is the
/// routine for work that touches no Postgres, or that manages its own
/// transactions and only needs cross-host exclusion and a fencing token.
///
/// `engage == false` is the contract's "neither" plan: `work` runs with
/// `None` and nothing is acquired. `engage == true` with no `lease` is
/// `invalid_plan`.
///
/// Ordering: acquire → work → release. The lease is always released, even
/// when `work` fails. If `work` succeeded but the authority reports that the
/// release matched no grant, the result is [`LockErrorKind::LostLease`]: the
/// lease lapsed while the work ran and its effects may have raced the next
/// holder — the caller decides whether that is recoverable.
pub async fn with_lease<L, T, E, F>(
    key: &LockKey,
    engage: bool,
    wait: bool,
    opts: &AcquireOptions,
    lease: Option<&L>,
    work: F,
) -> Result<T, LockError>
where
    L: Lease + Sync,
    E: fmt::Display,
    F: for<'a> FnOnce(Option<&'a LeaseGrant>) -> WorkFuture<'a, T, E>,
{
    if !engage {
        return work(None)
            .await
            .map_err(|cause| LockError::work(key, cause));
    }
    let Some(lease) = lease else {
        return Err(LockError::invalid_plan(
            key,
            "layers.fiducia is enabled but no lease authority was supplied",
        ));
    };

    let acquire_step = if wait {
        LockStep::FiduciaAcquire
    } else {
        LockStep::FiduciaTryAcquire
    };
    let grant = lease
        .acquire(key, opts, wait)
        .await
        .map_err(|err| tag_step(err, acquire_step))?;

    let outcome = work(Some(&grant))
        .await
        .map_err(|cause| LockError::work(key, cause));

    let released = lease
        .release(&grant)
        .await
        .map_err(|err| tag_step(err, LockStep::FiduciaRelease));

    match (outcome, released) {
        (Err(work_err), _) => Err(work_err),
        (Ok(_), Err(release_err)) => Err(release_err),
        (Ok(_), Ok(false)) => Err(LockError::new(
            LockErrorKind::LostLease,
            key,
            format!(
                "release of `{key}` (holder {}, fencing token {}) matched no grant: the lease lapsed while the work ran",
                grant.holder, grant.fencing_token
            ),
        )
        .at(LockStep::FiduciaRelease)),
        (Ok(value), Ok(true)) => Ok(value),
    }
}

pub(crate) fn tag_step(err: LockError, step: LockStep) -> LockError {
    if err.step.is_some() {
        err
    } else {
        err.at(step)
    }
}

#[cfg(test)]
pub(crate) mod fake {
    //! An in-memory lease authority for tests: single-holder, fencing tokens
    //! count up, and a scripted "lapse" makes release report no grant.

    use std::sync::Mutex;

    use super::*;

    #[derive(Default)]
    pub struct FakeLease {
        pub held_by: Mutex<Option<(String, String)>>, // (key, holder)
        pub next_token: Mutex<FencingToken>,
        pub lapse_on_release: bool,
        pub log: Mutex<Vec<LockStep>>,
    }

    impl FakeLease {
        pub fn steps(&self) -> Vec<LockStep> {
            self.log.lock().unwrap().clone()
        }
    }

    impl Lease for FakeLease {
        async fn acquire(
            &self,
            key: &LockKey,
            opts: &AcquireOptions,
            wait: bool,
        ) -> Result<LeaseGrant, LockError> {
            self.log.lock().unwrap().push(if wait {
                LockStep::FiduciaAcquire
            } else {
                LockStep::FiduciaTryAcquire
            });
            let mut held = self.held_by.lock().unwrap();
            if held.is_some() {
                return Err(if wait {
                    LockError::timeout(key, LockStep::FiduciaAcquire, opts.wait_timeout_ms())
                } else {
                    LockError::contention(key, LockStep::FiduciaTryAcquire)
                });
            }
            let holder = opts
                .holder
                .clone()
                .unwrap_or_else(|| "fake-holder".to_string());
            *held = Some((key.as_str().to_string(), holder.clone()));
            let mut token = self.next_token.lock().unwrap();
            *token += 1;
            Ok(LeaseGrant {
                key: key.clone(),
                holder,
                fencing_token: *token,
                lease_expires_ms: None,
                ttl_ms: opts.ttl_ms(),
            })
        }

        async fn renew(&self, grant: &LeaseGrant, ttl: Duration) -> Result<LeaseGrant, LockError> {
            let mut renewed = grant.clone();
            renewed.ttl_ms = duration_ms(ttl);
            Ok(renewed)
        }

        async fn release(&self, grant: &LeaseGrant) -> Result<bool, LockError> {
            self.log.lock().unwrap().push(LockStep::FiduciaRelease);
            let mut held = self.held_by.lock().unwrap();
            let matched = held
                .as_ref()
                .is_some_and(|(k, h)| k == grant.key.as_str() && *h == grant.holder);
            *held = None;
            Ok(matched && !self.lapse_on_release)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::FakeLease;
    use super::*;

    fn key() -> LockKey {
        LockKey::new("test/lease/unit").unwrap()
    }

    fn block_on<F: Future>(future: F) -> F::Output {
        use std::sync::Arc;
        use std::task::{Context, Poll, Wake, Waker};
        struct Noop;
        impl Wake for Noop {
            fn wake(self: Arc<Self>) {}
        }
        let waker = Waker::from(Arc::new(Noop));
        let mut cx = Context::from_waker(&waker);
        let mut future = std::pin::pin!(future);
        loop {
            if let Poll::Ready(value) = future.as_mut().poll(&mut cx) {
                return value;
            }
        }
    }

    #[test]
    fn disabled_layer_runs_work_with_no_grant() {
        let lease = FakeLease::default();
        let result = block_on(with_lease(
            &key(),
            false,
            true,
            &AcquireOptions::default(),
            Some(&lease),
            |grant| Box::pin(async move { Ok::<_, String>(grant.is_none()) }),
        ));
        assert_eq!(result, Ok(true));
        assert!(lease.steps().is_empty());
    }

    #[test]
    fn enabled_layer_without_authority_is_invalid_plan() {
        let result = block_on(with_lease(
            &key(),
            true,
            true,
            &AcquireOptions::default(),
            None::<&NoLease>,
            |_| Box::pin(async { Ok::<_, String>(()) }),
        ));
        assert_eq!(result.unwrap_err().kind, LockErrorKind::InvalidPlan);
    }

    #[test]
    fn acquire_work_release_in_order_with_a_fencing_token() {
        let lease = FakeLease::default();
        let result = block_on(with_lease(
            &key(),
            true,
            true,
            &AcquireOptions::default(),
            Some(&lease),
            |grant| Box::pin(async move { Ok::<_, String>(grant.unwrap().fencing_token) }),
        ));
        assert_eq!(result, Ok(1));
        assert_eq!(
            lease.steps(),
            [LockStep::FiduciaAcquire, LockStep::FiduciaRelease]
        );
        assert!(lease.held_by.lock().unwrap().is_none());
    }

    #[test]
    fn work_failure_still_releases_and_is_reported_as_work() {
        let lease = FakeLease::default();
        let result = block_on(with_lease(
            &key(),
            true,
            false,
            &AcquireOptions::default(),
            Some(&lease),
            |_| Box::pin(async { Err::<(), _>("kaboom") }),
        ));
        let err = result.unwrap_err();
        assert_eq!(err.kind, LockErrorKind::Work);
        assert_eq!(err.step, Some(LockStep::Work));
        assert_eq!(err.message, "kaboom");
        assert!(lease.held_by.lock().unwrap().is_none());
    }

    #[test]
    fn held_key_is_contention_without_wait_and_timeout_with_wait() {
        let lease = FakeLease::default();
        *lease.held_by.lock().unwrap() = Some(("test/lease/unit".into(), "other".into()));
        let try_err = block_on(with_lease(
            &key(),
            true,
            false,
            &AcquireOptions::default(),
            Some(&lease),
            |_| Box::pin(async { Ok::<(), String>(()) }),
        ))
        .unwrap_err();
        assert_eq!(try_err.kind, LockErrorKind::Contention);
        assert_eq!(try_err.step, Some(LockStep::FiduciaTryAcquire));
        let wait_err = block_on(with_lease(
            &key(),
            true,
            true,
            &AcquireOptions::default(),
            Some(&lease),
            |_| Box::pin(async { Ok::<(), String>(()) }),
        ))
        .unwrap_err();
        assert_eq!(wait_err.kind, LockErrorKind::Timeout);
    }

    #[test]
    fn a_lapsed_lease_is_lost_lease_even_when_work_succeeded() {
        let lease = FakeLease {
            lapse_on_release: true,
            ..FakeLease::default()
        };
        let err = block_on(with_lease(
            &key(),
            true,
            true,
            &AcquireOptions::default(),
            Some(&lease),
            |_| Box::pin(async { Ok::<(), String>(()) }),
        ))
        .unwrap_err();
        assert_eq!(err.kind, LockErrorKind::LostLease);
        assert_eq!(err.step, Some(LockStep::FiduciaRelease));
    }
}
