//! Managed lease-authority adapters that preserve the core crate's dependency-free seam.
//!
//! [`ManagedLease`] implements [`crate::Lease`] over a caller-provided transport.
//! This lets Rust services use Cloudflare Durable Objects or Redis without forcing
//! a particular HTTP/Redis client into every `*-lib-core`. The repository ships
//! concrete wire/service implementations for both backends under `managed/`, and
//! callers can adapt their existing reqwest, Cloudflare, Redis, or Upstash client.
//!
//! The observable plan still uses the historical `fiducia.*` step names for wire
//! and conformance compatibility. Those names mean "outer fenced lease authority"
//! until the next contract-major version; they do not require Fiducia as backend.

use std::future::Future;
use std::time::{Duration, Instant};

use crate::error::{LockError, LockErrorKind};
use crate::key::LockKey;
use crate::lease::{AcquireOptions, Lease, LeaseGrant, duration_ms};

/// Production authority selected behind the generic [`Lease`] seam.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ManagedLeaseBackend {
    CloudflareDurableObject,
    Redis,
}

impl ManagedLeaseBackend {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::CloudflareDurableObject => "cloudflare_durable_object",
            Self::Redis => "redis",
        }
    }
}

/// A successful native grant returned by a managed transport.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedGrant {
    pub fencing_token: u64,
    pub lease_expires_ms: Option<u64>,
}

/// Acquire result from an authority before client-side wait/retry policy is applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManagedAcquireResult {
    Acquired(ManagedGrant),
    Contended,
}

/// Renewal result. Refusal means the old holder has lost fenced authority.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManagedRenewResult {
    Renewed { lease_expires_ms: Option<u64> },
    Lost,
}

/// Minimal transport contract for a production managed lease authority.
///
/// Implementations MUST make each verb atomic at the authority. In particular:
///
/// - acquire mints a strictly increasing fencing token only when it wins;
/// - renew matches `(key, holder, fencing_token)` and never changes the token;
/// - release deletes only that exact grant;
/// - transport ambiguity is returned as `Err`, never as contention/no-op.
///
/// The Cloudflare reference implementation maps one lock key to one Durable
/// Object. The Redis reference scripts use a lease key plus persistent decimal
/// counter in the same cluster hash slot.
pub trait ManagedLeaseTransport: Sync {
    fn acquire(
        &self,
        backend: ManagedLeaseBackend,
        key: &LockKey,
        holder: &str,
        ttl_ms: u64,
    ) -> impl Future<Output = Result<ManagedAcquireResult, String>> + Send;

    fn renew(
        &self,
        backend: ManagedLeaseBackend,
        grant: &LeaseGrant,
        ttl_ms: u64,
    ) -> impl Future<Output = Result<ManagedRenewResult, String>> + Send;

    fn release(
        &self,
        backend: ManagedLeaseBackend,
        grant: &LeaseGrant,
    ) -> impl Future<Output = Result<bool, String>> + Send;
}

/// A concrete [`Lease`] backed by a managed transport.
///
/// Use [`ManagedLease::cloudflare`] or [`ManagedLease::redis`] rather than
/// constructing the backend discriminator manually.
pub struct ManagedLease<T> {
    backend: ManagedLeaseBackend,
    transport: T,
}

impl<T> ManagedLease<T> {
    pub const fn cloudflare(transport: T) -> Self {
        Self {
            backend: ManagedLeaseBackend::CloudflareDurableObject,
            transport,
        }
    }

    pub const fn redis(transport: T) -> Self {
        Self {
            backend: ManagedLeaseBackend::Redis,
            transport,
        }
    }

    pub const fn backend(&self) -> ManagedLeaseBackend {
        self.backend
    }

    pub const fn transport(&self) -> &T {
        &self.transport
    }

    pub fn into_transport(self) -> T {
        self.transport
    }
}

/// Readable aliases for service wiring.
pub type CloudflareDurableObjectLease<T> = ManagedLease<T>;
pub type RedisLease<T> = ManagedLease<T>;

fn generated_holder() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    let digest = crate::key::fnv1a64(&format!("{now}:{pid}:{sequence}"));
    format!("ores-locks-{pid:08x}-{digest:016x}")
}

fn transport_error(backend: ManagedLeaseBackend, key: &LockKey, message: String) -> LockError {
    LockError::new(
        LockErrorKind::Transport,
        key,
        format!("{}: {message}", backend.as_str()),
    )
}

impl<T> Lease for ManagedLease<T>
where
    T: ManagedLeaseTransport,
{
    async fn acquire(
        &self,
        key: &LockKey,
        opts: &AcquireOptions,
        wait: bool,
    ) -> Result<LeaseGrant, LockError> {
        let holder = opts.holder.clone().unwrap_or_else(generated_holder);
        let ttl_ms = opts.ttl_ms();
        if ttl_ms == 0 {
            return Err(LockError::invalid_plan(
                key,
                "managed lease ttl must be positive",
            ));
        }

        let started = Instant::now();
        loop {
            match self
                .transport
                .acquire(self.backend, key, &holder, ttl_ms)
                .await
                .map_err(|message| transport_error(self.backend, key, message))?
            {
                ManagedAcquireResult::Acquired(grant) => {
                    return Ok(LeaseGrant {
                        key: key.clone(),
                        holder,
                        fencing_token: grant.fencing_token,
                        lease_expires_ms: grant.lease_expires_ms,
                        ttl_ms,
                    });
                }
                ManagedAcquireResult::Contended if !wait => {
                    return Err(LockError::contention(
                        key,
                        crate::plan::LockStep::FiduciaTryAcquire,
                    ));
                }
                ManagedAcquireResult::Contended => {
                    let waited = started.elapsed();
                    if waited + opts.retry_interval > opts.wait_timeout {
                        return Err(LockError::timeout(
                            key,
                            crate::plan::LockStep::FiduciaAcquire,
                            duration_ms(waited),
                        ));
                    }
                    portable_sleep(opts.retry_interval).await;
                }
            }
        }
    }

    async fn renew(&self, grant: &LeaseGrant, ttl: Duration) -> Result<LeaseGrant, LockError> {
        let ttl_ms = duration_ms(ttl);
        if ttl_ms == 0 {
            return Err(LockError::invalid_plan(
                &grant.key,
                "managed lease renewal ttl must be positive",
            ));
        }
        match self
            .transport
            .renew(self.backend, grant, ttl_ms)
            .await
            .map_err(|message| transport_error(self.backend, &grant.key, message))?
        {
            ManagedRenewResult::Renewed { lease_expires_ms } => Ok(LeaseGrant {
                lease_expires_ms,
                ttl_ms,
                ..grant.clone()
            }),
            ManagedRenewResult::Lost => Err(LockError::new(
                LockErrorKind::LostLease,
                &grant.key,
                format!(
                    "{} refused renewal: fenced authority is lost",
                    self.backend.as_str()
                ),
            )),
        }
    }

    async fn release(&self, grant: &LeaseGrant) -> Result<bool, LockError> {
        self.transport
            .release(self.backend, grant)
            .await
            .map_err(|message| transport_error(self.backend, &grant.key, message))
    }
}

// Keep the dependency-free core independent of a particular async runtime
// without blocking the caller's executor thread during contention. Each retry
// interval uses one short-lived sleeper thread which wakes the future. Native
// runtime-specific transports may still choose `wait=false` and own retries
// when they need a higher-throughput scheduler.
async fn portable_sleep(duration: Duration) {
    use std::sync::{
        Arc, Mutex,
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

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    #[derive(Default)]
    struct FakeTransport {
        next_token: Mutex<u64>,
        held: Mutex<Option<(String, String, u64)>>,
    }

    impl ManagedLeaseTransport for FakeTransport {
        async fn acquire(
            &self,
            _backend: ManagedLeaseBackend,
            key: &LockKey,
            holder: &str,
            _ttl_ms: u64,
        ) -> Result<ManagedAcquireResult, String> {
            let mut held = self.held.lock().unwrap();
            if held.is_some() {
                return Ok(ManagedAcquireResult::Contended);
            }
            let mut token = self.next_token.lock().unwrap();
            *token += 1;
            *held = Some((key.as_str().to_string(), holder.to_string(), *token));
            Ok(ManagedAcquireResult::Acquired(ManagedGrant {
                fencing_token: *token,
                lease_expires_ms: Some(123_456),
            }))
        }

        async fn renew(
            &self,
            _backend: ManagedLeaseBackend,
            grant: &LeaseGrant,
            _ttl_ms: u64,
        ) -> Result<ManagedRenewResult, String> {
            let held = self.held.lock().unwrap();
            let matches = held.as_ref().is_some_and(|(key, holder, token)| {
                key == grant.key.as_str()
                    && holder == &grant.holder
                    && *token == grant.fencing_token
            });
            Ok(if matches {
                ManagedRenewResult::Renewed {
                    lease_expires_ms: Some(234_567),
                }
            } else {
                ManagedRenewResult::Lost
            })
        }

        async fn release(
            &self,
            _backend: ManagedLeaseBackend,
            grant: &LeaseGrant,
        ) -> Result<bool, String> {
            let mut held = self.held.lock().unwrap();
            let matches = held.as_ref().is_some_and(|(key, holder, token)| {
                key == grant.key.as_str()
                    && holder == &grant.holder
                    && *token == grant.fencing_token
            });
            if matches {
                *held = None;
            }
            Ok(matches)
        }
    }

    fn key() -> LockKey {
        LockKey::new("managed/backend/unit").unwrap()
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
    fn cloudflare_and_redis_share_fenced_lease_semantics() {
        for backend in [
            ManagedLeaseBackend::CloudflareDurableObject,
            ManagedLeaseBackend::Redis,
        ] {
            let lease = match backend {
                ManagedLeaseBackend::CloudflareDurableObject => {
                    ManagedLease::cloudflare(FakeTransport::default())
                }
                ManagedLeaseBackend::Redis => ManagedLease::redis(FakeTransport::default()),
            };
            let opts = AcquireOptions::default().holder("worker-a");
            let grant = block_on(lease.acquire(&key(), &opts, false)).unwrap();
            assert_eq!(grant.fencing_token, 1);
            assert_eq!(grant.lease_expires_ms, Some(123_456));

            let renewed = block_on(lease.renew(&grant, Duration::from_secs(30))).unwrap();
            assert_eq!(renewed.fencing_token, grant.fencing_token);
            assert_eq!(renewed.lease_expires_ms, Some(234_567));
            assert!(block_on(lease.release(&renewed)).unwrap());
            assert!(!block_on(lease.release(&renewed)).unwrap());
        }
    }

    #[test]
    fn wrong_grant_cannot_renew_or_release() {
        let lease = ManagedLease::redis(FakeTransport::default());
        let opts = AcquireOptions::default().holder("worker-a");
        let grant = block_on(lease.acquire(&key(), &opts, false)).unwrap();
        let mut stale = grant.clone();
        stale.fencing_token += 1;

        let err = block_on(lease.renew(&stale, Duration::from_secs(30))).unwrap_err();
        assert_eq!(err.kind, LockErrorKind::LostLease);
        assert!(!block_on(lease.release(&stale)).unwrap());
        assert!(block_on(lease.release(&grant)).unwrap());
    }
}
