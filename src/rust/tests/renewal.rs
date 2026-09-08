use ores_locks_and_leases::{
    AcquireOptions, Lease, LeaseGrant, LockError, LockErrorKind, LockKey, MonotonicClock,
    RenewalCheckpoint, RenewalDecision, RenewalLossReason, RenewalPolicy, RenewalSupervisor,
};
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::Duration;

struct SequenceClock(Mutex<VecDeque<u64>>);

impl SequenceClock {
    fn new(values: impl IntoIterator<Item = u64>) -> Self {
        Self(Mutex::new(values.into_iter().collect()))
    }
}

impl MonotonicClock for SequenceClock {
    fn now_ms(&self) -> u64 {
        self.0
            .lock()
            .expect("clock lock")
            .pop_front()
            .expect("clock value")
    }
}

#[derive(Default)]
struct FakeLease {
    response: Mutex<Option<Result<LeaseGrant, LockError>>>,
    calls: Mutex<usize>,
}

impl FakeLease {
    fn returning(response: Result<LeaseGrant, LockError>) -> Self {
        Self {
            response: Mutex::new(Some(response)),
            calls: Mutex::new(0),
        }
    }

    fn calls(&self) -> usize {
        *self.calls.lock().expect("calls lock")
    }
}

impl Lease for FakeLease {
    async fn acquire(
        &self,
        key: &LockKey,
        _opts: &AcquireOptions,
        _wait: bool,
    ) -> Result<LeaseGrant, LockError> {
        Err(LockError::invalid_plan(key, "unused"))
    }

    async fn renew(&self, _grant: &LeaseGrant, _ttl: Duration) -> Result<LeaseGrant, LockError> {
        *self.calls.lock().expect("calls lock") += 1;
        self.response
            .lock()
            .expect("response lock")
            .take()
            .expect("one response")
    }

    async fn release(&self, _grant: &LeaseGrant) -> Result<bool, LockError> {
        Ok(true)
    }
}

fn grant(token: u64) -> LeaseGrant {
    LeaseGrant {
        key: LockKey::new("renewal/test/resource").expect("key"),
        holder: "holder-a".to_string(),
        fencing_token: token,
        lease_expires_ms: Some(100_000),
        ttl_ms: 10_000,
    }
}

fn policy() -> RenewalPolicy {
    RenewalPolicy::new(Duration::from_millis(4_000), Duration::from_millis(2_000))
}

fn block_on<F: std::future::Future>(future: F) -> F::Output {
    use std::task::{Context, Poll, Waker};
    let mut context = Context::from_waker(Waker::noop());
    let mut future = std::pin::pin!(future);
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut context) {
            return value;
        }
    }
}

#[test]
fn shared_renewal_decision_corpus() {
    let text = std::fs::read_to_string("../../conformance/cases/renewal-decision.json")
        .expect("renewal decision corpus");
    let corpus: serde_json::Value = serde_json::from_str(&text).expect("valid corpus JSON");
    let cases = corpus["cases"].as_array().expect("cases array");
    assert!(cases.len() >= 10);
    for entry in cases {
        let name = entry["name"].as_str().expect("case name");
        let start_ms = entry["startMs"].as_u64().expect("startMs");
        let ttl_ms = entry["ttlMs"].as_u64().expect("ttlMs");
        let renew_every_ms = entry["renewEveryMs"].as_u64().expect("renewEveryMs");
        let safety_margin_ms = entry["safetyMarginMs"].as_u64().expect("safetyMarginMs");
        let now_ms = entry["nowMs"].as_u64().expect("nowMs");
        let expected_kind = entry["expect"]["kind"].as_str().expect("expected kind");
        let expected_check_in = entry["expect"]["checkInMs"].as_u64().expect("checkInMs");
        let expected_reason = entry["expect"]["reason"].as_str().expect("reason");
        let input = LeaseGrant {
            ttl_ms,
            ..grant(u64::MAX)
        };
        let created = RenewalSupervisor::new(
            input,
            RenewalPolicy::new(
                Duration::from_millis(renew_every_ms),
                Duration::from_millis(safety_margin_ms),
            ),
            start_ms,
        );
        if expected_kind == "invalid" {
            let error = created.expect_err(name);
            assert_eq!(error.reason.as_str(), expected_reason, "{name}");
            continue;
        }
        let mut supervisor = created.expect(name);
        let decision = supervisor.decision(now_ms);
        match decision {
            RenewalDecision::Wait { check_in_ms } => {
                assert_eq!(expected_kind, "wait", "{name}");
                assert_eq!(check_in_ms, expected_check_in, "{name}");
            }
            RenewalDecision::RenewNow => assert_eq!(expected_kind, "renew_now", "{name}"),
            RenewalDecision::Lost { reason } => {
                assert_eq!(expected_kind, "lost", "{name}");
                assert_eq!(reason.as_str(), expected_reason, "{name}");
            }
        }
        assert_eq!(supervisor.grant().fencing_token, u64::MAX, "{name}");
    }
}

#[test]
fn schedules_at_the_earlier_interval_or_margin() {
    let supervisor = RenewalSupervisor::new(grant(u64::MAX), policy(), 1_000).expect("valid");
    assert_eq!(supervisor.local_deadline_ms(), 11_000);
    assert_eq!(supervisor.next_renewal_ms(), 5_000);
    assert_eq!(supervisor.grant().fencing_token, u64::MAX);

    let short = RenewalPolicy::new(Duration::from_millis(4_500), Duration::from_millis(1_000));
    let supervisor = RenewalSupervisor::new(
        LeaseGrant {
            ttl_ms: 5_000,
            ..grant(7)
        },
        short,
        100,
    )
    .expect("valid");
    assert_eq!(supervisor.next_renewal_ms(), 4_100);
}

#[test]
fn expiry_and_clock_regression_are_sticky() {
    let mut supervisor = RenewalSupervisor::new(grant(7), policy(), 1_000).expect("valid");
    assert_eq!(
        supervisor.decision(999),
        RenewalDecision::Lost {
            reason: RenewalLossReason::ClockRegression
        }
    );
    assert_eq!(
        supervisor.decision(5_000),
        RenewalDecision::Lost {
            reason: RenewalLossReason::ClockRegression
        }
    );

    let mut expired = RenewalSupervisor::new(grant(7), policy(), 1_000).expect("valid");
    assert_eq!(
        expired.decision(11_000),
        RenewalDecision::Lost {
            reason: RenewalLossReason::Expired
        }
    );
}

#[test]
fn successful_renewal_preserves_identity_and_full_width_token() {
    let renewed = LeaseGrant {
        lease_expires_ms: Some(110_000),
        ..grant(u64::MAX)
    };
    let lease = FakeLease::returning(Ok(renewed));
    let clock = SequenceClock::new([5_000, 5_100]);
    let mut supervisor = RenewalSupervisor::new(grant(u64::MAX), policy(), 1_000).expect("valid");
    assert_eq!(
        block_on(supervisor.checkpoint(&lease, &clock)).expect("renewed"),
        RenewalCheckpoint::Renewed { check_in_ms: 4_000 }
    );
    assert_eq!(lease.calls(), 1);
    assert_eq!(supervisor.grant().fencing_token, u64::MAX);
    assert_eq!(supervisor.local_deadline_ms(), 15_100);
    assert_eq!(supervisor.next_renewal_ms(), 9_100);
}

#[test]
fn identity_or_token_drift_is_terminal() {
    let mut token = RenewalSupervisor::new(grant(7), policy(), 1_000).expect("valid");
    let error = token
        .accept_renewal(
            5_100,
            LeaseGrant {
                fencing_token: 8,
                lease_expires_ms: Some(110_000),
                ..grant(7)
            },
        )
        .expect_err("token drift");
    assert_eq!(error.reason, RenewalLossReason::TokenChanged);

    let mut identity = RenewalSupervisor::new(grant(7), policy(), 1_000).expect("valid");
    let error = identity
        .accept_renewal(
            5_100,
            LeaseGrant {
                holder: "holder-b".to_string(),
                lease_expires_ms: Some(110_000),
                ..grant(7)
            },
        )
        .expect_err("identity drift");
    assert_eq!(error.reason, RenewalLossReason::IdentityChanged);
}

#[test]
fn transport_failure_loses_authority_and_never_retries() {
    let failure = LockError::new(LockErrorKind::Transport, &grant(7).key, "partition");
    let lease = FakeLease::returning(Err(failure));
    let clock = SequenceClock::new([5_000]);
    let mut supervisor = RenewalSupervisor::new(grant(7), policy(), 1_000).expect("valid");
    let error = block_on(supervisor.checkpoint(&lease, &clock)).expect_err("lost");
    assert_eq!(error.reason, RenewalLossReason::RenewalFailed);
    assert_eq!(lease.calls(), 1);

    let second = block_on(supervisor.checkpoint(&lease, &|| 5_001)).expect_err("sticky");
    assert_eq!(second.reason, RenewalLossReason::RenewalFailed);
    assert_eq!(lease.calls(), 1);
}

#[test]
fn deadline_regression_and_late_completion_fail_closed() {
    let mut supervisor = RenewalSupervisor::new(grant(7), policy(), 1_000).expect("valid");
    let error = supervisor
        .accept_renewal(5_100, grant(7))
        .expect_err("deadline did not advance");
    assert_eq!(error.reason, RenewalLossReason::DeadlineRegressed);

    let mut late = RenewalSupervisor::new(grant(7), policy(), 1_000).expect("valid");
    let error = late
        .accept_renewal(
            11_000,
            LeaseGrant {
                lease_expires_ms: Some(110_000),
                ..grant(7)
            },
        )
        .expect_err("late");
    assert_eq!(error.reason, RenewalLossReason::CompletionAfterDeadline);
}
