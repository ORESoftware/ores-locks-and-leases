//! The lock plan: which layers, in which order, as data.
//!
//! Every runtime derives its behavior from the same pure function so the
//! ordering guarantee — fiducia outermost, advisory lock inside, work innermost
//! — is a checked fact rather than a convention. The matrix lives in
//! `conformance/cases/lock-plan.json`.

use std::fmt;

/// Which coordination layers a routine engages. Both `false` is a deliberate
/// pass-through for tests and single-writer development.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct LockLayers {
    /// The fiducia-cloud lease: outermost, cross-host, TTL-bounded, fenced.
    pub fiducia: bool,
    /// A Postgres advisory lock: inner, single-database, released by Postgres.
    pub pg_advisory: bool,
}

impl LockLayers {
    pub const NONE: Self = Self {
        fiducia: false,
        pg_advisory: false,
    };
    pub const FIDUCIA_ONLY: Self = Self {
        fiducia: true,
        pg_advisory: false,
    };
    pub const PG_ONLY: Self = Self {
        fiducia: false,
        pg_advisory: true,
    };
    pub const BOTH: Self = Self {
        fiducia: true,
        pg_advisory: true,
    };
}

/// How the Postgres advisory lock is scoped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum PgScope {
    /// `pg_advisory_xact_lock` inside a transaction the routine opens; the
    /// caller's work runs inside that transaction and the lock is released
    /// at commit or rollback.
    #[default]
    Transaction,
    /// `pg_advisory_lock` / `pg_advisory_unlock` on one dedicated connection.
    /// No transaction is opened — for work that must not run inside one.
    Session,
}

impl PgScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Transaction => "transaction",
            Self::Session => "session",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "transaction" => Some(Self::Transaction),
            "session" => Some(Self::Session),
            _ => None,
        }
    }
}

impl fmt::Display for PgScope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One action in a [`LockPlan`]. The string forms are the contract's
/// `LockStep` enum values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LockStep {
    FiduciaAcquire,
    FiduciaTryAcquire,
    FiduciaRelease,
    PgBegin,
    PgAdvisoryXactLock,
    PgTryAdvisoryXactLock,
    PgCommit,
    PgRollback,
    PgAdvisoryLock,
    PgTryAdvisoryLock,
    PgAdvisoryUnlock,
    Work,
}

impl LockStep {
    pub const ALL: [Self; 12] = [
        Self::FiduciaAcquire,
        Self::FiduciaTryAcquire,
        Self::FiduciaRelease,
        Self::PgBegin,
        Self::PgAdvisoryXactLock,
        Self::PgTryAdvisoryXactLock,
        Self::PgCommit,
        Self::PgRollback,
        Self::PgAdvisoryLock,
        Self::PgTryAdvisoryLock,
        Self::PgAdvisoryUnlock,
        Self::Work,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::FiduciaAcquire => "fiducia.acquire",
            Self::FiduciaTryAcquire => "fiducia.try_acquire",
            Self::FiduciaRelease => "fiducia.release",
            Self::PgBegin => "pg.begin",
            Self::PgAdvisoryXactLock => "pg.advisory_xact_lock",
            Self::PgTryAdvisoryXactLock => "pg.try_advisory_xact_lock",
            Self::PgCommit => "pg.commit",
            Self::PgRollback => "pg.rollback",
            Self::PgAdvisoryLock => "pg.advisory_lock",
            Self::PgTryAdvisoryLock => "pg.try_advisory_lock",
            Self::PgAdvisoryUnlock => "pg.advisory_unlock",
            Self::Work => "work",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|step| step.as_str() == value)
    }
}

impl fmt::Display for LockStep {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The ordered actions for one `(layers, scope, wait)` tuple.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LockPlan {
    pub layers: LockLayers,
    pub pg_scope: PgScope,
    pub wait: bool,
    pub steps: Vec<LockStep>,
}

/// Compute the plan. Pure; identical across every language slice.
///
/// `wait == true` blocks each layer up to its budget; `wait == false` uses the
/// non-blocking form of each acquisition and fails fast with
/// [`crate::LockErrorKind::Contention`].
pub fn plan(layers: LockLayers, pg_scope: PgScope, wait: bool) -> LockPlan {
    use LockStep::*;
    let mut steps = Vec::with_capacity(6);

    if layers.fiducia {
        steps.push(if wait {
            FiduciaAcquire
        } else {
            FiduciaTryAcquire
        });
    }
    match (layers.pg_advisory, pg_scope) {
        (false, _) => steps.push(Work),
        (true, PgScope::Transaction) => {
            steps.push(PgBegin);
            steps.push(if wait {
                PgAdvisoryXactLock
            } else {
                PgTryAdvisoryXactLock
            });
            steps.push(Work);
            steps.push(PgCommit);
        }
        (true, PgScope::Session) => {
            steps.push(if wait {
                PgAdvisoryLock
            } else {
                PgTryAdvisoryLock
            });
            steps.push(Work);
            steps.push(PgAdvisoryUnlock);
        }
    }
    if layers.fiducia {
        steps.push(FiduciaRelease);
    }

    LockPlan {
        layers,
        pg_scope,
        wait,
        steps,
    }
}

#[cfg(test)]
mod tests {
    use super::LockStep::*;
    use super::*;

    #[test]
    fn neither_layer_is_a_pass_through() {
        assert_eq!(
            plan(LockLayers::NONE, PgScope::Transaction, true).steps,
            [Work]
        );
        assert_eq!(
            plan(LockLayers::NONE, PgScope::Session, false).steps,
            [Work]
        );
    }

    #[test]
    fn fiducia_wraps_everything() {
        let both = plan(LockLayers::BOTH, PgScope::Transaction, true).steps;
        assert_eq!(both.first(), Some(&FiduciaAcquire));
        assert_eq!(both.last(), Some(&FiduciaRelease));
        assert_eq!(
            both,
            [
                FiduciaAcquire,
                PgBegin,
                PgAdvisoryXactLock,
                Work,
                PgCommit,
                FiduciaRelease
            ]
        );
    }

    #[test]
    fn session_scope_opens_no_transaction() {
        let steps = plan(LockLayers::PG_ONLY, PgScope::Session, false).steps;
        assert_eq!(steps, [PgTryAdvisoryLock, Work, PgAdvisoryUnlock]);
        assert!(!steps.contains(&PgBegin));
    }

    #[test]
    fn work_appears_exactly_once_in_every_plan() {
        for layers in [
            LockLayers::NONE,
            LockLayers::FIDUCIA_ONLY,
            LockLayers::PG_ONLY,
            LockLayers::BOTH,
        ] {
            for scope in [PgScope::Transaction, PgScope::Session] {
                for wait in [true, false] {
                    let steps = plan(layers, scope, wait).steps;
                    assert_eq!(steps.iter().filter(|s| **s == Work).count(), 1);
                }
            }
        }
    }

    #[test]
    fn step_names_round_trip() {
        for step in LockStep::ALL {
            assert_eq!(LockStep::parse(step.as_str()), Some(step));
        }
        assert_eq!(LockStep::parse("nope"), None);
        assert_eq!(PgScope::parse("session"), Some(PgScope::Session));
    }
}
