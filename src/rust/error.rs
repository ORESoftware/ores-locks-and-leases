//! The one structured failure every routine surfaces.

use std::fmt;

use crate::key::LockKey;
use crate::plan::LockStep;

/// Why an acquisition or guarded run failed. Contract enum `LockErrorKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LockErrorKind {
    /// A layer is held by someone else and `wait` was false.
    Contention,
    /// The wait budget elapsed before every layer was held.
    Timeout,
    /// The fiducia lease could not be renewed or was reaped. Fenced authority
    /// is gone; the guarded work must not continue.
    LostLease,
    /// Transport or HTTP failure talking to the lease authority. Ownership is
    /// unknown — never treat this as "not held".
    Transport,
    /// The database refused the advisory statement, the transaction, or the
    /// connection.
    Database,
    /// The caller's work returned an error. Outer layers were still released
    /// and the transaction, if any, rolled back.
    Work,
    /// The inputs cannot be planned (a Postgres layer with no connection, a
    /// session-scoped lock on a pooled connection, a non-Postgres backend).
    InvalidPlan,
}

impl LockErrorKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Contention => "contention",
            Self::Timeout => "timeout",
            Self::LostLease => "lost_lease",
            Self::Transport => "transport",
            Self::Database => "database",
            Self::Work => "work",
            Self::InvalidPlan => "invalid_plan",
        }
    }
}

impl fmt::Display for LockErrorKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Contract model `LockError`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LockError {
    pub kind: LockErrorKind,
    pub key: LockKey,
    /// Which step failed, when known.
    pub step: Option<LockStep>,
    pub message: String,
}

impl LockError {
    pub fn new(kind: LockErrorKind, key: &LockKey, message: impl Into<String>) -> Self {
        Self {
            kind,
            key: key.clone(),
            step: None,
            message: message.into(),
        }
    }

    pub fn at(mut self, step: LockStep) -> Self {
        self.step = Some(step);
        self
    }

    pub fn contention(key: &LockKey, step: LockStep) -> Self {
        Self::new(
            LockErrorKind::Contention,
            key,
            format!("`{key}` is held by another holder"),
        )
        .at(step)
    }

    pub fn timeout(key: &LockKey, step: LockStep, waited_ms: u64) -> Self {
        Self::new(
            LockErrorKind::Timeout,
            key,
            format!("gave up waiting for `{key}` after {waited_ms} ms"),
        )
        .at(step)
    }

    pub fn work(key: &LockKey, cause: impl fmt::Display) -> Self {
        Self::new(LockErrorKind::Work, key, cause.to_string()).at(LockStep::Work)
    }

    pub fn invalid_plan(key: &LockKey, message: impl Into<String>) -> Self {
        Self::new(LockErrorKind::InvalidPlan, key, message)
    }

    /// Preserve the safety-critical cleanup failure while retaining the
    /// inner failure in diagnostics. A failed release/unlock leaves ownership
    /// or session state unknown, so callers must see it instead of blindly
    /// retrying the guarded operation based only on its earlier failure.
    pub(crate) fn after_inner_failure(mut self, inner: &Self) -> Self {
        self.message.push_str("; guarded operation also failed: ");
        self.message.push_str(&inner.to_string());
        self
    }

    /// True when retrying the whole routine is reasonable: the layer was busy
    /// or the budget ran out, and nothing was left half-done.
    pub fn is_retryable(&self) -> bool {
        matches!(
            self.kind,
            LockErrorKind::Contention | LockErrorKind::Timeout
        )
    }
}

impl fmt::Display for LockError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.step {
            Some(step) => write!(
                f,
                "{} at {step} for `{}`: {}",
                self.kind, self.key, self.message
            ),
            None => write!(f, "{} for `{}`: {}", self.kind, self.key, self.message),
        }
    }
}

impl std::error::Error for LockError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_names_the_step_when_known() {
        let key = LockKey::new("a/b/c").unwrap();
        let err = LockError::contention(&key, LockStep::FiduciaTryAcquire);
        assert!(
            err.to_string()
                .starts_with("contention at fiducia.try_acquire for `a/b/c`")
        );
        assert!(err.is_retryable());
        assert!(!LockError::work(&key, "boom").is_retryable());
    }
}
