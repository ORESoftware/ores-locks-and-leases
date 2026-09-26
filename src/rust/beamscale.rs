//! BeamScale Durable Object / critical-section lease adapter.
//!
//! BeamScale's full authority token is (runtime_epoch, owner_epoch, sequence).
//! The shared Lease fencing token is the persisted monotonic sequence; this
//! adapter retains the full token privately for renew/release.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::error::{LockError, LockErrorKind};
use crate::key::LockKey;
use crate::lease::{AcquireOptions, Lease, LeaseGrant, duration_ms};
use crate::plan::LockStep;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct BeamScaleCriticalSectionToken {
    pub runtime_epoch: u64,
    pub owner_epoch: u64,
    pub sequence: u64,
}

impl BeamScaleCriticalSectionToken {
    fn valid(self) -> bool {
        self.runtime_epoch > 0 && self.owner_epoch > 0 && self.sequence > 0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BeamScaleCriticalSectionGrant {
    pub token: BeamScaleCriticalSectionToken,
    pub lease_expires_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BeamScaleAcquireResult {
    Acquired(BeamScaleCriticalSectionGrant),
    Contended,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BeamScaleRenewResult {
    Renewed(BeamScaleCriticalSectionGrant),
    Lost,
}

pub trait BeamScaleCriticalSectionTransport: Sync {
    fn acquire(
        &self,
        key: &LockKey,
        holder: &str,
        request_id: &str,
        ttl_ms: u64,
    ) -> impl Future<Output = Result<BeamScaleAcquireResult, String>> + Send;

    fn renew(
        &self,
        key: &LockKey,
        holder: &str,
        token: BeamScaleCriticalSectionToken,
        ttl_ms: u64,
    ) -> impl Future<Output = Result<BeamScaleRenewResult, String>> + Send;

    fn release(
        &self,
        key: &LockKey,
        holder: &str,
        token: BeamScaleCriticalSectionToken,
    ) -> impl Future<Output = Result<bool, String>> + Send;
}

pub struct BeamScaleCriticalSectionLease<T> {
    transport: T,
    tokens: Mutex<HashMap<(String, String, u64), BeamScaleCriticalSectionToken>>,
}

impl<T> BeamScaleCriticalSectionLease<T> {
    pub fn new(transport: T) -> Self {
        Self {
            transport,
            tokens: Mutex::new(HashMap::new()),
        }
    }

    pub fn transport(&self) -> &T {
        &self.transport
    }

    pub fn into_transport(self) -> T {
        self.transport
    }

    fn registry_key(grant: &LeaseGrant) -> (String, String, u64) {
        (
            grant.key.as_str().to_owned(),
            grant.holder.clone(),
            grant.fencing_token,
        )
    }

    fn lookup(&self, grant: &LeaseGrant) -> Result<BeamScaleCriticalSectionToken, LockError> {
        self.tokens
            .lock()
            .unwrap()
            .get(&Self::registry_key(grant))
            .copied()
            .ok_or_else(|| {
                LockError::new(
                    LockErrorKind::LostLease,
                    &grant.key,
                    "beamscale: full authority token is unavailable for this grant",
                )
            })
    }

    fn remember(
        &self,
        key: &LockKey,
        holder: &str,
        grant: &BeamScaleCriticalSectionGrant,
    ) -> Result<u64, LockError> {
        if !grant.token.valid() || grant.lease_expires_ms == 0 {
            return Err(transport_error(key, "invalid BeamScale grant"));
        }
        let fencing_token = grant.token.sequence;
        self.tokens.lock().unwrap().insert(
            (key.as_str().to_owned(), holder.to_owned(), fencing_token),
            grant.token,
        );
        Ok(fencing_token)
    }

    fn forget(&self, grant: &LeaseGrant) {
        self.tokens.lock().unwrap().remove(&Self::registry_key(grant));
    }
}

fn generated_identity(prefix: &str) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    let digest = crate::key::fnv1a64(&format!("{prefix}:{now}:{pid}:{sequence}"));
    format!("{prefix}-{pid:08x}-{digest:016x}")
}

fn transport_error(key: &LockKey, message: impl Into<String>) -> LockError {
    LockError::new(
        LockErrorKind::Transport,
        key,
        format!("beamscale: {}", message.into()),
    )
}

impl<T> Lease for BeamScaleCriticalSectionLease<T>
where
    T: BeamScaleCriticalSectionTransport,
{
    async fn acquire(
        &self,
        key: &LockKey,
        opts: &AcquireOptions,
        wait: bool,
    ) -> Result<LeaseGrant, LockError> {
        let holder = opts
            .holder
            .clone()
            .unwrap_or_else(|| generated_identity("ores-holder"));
        let request_id = generated_identity("ores-request");
        let ttl_ms = opts.ttl_ms();
        if ttl_ms == 0 {
            return Err(LockError::invalid_plan(
                key,
                "BeamScale lease ttl must be positive",
            ));
        }

        let started = Instant::now();
        let mut ambiguous_retries = 0u8;
        loop {
            let result = match self
                .transport
                .acquire(key, &holder, &request_id, ttl_ms)
                .await
            {
                Ok(result) => result,
                Err(_message) if ambiguous_retries == 0 => {
                    ambiguous_retries = 1;
                    continue;
                }
                Err(message) => return Err(transport_error(key, message)),
            };

            match result {
                BeamScaleAcquireResult::Acquired(native) => {
                    let fencing_token = self.remember(key, &holder, &native)?;
                    return Ok(LeaseGrant {
                        key: key.clone(),
                        holder,
                        fencing_token,
                        lease_expires_ms: Some(native.lease_expires_ms),
                        ttl_ms,
                    });
                }
                BeamScaleAcquireResult::Contended if !wait => {
                    return Err(LockError::contention(
                        key,
                        LockStep::FiduciaTryAcquire,
                    ));
                }
                BeamScaleAcquireResult::Contended => {
                    let waited = started.elapsed();
                    if waited + opts.retry_interval > opts.wait_timeout {
                        return Err(LockError::timeout(
                            key,
                            LockStep::FiduciaAcquire,
                            duration_ms(waited),
                        ));
                    }
                    portable_sleep(opts.retry_interval).await;
                }
            }
        }
    }

    async fn renew(
        &self,
        grant: &LeaseGrant,
        ttl: Duration,
    ) -> Result<LeaseGrant, LockError> {
        let ttl_ms = duration_ms(ttl);
        if ttl_ms == 0 {
            return Err(LockError::invalid_plan(
                &grant.key,
                "BeamScale renewal ttl must be positive",
            ));
        }
        let expected = self.lookup(grant)?;
        match self
            .transport
            .renew(&grant.key, &grant.holder, expected, ttl_ms)
            .await
            .map_err(|message| transport_error(&grant.key, message))?
        {
            BeamScaleRenewResult::Lost => {
                self.forget(grant);
                Err(LockError::new(
                    LockErrorKind::LostLease,
                    &grant.key,
                    "beamscale: renewal refused; fenced authority is lost",
                ))
            }
            BeamScaleRenewResult::Renewed(native) => {
                if native.token != expected || native.lease_expires_ms == 0 {
                    self.forget(grant);
                    return Err(LockError::new(
                        LockErrorKind::LostLease,
                        &grant.key,
                        "beamscale: renewal changed or omitted the full authority token",
                    ));
                }
                Ok(LeaseGrant {
                    lease_expires_ms: Some(native.lease_expires_ms),
                    ttl_ms,
                    ..grant.clone()
                })
            }
        }
    }

    async fn release(&self, grant: &LeaseGrant) -> Result<bool, LockError> {
        let token = self.lookup(grant)?;
        let released = self
            .transport
            .release(&grant.key, &grant.holder, token)
            .await
            .map_err(|message| transport_error(&grant.key, message))?;
        self.forget(grant);
        Ok(released)
    }
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

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use super::*;

    #[derive(Default)]
    struct FakeTransport {
        acquires: Mutex<Vec<(String, String, String, u64)>>,
        acquire_results: Mutex<VecDeque<Result<BeamScaleAcquireResult, String>>>,
        renew_results: Mutex<VecDeque<Result<BeamScaleRenewResult, String>>>,
        release_results: Mutex<VecDeque<Result<bool, String>>>,
    }

    impl BeamScaleCriticalSectionTransport for FakeTransport {
        async fn acquire(
            &self,
            key: &LockKey,
            holder: &str,
            request_id: &str,
            ttl_ms: u64,
        ) -> Result<BeamScaleAcquireResult, String> {
            self.acquires.lock().unwrap().push((
                key.as_str().to_owned(),
                holder.to_owned(),
                request_id.to_owned(),
                ttl_ms,
            ));
            self.acquire_results
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(Ok(BeamScaleAcquireResult::Contended))
        }

        async fn renew(
            &self,
            _key: &LockKey,
            _holder: &str,
            _token: BeamScaleCriticalSectionToken,
            _ttl_ms: u64,
        ) -> Result<BeamScaleRenewResult, String> {
            self.renew_results
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(Ok(BeamScaleRenewResult::Lost))
        }

        async fn release(
            &self,
            _key: &LockKey,
            _holder: &str,
            _token: BeamScaleCriticalSectionToken,
        ) -> Result<bool, String> {
            self.release_results
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(Ok(false))
        }
    }

    fn token(sequence: u64) -> BeamScaleCriticalSectionToken {
        BeamScaleCriticalSectionToken {
            runtime_epoch: 41,
            owner_epoch: 7,
            sequence,
        }
    }

    fn native(sequence: u64, expiry: u64) -> BeamScaleCriticalSectionGrant {
        BeamScaleCriticalSectionGrant {
            token: token(sequence),
            lease_expires_ms: expiry,
        }
    }

    fn key() -> LockKey {
        LockKey::new("beamscale/rust/provider").unwrap()
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
    fn sequence_is_external_fence_and_cloned_grant_keeps_full_authority() {
        let transport = FakeTransport::default();
        transport.acquire_results.lock().unwrap().push_back(Ok(
            BeamScaleAcquireResult::Acquired(native(13, 100_000)),
        ));
        transport.renew_results.lock().unwrap().push_back(Ok(
            BeamScaleRenewResult::Renewed(native(13, 160_000)),
        ));
        transport.release_results.lock().unwrap().push_back(Ok(true));

        let lease = BeamScaleCriticalSectionLease::new(transport);
        let grant = block_on(lease.acquire(
            &key(),
            &AcquireOptions::default().holder("worker-a"),
            false,
        ))
        .unwrap();
        assert_eq!(grant.fencing_token, 13);

        let renewed =
            block_on(lease.renew(&grant.clone(), Duration::from_secs(60))).unwrap();
        assert_eq!(renewed.fencing_token, 13);
        assert_eq!(renewed.lease_expires_ms, Some(160_000));
        assert!(block_on(lease.release(&renewed.clone())).unwrap());
    }

    #[test]
    fn ambiguous_acquire_retries_once_with_same_request_identity() {
        let transport = FakeTransport::default();
        transport
            .acquire_results
            .lock()
            .unwrap()
            .push_back(Err("connection reset".into()));
        transport.acquire_results.lock().unwrap().push_back(Ok(
            BeamScaleAcquireResult::Acquired(native(17, 100_000)),
        ));

        let lease = BeamScaleCriticalSectionLease::new(transport);
        let grant = block_on(lease.acquire(
            &key(),
            &AcquireOptions::default().holder("worker-a"),
            true,
        ))
        .unwrap();
        assert_eq!(grant.fencing_token, 17);

        let calls = lease.transport().acquires.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].2, calls[1].2);
    }

    #[test]
    fn changed_token_on_renewal_is_lost_lease() {
        let transport = FakeTransport::default();
        transport.acquire_results.lock().unwrap().push_back(Ok(
            BeamScaleAcquireResult::Acquired(native(3, 100_000)),
        ));
        transport.renew_results.lock().unwrap().push_back(Ok(
            BeamScaleRenewResult::Renewed(native(4, 160_000)),
        ));

        let lease = BeamScaleCriticalSectionLease::new(transport);
        let grant = block_on(lease.acquire(
            &key(),
            &AcquireOptions::default().holder("worker-a"),
            false,
        ))
        .unwrap();
        let error =
            block_on(lease.renew(&grant, Duration::from_secs(60))).unwrap_err();
        assert_eq!(error.kind, LockErrorKind::LostLease);
    }
}
