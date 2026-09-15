//! [`Lease`] over the official fiducia-cloud async Rust client.
//!
//! The fiducia node never holds a request open: `acquire` returns at once
//! with `acquired: false` when the key is held, so the *client* owns the
//! wait. This adapter polls at `opts.retry_interval` until the grant arrives
//! or `opts.wait_timeout` elapses — the same cadence the official sync
//! client's `must_lock` uses.

use std::time::{Duration, Instant};

use fiducia_client::AsyncFiduciaClient;
use serde_json::json;

use crate::error::{LockError, LockErrorKind};
use crate::key::LockKey;
use crate::lease::{AcquireOptions, Lease, LeaseGrant, duration_ms, valid_request_id};
use crate::plan::LockStep;

/// A fiducia-cloud lease authority.
#[derive(Debug)]
pub struct FiduciaLease {
    client: AsyncFiduciaClient,
}

impl FiduciaLease {
    pub fn new(client: AsyncFiduciaClient) -> Self {
        Self { client }
    }

    /// The trusted internal hop straight to a fiducia-node.
    pub fn internal(base_url: &str, internal_secret: &str, org_id: &str) -> Self {
        Self::new(AsyncFiduciaClient::internal(
            base_url,
            internal_secret,
            org_id,
        ))
    }

    /// A public edge or load-balancer endpoint authenticated with an API key.
    pub fn bearer(base_url: &str, api_key: &str) -> Self {
        Self::new(AsyncFiduciaClient::bearer(base_url, api_key))
    }

    pub fn client(&self) -> &AsyncFiduciaClient {
        &self.client
    }
}

fn transport(key: &LockKey, err: fiducia_client::Error) -> LockError {
    LockError::new(LockErrorKind::Transport, key, format!("{err:?}"))
}

fn generated_identity(prefix: &str) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    let digest = crate::key::fnv1a64(&format!("{now}:{pid}:{sequence}:{prefix}"));
    format!("{prefix}-{pid:08x}-{digest:016x}")
}

/// An unguessable-enough holder identity. Holder names participate in queue
/// identity and cancellation authority, so a bare pid/counter is not enough;
/// callers with a real identity should set `AcquireOptions::holder`.
fn generated_holder() -> String {
    generated_identity("ores-locks")
}

/// Stable identity for one logical acquisition. It is generated once before
/// polling and is deliberately independent from the holder identity.
fn generated_request_id() -> String {
    generated_identity("ores-lock-request")
}

impl Lease for FiduciaLease {
    async fn acquire(
        &self,
        key: &LockKey,
        opts: &AcquireOptions,
        wait: bool,
    ) -> Result<LeaseGrant, LockError> {
        let holder = opts.holder.clone().unwrap_or_else(generated_holder);
        let request_id = opts.request_id.clone().unwrap_or_else(generated_request_id);
        if !valid_request_id(&request_id) {
            return Err(LockError::invalid_plan(
                key,
                "request_id must contain 1..=256 characters",
            ));
        }
        let ttl_ms = opts.ttl_ms();
        let started = Instant::now();
        loop {
            let response = self
                .client
                .request(
                    "POST",
                    "/v1/locks/acquire",
                    Some(json!({
                        "key": key.as_str(),
                        "holder": holder,
                        "ttl_ms": ttl_ms,
                        "request_id": request_id,
                    })),
                )
                .await
                .map_err(|err| transport(key, err))?;
            let output = &response["result"]["output"];
            if output["acquired"].as_bool().unwrap_or(false) {
                let fencing_token = output["fencing_token"].as_u64().ok_or_else(|| {
                    LockError::new(
                        LockErrorKind::Transport,
                        key,
                        "fiducia: acquired without a positive integer fencing token",
                    )
                })?;
                if fencing_token == 0 {
                    return Err(LockError::new(
                        LockErrorKind::Transport,
                        key,
                        "fiducia: acquired with zero fencing token",
                    ));
                }
                return Ok(LeaseGrant {
                    key: key.clone(),
                    holder,
                    fencing_token,
                    lease_expires_ms: output["lease_expires_ms"].as_u64(),
                    ttl_ms,
                });
            }
            if !wait {
                return Err(LockError::contention(key, LockStep::FiduciaTryAcquire));
            }
            let waited = started.elapsed();
            if waited + opts.retry_interval > opts.wait_timeout {
                return Err(LockError::timeout(
                    key,
                    LockStep::FiduciaAcquire,
                    duration_ms(waited),
                ));
            }
            tokio::time::sleep(opts.retry_interval).await;
        }
    }

    async fn renew(&self, grant: &LeaseGrant, ttl: Duration) -> Result<LeaseGrant, LockError> {
        let ttl_ms = duration_ms(ttl);
        match self
            .client
            .renew(
                grant.key.as_str(),
                &grant.holder,
                grant.fencing_token,
                ttl_ms,
            )
            .await
        {
            Ok(lease_expires_ms) => Ok(LeaseGrant {
                lease_expires_ms,
                ttl_ms,
                ..grant.clone()
            }),
            // The client surfaces `renewed: false` as a transport error whose
            // text names lost authority; that is `lost_lease`, not a retry.
            Err(fiducia_client::Error::Transport(message))
                if message.contains("lost fenced authority") =>
            {
                Err(LockError::new(
                    LockErrorKind::LostLease,
                    &grant.key,
                    message,
                ))
            }
            Err(err) => Err(transport(&grant.key, err)),
        }
    }

    async fn release(&self, grant: &LeaseGrant) -> Result<bool, LockError> {
        self.client
            .release(grant.key.as_str(), &grant.holder, grant.fencing_token)
            .await
            .map_err(|err| transport(&grant.key, err).at(LockStep::FiduciaRelease))
    }
}
