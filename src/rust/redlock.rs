//! Redlock quorum lease composed with an independent fencing-token authority.
//!
//! Redlock provides a TTL-bounded distributed mutex; it does not inherently
//! provide the monotonically increasing fencing epoch a downstream datastore
//! needs in order to reject a stale client that resumes after its lease lapses.
//! This module deliberately keeps those responsibilities separate.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::error::{LockError, LockErrorKind};
use crate::key::LockKey;
use crate::lease::{AcquireOptions, Lease, LeaseGrant};
use crate::plan::LockStep;

pub type RedlockFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Acquisition failure classification supplied by the concrete Redlock client.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RedlockAcquireError {
    Contention(String),
    Transport(String),
}

/// Structural Redlock handle.
///
/// `expiration_ms` is the concrete Redlock library's already drift-adjusted
/// Unix epoch in milliseconds. It is required: synthesizing `now + ttl` after
/// acquisition can overstate authority when quorum acquisition or fence minting
/// was slow. Extending a lease never mints a new fencing token.
pub trait RedlockHandle: Send {
    fn expiration_ms(&self) -> u64;
    fn extend(&mut self, ttl_ms: u64) -> RedlockFuture<'_, Result<u64, String>>;
    fn release(&mut self) -> RedlockFuture<'_, Result<(), String>>;
}

/// Concrete Redlock libraries adapt to this small dependency-free seam.
pub trait RedlockClient: Sync {
    type Handle: RedlockHandle;

    fn acquire<'a>(
        &'a self,
        key: &'a LockKey,
        ttl_ms: u64,
    ) -> RedlockFuture<'a, Result<Self::Handle, RedlockAcquireError>>;
}

/// Strongly ordered source of fencing tokens.
///
/// Implementations must survive process restart/failover and return a token
/// strictly greater than every token previously returned for the same key.
pub trait FencingTokenAuthority: Sync {
    fn next_fencing_token<'a>(
        &'a self,
        key: &'a LockKey,
        holder: &'a str,
    ) -> RedlockFuture<'a, Result<u64, String>>;
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct GrantId {
    key: String,
    holder: String,
    fencing_token: u64,
}

impl GrantId {
    fn from_grant(grant: &LeaseGrant) -> Self {
        Self {
            key: grant.key.as_str().to_owned(),
            holder: grant.holder.clone(),
            fencing_token: grant.fencing_token,
        }
    }
}

/// Redlock quorum + monotonic fencing authority exposed through [`Lease`].
///
/// Ordering is fixed:
///
/// `Redlock acquire -> mint fence -> re-check expiry -> guarded work -> release`.
///
/// If fence allocation fails, or the Redlock validity window elapses while the
/// token is being allocated, the handle is released best-effort and no grant is
/// returned. Renewal extends the existing Redlock handle and keeps the original
/// fencing token unchanged.
pub struct FencedRedlockLease<R, F>
where
    R: RedlockClient,
{
    redlock: R,
    fencing: F,
    held: Mutex<HashMap<GrantId, R::Handle>>,
}

impl<R, F> FencedRedlockLease<R, F>
where
    R: RedlockClient,
{
    pub fn new(redlock: R, fencing: F) -> Self {
        Self {
            redlock,
            fencing,
            held: Mutex::new(HashMap::new()),
        }
    }

    pub fn redlock(&self) -> &R {
        &self.redlock
    }

    pub fn fencing(&self) -> &F {
        &self.fencing
    }
}

fn unix_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(duration_ms)
        .unwrap_or(0)
}

fn generated_holder() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    let digest = crate::key::fnv1a64(&format!("redlock:{now}:{pid}:{sequence}"));
    format!("redlock-{pid:08x}-{digest:016x}")
}

fn duration_ms(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

async fn portable_sleep(duration: Duration) {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    use std::task::{Poll, Waker};

    let state = Arc::new((AtomicBool::new(false), Mutex::new(None::<Waker>)));
    let sleeper = Arc::clone(&state);
    std::thread::spawn(move || {
        std::thread::sleep(duration);
        sleeper.0.store(true, Ordering::Release);
        if let Some(waker) = sleeper.1.lock().unwrap().take() {
            waker.wake();
        }
    });

    std::future::poll_fn(move |cx| {
        if state.0.load(Ordering::Acquire) {
            return Poll::Ready(());
        }
        *state.1.lock().unwrap() = Some(cx.waker().clone());
        if state.0.load(Ordering::Acquire) {
            Poll::Ready(())
        } else {
            Poll::Pending
        }
    })
    .await;
}

impl<R, F> Lease for FencedRedlockLease<R, F>
where
    R: RedlockClient + Sync,
    F: FencingTokenAuthority + Sync,
{
    async fn acquire(
        &self,
        key: &LockKey,
        opts: &AcquireOptions,
        wait: bool,
    ) -> Result<LeaseGrant, LockError> {
        let ttl_ms = opts.ttl_ms();
        if ttl_ms == 0 {
            return Err(LockError::invalid_plan(key, "Redlock ttl must be positive"));
        }

        let holder = opts.holder.clone().unwrap_or_else(generated_holder);
        let started = Instant::now();

        loop {
            let mut handle = match self.redlock.acquire(key, ttl_ms).await {
                Ok(handle) => handle,
                Err(RedlockAcquireError::Transport(message)) => {
                    return Err(LockError::new(LockErrorKind::Transport, key, message).at(
                        if wait {
                            LockStep::FiduciaAcquire
                        } else {
                            LockStep::FiduciaTryAcquire
                        },
                    ));
                }
                Err(RedlockAcquireError::Contention(_)) if !wait => {
                    return Err(LockError::contention(key, LockStep::FiduciaTryAcquire));
                }
                Err(RedlockAcquireError::Contention(_)) => {
                    let waited = started.elapsed();
                    if waited >= opts.wait_timeout {
                        return Err(LockError::timeout(
                            key,
                            LockStep::FiduciaAcquire,
                            duration_ms(waited),
                        ));
                    }
                    let remaining = opts.wait_timeout.saturating_sub(waited);
                    portable_sleep(opts.retry_interval.min(remaining)).await;
                    continue;
                }
            };

            if handle.expiration_ms() <= unix_now_ms() {
                let _ = handle.release().await;
                return Err(LockError::new(
                    LockErrorKind::LostLease,
                    key,
                    "Redlock grant was already expired when acquisition returned",
                ));
            }

            let fencing_token = match self.fencing.next_fencing_token(key, &holder).await {
                Ok(token) if token > 0 => token,
                Ok(_) => {
                    let _ = handle.release().await;
                    return Err(LockError::new(
                        LockErrorKind::Transport,
                        key,
                        "fencing authority returned a non-positive token",
                    )
                    .at(LockStep::FiduciaAcquire));
                }
                Err(message) => {
                    let _ = handle.release().await;
                    return Err(LockError::new(LockErrorKind::Transport, key, message)
                        .at(LockStep::FiduciaAcquire));
                }
            };

            // Fence allocation can wait on PostgreSQL, a Durable Object, or a
            // consensus authority. Never start guarded work if the Redlock
            // window elapsed while that stronger epoch was being allocated.
            let lease_expires_ms = handle.expiration_ms();
            if lease_expires_ms <= unix_now_ms() {
                let _ = handle.release().await;
                return Err(LockError::new(
                    LockErrorKind::LostLease,
                    key,
                    "Redlock grant expired while allocating its fencing token",
                ));
            }

            let grant = LeaseGrant {
                key: key.clone(),
                holder,
                fencing_token,
                lease_expires_ms: Some(lease_expires_ms),
                ttl_ms,
            };
            self.held
                .lock()
                .unwrap()
                .insert(GrantId::from_grant(&grant), handle);
            return Ok(grant);
        }
    }

    async fn renew(&self, grant: &LeaseGrant, ttl: Duration) -> Result<LeaseGrant, LockError> {
        let ttl_ms = duration_ms(ttl);
        if ttl_ms == 0 {
            return Err(LockError::invalid_plan(
                &grant.key,
                "Redlock renewal ttl must be positive",
            ));
        }

        let id = GrantId::from_grant(grant);
        let mut handle = self.held.lock().unwrap().remove(&id).ok_or_else(|| {
            LockError::new(
                LockErrorKind::LostLease,
                &grant.key,
                "Redlock grant is not held by this adapter instance; fenced authority is lost",
            )
        })?;

        let lease_expires_ms = match handle.extend(ttl_ms).await {
            Ok(expires) if expires > unix_now_ms() => expires,
            Ok(_) => {
                let _ = handle.release().await;
                return Err(LockError::new(
                    LockErrorKind::LostLease,
                    &grant.key,
                    "Redlock renewal returned an already-expired validity window",
                ));
            }
            Err(message) => {
                return Err(LockError::new(
                    LockErrorKind::LostLease,
                    &grant.key,
                    format!("Redlock quorum refused renewal: {message}"),
                ));
            }
        };

        let renewed = LeaseGrant {
            lease_expires_ms: Some(lease_expires_ms),
            ttl_ms,
            ..grant.clone()
        };
        self.held.lock().unwrap().insert(id, handle);
        Ok(renewed)
    }

    async fn release(&self, grant: &LeaseGrant) -> Result<bool, LockError> {
        let id = GrantId::from_grant(grant);
        let Some(mut handle) = self.held.lock().unwrap().remove(&id) else {
            return Ok(false);
        };

        match handle.release().await {
            Ok(()) => Ok(true),
            Err(message) => {
                // Release failure is ambiguous. Keep the local handle so the
                // caller can retry cleanup; never reinterpret it as "not held".
                self.held.lock().unwrap().insert(id, handle);
                Err(
                    LockError::new(LockErrorKind::Transport, &grant.key, message)
                        .at(LockStep::FiduciaRelease),
                )
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct FakeHandle {
        expires: u64,
        fail_extend: bool,
    }

    impl RedlockHandle for FakeHandle {
        fn expiration_ms(&self) -> u64 {
            self.expires
        }

        fn extend(&mut self, ttl_ms: u64) -> RedlockFuture<'_, Result<u64, String>> {
            Box::pin(async move {
                if self.fail_extend {
                    Err("quorum lost".into())
                } else {
                    self.expires = self.expires.saturating_add(ttl_ms);
                    Ok(self.expires)
                }
            })
        }

        fn release(&mut self) -> RedlockFuture<'_, Result<(), String>> {
            Box::pin(async { Ok(()) })
        }
    }

    struct FakeRedlock;

    impl RedlockClient for FakeRedlock {
        type Handle = FakeHandle;

        fn acquire<'a>(
            &'a self,
            _key: &'a LockKey,
            _ttl_ms: u64,
        ) -> RedlockFuture<'a, Result<Self::Handle, RedlockAcquireError>> {
            Box::pin(async {
                Ok(FakeHandle {
                    expires: unix_now_ms().saturating_add(60_000),
                    fail_extend: false,
                })
            })
        }
    }

    #[derive(Default)]
    struct FakeFence(AtomicU64);

    impl FencingTokenAuthority for FakeFence {
        fn next_fencing_token<'a>(
            &'a self,
            _key: &'a LockKey,
            _holder: &'a str,
        ) -> RedlockFuture<'a, Result<u64, String>> {
            Box::pin(async { Ok(self.0.fetch_add(1, Ordering::SeqCst) + 1) })
        }
    }

    #[tokio::test]
    async fn renewal_preserves_fencing_token() {
        let lease = FencedRedlockLease::new(FakeRedlock, FakeFence::default());
        let key = LockKey::new("redlock/rust").unwrap();
        let opts = AcquireOptions::default().holder("worker-a");
        let grant = lease.acquire(&key, &opts, false).await.unwrap();
        let renewed = lease.renew(&grant, Duration::from_secs(5)).await.unwrap();
        assert_eq!(renewed.fencing_token, grant.fencing_token);
        assert!(lease.release(&renewed).await.unwrap());
        assert!(!lease.release(&renewed).await.unwrap());
    }
}
