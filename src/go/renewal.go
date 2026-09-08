package oreslocks

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// MaxRenewalClockMS is the logical-millisecond domain shared with browser SDKs.
const MaxRenewalClockMS int64 = 9_007_199_254_740_991

// MaxRenewalTTLMS is the common TTL domain supported without duration overflow.
const MaxRenewalTTLMS int64 = 9_223_372_036_854

// RenewalPolicy controls when a held lease is renewed.
type RenewalPolicy struct {
	RenewEvery   time.Duration
	SafetyMargin time.Duration
}

// DefaultRenewalPolicy renews a 60-second lease at 20 seconds or ten seconds
// before its local deadline, whichever comes first.
func DefaultRenewalPolicy() RenewalPolicy {
	return RenewalPolicy{RenewEvery: 20 * time.Second, SafetyMargin: 10 * time.Second}
}

// RenewalLossReason is why a supervisor permanently stopped authorizing work.
type RenewalLossReason string

const (
	RenewalInvalidPolicy           RenewalLossReason = "invalid_policy"
	RenewalClockRegression         RenewalLossReason = "clock_regression"
	RenewalExpired                 RenewalLossReason = "expired"
	RenewalFailed                  RenewalLossReason = "renewal_failed"
	RenewalIdentityChanged         RenewalLossReason = "identity_changed"
	RenewalTokenChanged            RenewalLossReason = "token_changed"
	RenewalDeadlineMissing         RenewalLossReason = "deadline_missing"
	RenewalDeadlineInvalid         RenewalLossReason = "deadline_invalid"
	RenewalDeadlineRegressed       RenewalLossReason = "deadline_regressed"
	RenewalCompletionAfterDeadline RenewalLossReason = "completion_after_deadline"
	RenewalDeadlineOverflow        RenewalLossReason = "deadline_overflow"
	RenewalInvalidTTL              RenewalLossReason = "invalid_ttl"
)

// RenewalError is terminal and sticky for one supervisor.
type RenewalError struct {
	Reason  RenewalLossReason
	Message string
	Cause   error
}

func (e *RenewalError) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("%s: %s; cause: %v", e.Reason, e.Message, e.Cause)
	}
	return fmt.Sprintf("%s: %s", e.Reason, e.Message)
}

func (e *RenewalError) Unwrap() error { return e.Cause }

// RenewalDecisionKind is the pure scheduling outcome.
type RenewalDecisionKind string

const (
	RenewalWait RenewalDecisionKind = "wait"
	RenewalNow  RenewalDecisionKind = "renew_now"
	RenewalLost RenewalDecisionKind = "lost"
)

// RenewalDecision is returned by Decision.
type RenewalDecision struct {
	Kind      RenewalDecisionKind
	CheckInMS int64
	Reason    RenewalLossReason
}

// RenewalCheckpointKind is a successful checkpoint outcome.
type RenewalCheckpointKind string

const (
	RenewalCheckpointWait    RenewalCheckpointKind = "wait"
	RenewalCheckpointRenewed RenewalCheckpointKind = "renewed"
)

// RenewalCheckpoint is returned after waiting or validating a renewal.
type RenewalCheckpoint struct {
	Kind      RenewalCheckpointKind
	CheckInMS int64
}

// RenewalClock reports process-local monotonic milliseconds.
type RenewalClock interface{ NowMillis() int64 }

// RenewalClockFunc adapts a function to RenewalClock.
type RenewalClockFunc func() int64

func (clock RenewalClockFunc) NowMillis() int64 { return clock() }

// RenewalSupervisor tracks one exact Fiducia grant identity.
type RenewalSupervisor struct {
	grant           LeaseGrant
	policy          RenewalPolicy
	localDeadlineMS int64
	nextRenewalMS   int64
	lastObservedMS  int64
	loss            *RenewalError
}

// NewRenewalSupervisor starts supervision at a monotonic logical time.
func NewRenewalSupervisor(grant LeaseGrant, policy RenewalPolicy, nowMS int64) (*RenewalSupervisor, error) {
	if err := validateRenewalClock(nowMS); err != nil {
		return nil, err
	}
	if err := validateAuthorityDeadline(grant.LeaseExpiresMs); err != nil {
		return nil, err
	}
	deadline, next, err := renewalSchedule(nowMS, grant.TTLMs, policy)
	if err != nil {
		return nil, err
	}
	return &RenewalSupervisor{
		grant:           grant,
		policy:          policy,
		localDeadlineMS: deadline,
		nextRenewalMS:   next,
		lastObservedMS:  nowMS,
	}, nil
}

func (s *RenewalSupervisor) Grant() LeaseGrant      { return s.grant }
func (s *RenewalSupervisor) LocalDeadlineMS() int64 { return s.localDeadlineMS }
func (s *RenewalSupervisor) NextRenewalMS() int64   { return s.nextRenewalMS }
func (s *RenewalSupervisor) Loss() *RenewalError    { return s.loss }
func (s *RenewalSupervisor) IsLive() bool           { return s.loss == nil }

// Decision observes the monotonic clock without contacting the authority.
func (s *RenewalSupervisor) Decision(nowMS int64) RenewalDecision {
	if s.loss != nil {
		return RenewalDecision{Kind: RenewalLost, Reason: s.loss.Reason}
	}
	if err := validateRenewalClock(nowMS); err != nil {
		return s.lose(err)
	}
	if nowMS < s.lastObservedMS {
		return s.lose(&RenewalError{Reason: RenewalClockRegression, Message: fmt.Sprintf("monotonic clock regressed from %d to %d", s.lastObservedMS, nowMS)})
	}
	s.lastObservedMS = nowMS
	if nowMS >= s.localDeadlineMS {
		return s.lose(&RenewalError{Reason: RenewalExpired, Message: fmt.Sprintf("local lease deadline %d was reached at %d", s.localDeadlineMS, nowMS)})
	}
	if nowMS >= s.nextRenewalMS {
		return RenewalDecision{Kind: RenewalNow}
	}
	return RenewalDecision{Kind: RenewalWait, CheckInMS: s.nextRenewalMS - nowMS}
}

// AssertLive fails after expiry, clock regression, or any earlier renewal loss.
func (s *RenewalSupervisor) AssertLive(nowMS int64) error {
	decision := s.Decision(nowMS)
	if decision.Kind == RenewalLost {
		return s.loss
	}
	return nil
}

// Checkpoint renews only when due. Any failure permanently cancels authority.
func (s *RenewalSupervisor) Checkpoint(ctx context.Context, lease Lease, clock RenewalClock) (RenewalCheckpoint, error) {
	decision := s.Decision(clock.NowMillis())
	switch decision.Kind {
	case RenewalWait:
		return RenewalCheckpoint{Kind: RenewalCheckpointWait, CheckInMS: decision.CheckInMS}, nil
	case RenewalLost:
		return RenewalCheckpoint{}, s.loss
	}
	previous := s.grant
	renewed, err := lease.Renew(ctx, previous, time.Duration(previous.TTLMs)*time.Millisecond)
	if err != nil {
		return RenewalCheckpoint{}, s.fail(&RenewalError{Reason: RenewalFailed, Message: "lease authority did not prove continued ownership", Cause: err})
	}
	return s.AcceptRenewal(clock.NowMillis(), renewed)
}

// AcceptRenewal validates one authority success and advances the local window.
func (s *RenewalSupervisor) AcceptRenewal(completedMS int64, renewed LeaseGrant) (RenewalCheckpoint, error) {
	if s.loss != nil {
		return RenewalCheckpoint{}, s.loss
	}
	if err := validateRenewalClock(completedMS); err != nil {
		return RenewalCheckpoint{}, s.fail(err)
	}
	if completedMS < s.lastObservedMS {
		return RenewalCheckpoint{}, s.fail(&RenewalError{Reason: RenewalClockRegression, Message: fmt.Sprintf("monotonic clock regressed from %d to %d during renewal", s.lastObservedMS, completedMS)})
	}
	s.lastObservedMS = completedMS
	if completedMS >= s.localDeadlineMS {
		return RenewalCheckpoint{}, s.fail(&RenewalError{Reason: RenewalCompletionAfterDeadline, Message: fmt.Sprintf("renewal completed at %d, not before local deadline %d", completedMS, s.localDeadlineMS)})
	}
	if renewed.Key != s.grant.Key || renewed.Holder != s.grant.Holder {
		return RenewalCheckpoint{}, s.fail(&RenewalError{Reason: RenewalIdentityChanged, Message: "renewal changed the lock key or holder identity"})
	}
	if renewed.FencingToken != s.grant.FencingToken {
		return RenewalCheckpoint{}, s.fail(&RenewalError{Reason: RenewalTokenChanged, Message: fmt.Sprintf("renewal changed fencing token %d to %d", s.grant.FencingToken, renewed.FencingToken)})
	}
	if err := validateDeadlineProgress(s.grant.LeaseExpiresMs, renewed.LeaseExpiresMs); err != nil {
		return RenewalCheckpoint{}, s.fail(err)
	}
	deadline, next, err := renewalSchedule(completedMS, renewed.TTLMs, s.policy)
	if err != nil {
		return RenewalCheckpoint{}, s.fail(err)
	}
	s.grant = renewed
	s.localDeadlineMS = deadline
	s.nextRenewalMS = next
	return RenewalCheckpoint{Kind: RenewalCheckpointRenewed, CheckInMS: next - completedMS}, nil
}

func (s *RenewalSupervisor) lose(err error) RenewalDecision {
	terminal := s.fail(err)
	return RenewalDecision{Kind: RenewalLost, Reason: terminal.(*RenewalError).Reason}
}

func (s *RenewalSupervisor) fail(err error) error {
	if s.loss == nil {
		var renewal *RenewalError
		if errors.As(err, &renewal) {
			s.loss = renewal
		} else {
			s.loss = &RenewalError{Reason: RenewalFailed, Message: "renewal failed", Cause: err}
		}
	}
	return s.loss
}

func validateRenewalClock(value int64) error {
	if value < 0 || value > MaxRenewalClockMS {
		return &RenewalError{Reason: RenewalDeadlineOverflow, Message: fmt.Sprintf("logical clock must be within 0..=%d", MaxRenewalClockMS)}
	}
	return nil
}

func validateAuthorityDeadline(value int64) error {
	if value < 0 || value > MaxRenewalClockMS {
		return &RenewalError{Reason: RenewalDeadlineInvalid, Message: "authority deadline is outside the shared millisecond domain"}
	}
	return nil
}

func validateDeadlineProgress(previous, renewed int64) error {
	if err := validateAuthorityDeadline(renewed); err != nil {
		return err
	}
	if previous > 0 && renewed == 0 {
		return &RenewalError{Reason: RenewalDeadlineMissing, Message: "renewal omitted a deadline that the authority previously reported"}
	}
	if previous > 0 && renewed <= previous {
		return &RenewalError{Reason: RenewalDeadlineRegressed, Message: fmt.Sprintf("authority deadline did not advance: %d -> %d", previous, renewed)}
	}
	return nil
}

func renewalSchedule(nowMS, ttlMS int64, policy RenewalPolicy) (int64, int64, error) {
	if ttlMS <= 0 || ttlMS > MaxRenewalTTLMS {
		return 0, 0, &RenewalError{Reason: RenewalInvalidTTL, Message: fmt.Sprintf("lease TTL must be within 1..=%d ms", MaxRenewalTTLMS)}
	}
	renewEveryMS := policy.RenewEvery.Milliseconds()
	safetyMarginMS := policy.SafetyMargin.Milliseconds()
	if renewEveryMS <= 0 || safetyMarginMS <= 0 || renewEveryMS >= ttlMS || safetyMarginMS >= ttlMS {
		return 0, 0, &RenewalError{Reason: RenewalInvalidPolicy, Message: "renewal interval and safety margin must both be positive and less than the lease TTL"}
	}
	if nowMS > MaxRenewalClockMS-ttlMS || nowMS > MaxRenewalClockMS-renewEveryMS {
		return 0, 0, &RenewalError{Reason: RenewalDeadlineOverflow, Message: "renewal schedule exceeds the shared logical-clock domain"}
	}
	deadline := nowMS + ttlMS
	intervalDue := nowMS + renewEveryMS
	marginDue := deadline - safetyMarginMS
	next := intervalDue
	if marginDue < next {
		next = marginDue
	}
	if next <= nowMS {
		return 0, 0, &RenewalError{Reason: RenewalInvalidPolicy, Message: "renewal policy leaves no positive live interval"}
	}
	return deadline, next, nil
}
