//! Deterministic, fail-closed supervision for long-running Fiducia leases.
//!
//! A renewal supervisor is cooperative: callers checkpoint it before every
//! authoritative commit. It does not make an unfenced external side effect
//! safe and it cannot undo effects that were emitted before a checkpoint.
//! Protected datastores must still admit the grant's fencing token atomically
//! with the mutation.

use std::error::Error;
use std::fmt;
use std::time::Duration;

use crate::{Lease, LeaseGrant, LockError};

/// Maximum logical millisecond value shared safely with browser runtimes.
pub const MAX_RENEWAL_CLOCK_MS: u64 = 9_007_199_254_740_991;

/// Maximum TTL representable without narrowing in every supported runtime.
/// Go and Dart both ultimately use signed 64-bit duration storage.
pub const MAX_RENEWAL_TTL_MS: u64 = 9_223_372_036_854;

/// Scheduling policy for one held grant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RenewalPolicy {
    /// Preferred interval between successful renewal checkpoints.
    pub renew_every: Duration,
    /// Latest acceptable window before the local deadline.
    pub safety_margin: Duration,
}

impl RenewalPolicy {
    pub const fn new(renew_every: Duration, safety_margin: Duration) -> Self {
        Self {
            renew_every,
            safety_margin,
        }
    }

    pub fn renew_every_ms(self) -> u64 {
        duration_ms(self.renew_every)
    }

    pub fn safety_margin_ms(self) -> u64 {
        duration_ms(self.safety_margin)
    }
}

impl Default for RenewalPolicy {
    fn default() -> Self {
        Self::new(Duration::from_secs(20), Duration::from_secs(10))
    }
}

/// Why this supervisor permanently stopped authorizing protected effects.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RenewalLossReason {
    InvalidPolicy,
    ClockRegression,
    Expired,
    RenewalFailed,
    IdentityChanged,
    TokenChanged,
    DeadlineMissing,
    DeadlineInvalid,
    DeadlineRegressed,
    CompletionAfterDeadline,
    DeadlineOverflow,
    InvalidTtl,
}

impl RenewalLossReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidPolicy => "invalid_policy",
            Self::ClockRegression => "clock_regression",
            Self::Expired => "expired",
            Self::RenewalFailed => "renewal_failed",
            Self::IdentityChanged => "identity_changed",
            Self::TokenChanged => "token_changed",
            Self::DeadlineMissing => "deadline_missing",
            Self::DeadlineInvalid => "deadline_invalid",
            Self::DeadlineRegressed => "deadline_regressed",
            Self::CompletionAfterDeadline => "completion_after_deadline",
            Self::DeadlineOverflow => "deadline_overflow",
            Self::InvalidTtl => "invalid_ttl",
        }
    }
}

impl fmt::Display for RenewalLossReason {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Terminal renewal error. Once stored by a supervisor, it is sticky.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenewalError {
    pub reason: RenewalLossReason,
    pub message: String,
    pub cause: Option<LockError>,
}

impl RenewalError {
    fn new(reason: RenewalLossReason, message: impl Into<String>) -> Self {
        Self {
            reason,
            message: message.into(),
            cause: None,
        }
    }

    fn caused_by(reason: RenewalLossReason, message: impl Into<String>, cause: LockError) -> Self {
        Self {
            reason,
            message: message.into(),
            cause: Some(cause),
        }
    }
}

impl fmt::Display for RenewalError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.cause {
            Some(cause) => write!(
                formatter,
                "{}: {}; cause: {cause}",
                self.reason, self.message
            ),
            None => write!(formatter, "{}: {}", self.reason, self.message),
        }
    }
}

impl Error for RenewalError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.cause
            .as_ref()
            .map(|cause| cause as &(dyn Error + 'static))
    }
}

/// Pure scheduling decision at one monotonic-clock observation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenewalDecision {
    Wait { check_in_ms: u64 },
    RenewNow,
    Lost { reason: RenewalLossReason },
}

/// Result of a successful asynchronous checkpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenewalCheckpoint {
    Wait { check_in_ms: u64 },
    Renewed { check_in_ms: u64 },
}

/// Source of process-local monotonic milliseconds.
pub trait MonotonicClock {
    fn now_ms(&self) -> u64;
}

impl<F> MonotonicClock for F
where
    F: Fn() -> u64,
{
    fn now_ms(&self) -> u64 {
        self()
    }
}

/// Sticky supervisor for one exact Fiducia grant identity.
#[derive(Debug, Clone)]
pub struct RenewalSupervisor {
    grant: LeaseGrant,
    policy: RenewalPolicy,
    local_deadline_ms: u64,
    next_renewal_ms: u64,
    last_observed_ms: u64,
    loss: Option<RenewalError>,
}

impl RenewalSupervisor {
    /// Start supervision at `now_ms`, measured by a monotonic process clock.
    pub fn new(
        grant: LeaseGrant,
        policy: RenewalPolicy,
        now_ms: u64,
    ) -> Result<Self, RenewalError> {
        validate_clock(now_ms)?;
        validate_authority_deadline(grant.lease_expires_ms)?;
        let (local_deadline_ms, next_renewal_ms) = schedule(now_ms, grant.ttl_ms, policy)?;
        Ok(Self {
            grant,
            policy,
            local_deadline_ms,
            next_renewal_ms,
            last_observed_ms: now_ms,
            loss: None,
        })
    }

    pub fn grant(&self) -> &LeaseGrant {
        &self.grant
    }

    pub const fn local_deadline_ms(&self) -> u64 {
        self.local_deadline_ms
    }

    pub const fn next_renewal_ms(&self) -> u64 {
        self.next_renewal_ms
    }

    pub fn loss(&self) -> Option<&RenewalError> {
        self.loss.as_ref()
    }

    pub fn is_live(&self) -> bool {
        self.loss.is_none()
    }

    /// Observe the clock and decide whether to wait, renew, or stop.
    pub fn decision(&mut self, now_ms: u64) -> RenewalDecision {
        if let Some(loss) = &self.loss {
            return RenewalDecision::Lost {
                reason: loss.reason,
            };
        }
        if let Err(error) = validate_clock(now_ms) {
            return self.lose(error);
        }
        if now_ms < self.last_observed_ms {
            return self.lose(RenewalError::new(
                RenewalLossReason::ClockRegression,
                format!(
                    "monotonic clock regressed from {} to {now_ms}",
                    self.last_observed_ms
                ),
            ));
        }
        self.last_observed_ms = now_ms;
        if now_ms >= self.local_deadline_ms {
            return self.lose(RenewalError::new(
                RenewalLossReason::Expired,
                format!(
                    "local lease deadline {} was reached at {now_ms}",
                    self.local_deadline_ms
                ),
            ));
        }
        if now_ms >= self.next_renewal_ms {
            RenewalDecision::RenewNow
        } else {
            RenewalDecision::Wait {
                check_in_ms: self.next_renewal_ms - now_ms,
            }
        }
    }

    /// Fail unless authority is still live at this checkpoint.
    pub fn assert_live(&mut self, now_ms: u64) -> Result<(), RenewalError> {
        match self.decision(now_ms) {
            RenewalDecision::Lost { .. } => Err(self
                .loss
                .clone()
                .expect("lost decision always records a terminal error")),
            RenewalDecision::Wait { .. } | RenewalDecision::RenewNow => Ok(()),
        }
    }

    /// Invoke `Lease::renew` only when due. Any failed or ambiguous renewal is
    /// terminal; subsequent checkpoints return the original sticky loss and do
    /// not contact the authority again.
    pub async fn checkpoint<L, C>(
        &mut self,
        lease: &L,
        clock: &C,
    ) -> Result<RenewalCheckpoint, RenewalError>
    where
        L: Lease + Sync,
        C: MonotonicClock,
    {
        match self.decision(clock.now_ms()) {
            RenewalDecision::Wait { check_in_ms } => {
                return Ok(RenewalCheckpoint::Wait { check_in_ms });
            }
            RenewalDecision::Lost { .. } => {
                return Err(self
                    .loss
                    .clone()
                    .expect("lost decision always records a terminal error"));
            }
            RenewalDecision::RenewNow => {}
        }

        let previous = self.grant.clone();
        let renewed = match lease
            .renew(&previous, Duration::from_millis(previous.ttl_ms))
            .await
        {
            Ok(renewed) => renewed,
            Err(cause) => {
                let error = RenewalError::caused_by(
                    RenewalLossReason::RenewalFailed,
                    "lease authority did not prove continued ownership",
                    cause,
                );
                self.lose(error);
                return Err(self.loss.clone().expect("loss was just recorded"));
            }
        };

        let completed_ms = clock.now_ms();
        self.accept_renewal(completed_ms, renewed)
    }

    /// Validate one successful authority response and advance the local window.
    pub fn accept_renewal(
        &mut self,
        completed_ms: u64,
        renewed: LeaseGrant,
    ) -> Result<RenewalCheckpoint, RenewalError> {
        if let Some(loss) = &self.loss {
            return Err(loss.clone());
        }
        if let Err(error) = validate_clock(completed_ms) {
            return Err(self.record(error));
        }
        if completed_ms < self.last_observed_ms {
            return Err(self.record(RenewalError::new(
                RenewalLossReason::ClockRegression,
                format!(
                    "monotonic clock regressed from {} to {completed_ms} during renewal",
                    self.last_observed_ms
                ),
            )));
        }
        self.last_observed_ms = completed_ms;
        if completed_ms >= self.local_deadline_ms {
            return Err(self.record(RenewalError::new(
                RenewalLossReason::CompletionAfterDeadline,
                format!(
                    "renewal completed at {completed_ms}, not before local deadline {}",
                    self.local_deadline_ms
                ),
            )));
        }
        if renewed.key != self.grant.key || renewed.holder != self.grant.holder {
            return Err(self.record(RenewalError::new(
                RenewalLossReason::IdentityChanged,
                "renewal changed the lock key or holder identity",
            )));
        }
        if renewed.fencing_token != self.grant.fencing_token {
            return Err(self.record(RenewalError::new(
                RenewalLossReason::TokenChanged,
                format!(
                    "renewal changed fencing token {} to {}",
                    self.grant.fencing_token, renewed.fencing_token
                ),
            )));
        }
        if let Err(error) =
            validate_deadline_progress(self.grant.lease_expires_ms, renewed.lease_expires_ms)
        {
            return Err(self.record(error));
        }
        let (local_deadline_ms, next_renewal_ms) =
            match schedule(completed_ms, renewed.ttl_ms, self.policy) {
                Ok(schedule) => schedule,
                Err(error) => return Err(self.record(error)),
            };
        self.grant = renewed;
        self.local_deadline_ms = local_deadline_ms;
        self.next_renewal_ms = next_renewal_ms;
        Ok(RenewalCheckpoint::Renewed {
            check_in_ms: next_renewal_ms - completed_ms,
        })
    }

    fn lose(&mut self, error: RenewalError) -> RenewalDecision {
        let reason = self.record(error).reason;
        RenewalDecision::Lost { reason }
    }

    fn record(&mut self, error: RenewalError) -> RenewalError {
        if self.loss.is_none() {
            self.loss = Some(error);
        }
        self.loss.clone().expect("terminal loss is present")
    }
}

fn duration_ms(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn validate_clock(now_ms: u64) -> Result<(), RenewalError> {
    if now_ms <= MAX_RENEWAL_CLOCK_MS {
        Ok(())
    } else {
        Err(RenewalError::new(
            RenewalLossReason::DeadlineOverflow,
            format!("logical clock {now_ms} exceeds {MAX_RENEWAL_CLOCK_MS}"),
        ))
    }
}

fn validate_authority_deadline(deadline: Option<u64>) -> Result<(), RenewalError> {
    match deadline {
        Some(0) => Err(RenewalError::new(
            RenewalLossReason::DeadlineInvalid,
            "authority deadline must be positive when present",
        )),
        Some(value) if value > MAX_RENEWAL_CLOCK_MS => Err(RenewalError::new(
            RenewalLossReason::DeadlineOverflow,
            format!("authority deadline {value} exceeds {MAX_RENEWAL_CLOCK_MS}"),
        )),
        _ => Ok(()),
    }
}

fn validate_deadline_progress(
    previous: Option<u64>,
    renewed: Option<u64>,
) -> Result<(), RenewalError> {
    validate_authority_deadline(renewed)?;
    match (previous, renewed) {
        (Some(_), None) => Err(RenewalError::new(
            RenewalLossReason::DeadlineMissing,
            "renewal omitted a deadline that the authority previously reported",
        )),
        (Some(previous), Some(next)) if next <= previous => Err(RenewalError::new(
            RenewalLossReason::DeadlineRegressed,
            format!("authority deadline did not advance: {previous} -> {next}"),
        )),
        _ => Ok(()),
    }
}

fn schedule(now_ms: u64, ttl_ms: u64, policy: RenewalPolicy) -> Result<(u64, u64), RenewalError> {
    if ttl_ms == 0 || ttl_ms > MAX_RENEWAL_TTL_MS {
        return Err(RenewalError::new(
            RenewalLossReason::InvalidTtl,
            format!("lease TTL must be within 1..={MAX_RENEWAL_TTL_MS} ms"),
        ));
    }
    let renew_every_ms = policy.renew_every_ms();
    let safety_margin_ms = policy.safety_margin_ms();
    if renew_every_ms == 0
        || safety_margin_ms == 0
        || renew_every_ms >= ttl_ms
        || safety_margin_ms >= ttl_ms
    {
        return Err(RenewalError::new(
            RenewalLossReason::InvalidPolicy,
            "renewal interval and safety margin must both be positive and less than the lease TTL",
        ));
    }
    let deadline_ms = now_ms
        .checked_add(ttl_ms)
        .filter(|value| *value <= MAX_RENEWAL_CLOCK_MS)
        .ok_or_else(|| {
            RenewalError::new(
                RenewalLossReason::DeadlineOverflow,
                "local lease deadline exceeds the shared logical-clock domain",
            )
        })?;
    let interval_due = now_ms.checked_add(renew_every_ms).ok_or_else(|| {
        RenewalError::new(
            RenewalLossReason::DeadlineOverflow,
            "renewal interval overflowed the logical clock",
        )
    })?;
    let margin_due = deadline_ms - safety_margin_ms;
    let next_renewal_ms = interval_due.min(margin_due);
    if next_renewal_ms <= now_ms {
        return Err(RenewalError::new(
            RenewalLossReason::InvalidPolicy,
            "renewal policy leaves no positive live interval",
        ));
    }
    Ok((deadline_ms, next_renewal_ms))
}
