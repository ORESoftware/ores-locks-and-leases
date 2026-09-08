package oreslocks

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

type scriptedMaintenanceLease struct {
	fakeLease

	renewMu     sync.Mutex
	renewals    int
	failAt      int
	mutateToken bool
}

func (l *scriptedMaintenanceLease) Renew(
	_ context.Context,
	grant LeaseGrant,
	ttl time.Duration,
) (LeaseGrant, error) {
	l.renewMu.Lock()
	defer l.renewMu.Unlock()
	l.renewals++

	l.fakeLease.mu.Lock()
	l.fakeLease.log = append(l.fakeLease.log, StepFiduciaRenew)
	l.fakeLease.mu.Unlock()

	if l.renewals == l.failAt {
		return LeaseGrant{}, newError(
			KindLostLease,
			grant.Key,
			"",
			"scripted Fiducia lease loss",
			nil,
		)
	}
	grant.TTLMs = ttl.Milliseconds()
	if l.mutateToken {
		grant.FencingToken++
	}
	return grant, nil
}

func (l *scriptedMaintenanceLease) renewalCount() int {
	l.renewMu.Lock()
	defer l.renewMu.Unlock()
	return l.renewals
}

func maintainedAcquireOptions() AcquireOptions {
	opts := DefaultAcquireOptions()
	opts.TTL = 120 * time.Millisecond
	opts.WaitTimeout = 250 * time.Millisecond
	opts.RetryInterval = 5 * time.Millisecond
	return opts
}

func logContains(log []string, wanted string) bool {
	for _, entry := range log {
		if entry == wanted {
			return true
		}
	}
	return false
}

func TestMaintainedOptionsRejectBeforeAcquisition(t *testing.T) {
	db, recorder := openRec(t, true, true)
	defer db.Close()
	lease := &scriptedMaintenanceLease{}
	opts := maintainedAcquireOptions()
	maintenance := LeaseMaintenanceOptions{RenewInterval: 61 * time.Millisecond}

	err := WithMaintainedXactLock(
		context.Background(),
		"t/maintained/options",
		true,
		opts,
		maintenance,
		lease,
		db,
		func(context.Context, MaintainedXactGuarded) error {
			t.Fatal("work ran")
			return nil
		},
	)
	var lockErr *Error
	if !errors.As(err, &lockErr) || lockErr.Kind != KindInvalidPlan {
		t.Fatalf("want invalid_plan, got %v", err)
	}
	if len(lease.log) != 0 || len(recorder.log) != 0 {
		t.Fatalf("validation had side effects: lease=%v postgres=%v", lease.log, recorder.log)
	}
}

func TestMaintainedPeriodicAndFinalRenewalsAdmitCommit(t *testing.T) {
	db, recorder := openRec(t, true, true)
	defer db.Close()
	lease := &scriptedMaintenanceLease{}
	opts := maintainedAcquireOptions()

	err := WithMaintainedXactLock(
		context.Background(),
		"t/maintained/success",
		true,
		opts,
		LeaseMaintenanceOptions{RenewInterval: 20 * time.Millisecond},
		lease,
		db,
		func(_ context.Context, guarded MaintainedXactGuarded) error {
			if guarded.Tx == nil {
				t.Fatal("transaction missing")
			}
			if token, ok := guarded.FencingToken(); !ok || token != 1 {
				t.Fatalf("fencing token %d %v", token, ok)
			}
			recorder.record("WORK")
			time.Sleep(65 * time.Millisecond)
			return nil
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if lease.renewalCount() < 2 {
		t.Fatalf("want periodic renewal plus final admission, got %d", lease.renewalCount())
	}
	if !logContains(recorder.log, "COMMIT") {
		t.Fatalf("transaction was not committed: %v", recorder.log)
	}
	if logContains(recorder.log, "ROLLBACK") {
		t.Fatalf("successful transaction rolled back: %v", recorder.log)
	}
	if lease.held {
		t.Fatal("lease was not released")
	}
}

func TestMaintainedFinalRenewalFailureRollsBack(t *testing.T) {
	db, recorder := openRec(t, true, true)
	defer db.Close()
	lease := &scriptedMaintenanceLease{failAt: 1}
	opts := DefaultAcquireOptions()
	opts.TTL = 3 * time.Second

	err := WithMaintainedXactLock(
		context.Background(),
		"t/maintained/final-failure",
		false,
		opts,
		LeaseMaintenanceOptions{RenewInterval: time.Second},
		lease,
		db,
		func(context.Context, MaintainedXactGuarded) error { return nil },
	)
	var lockErr *Error
	if !errors.As(err, &lockErr) || lockErr.Kind != KindLostLease || lockErr.Step != StepFiduciaRenew {
		t.Fatalf("want lost_lease at fiducia.renew, got %v", err)
	}
	if !logContains(recorder.log, "ROLLBACK") {
		t.Fatalf("failed admission did not roll back: %v", recorder.log)
	}
	if logContains(recorder.log, "COMMIT") {
		t.Fatalf("failed admission committed: %v", recorder.log)
	}
	if lease.held {
		t.Fatal("lease was not released")
	}
}

func TestMaintainedPeriodicFailureCancelsWork(t *testing.T) {
	db, recorder := openRec(t, true, true)
	defer db.Close()
	lease := &scriptedMaintenanceLease{failAt: 1}
	opts := maintainedAcquireOptions()
	started := time.Now()

	err := WithMaintainedXactLock(
		context.Background(),
		"t/maintained/periodic-failure",
		true,
		opts,
		LeaseMaintenanceOptions{RenewInterval: 10 * time.Millisecond},
		lease,
		db,
		func(ctx context.Context, _ MaintainedXactGuarded) error {
			<-ctx.Done()
			return ctx.Err()
		},
	)
	var lockErr *Error
	if !errors.As(err, &lockErr) || lockErr.Kind != KindLostLease || lockErr.Step != StepFiduciaRenew {
		t.Fatalf("want lost_lease at fiducia.renew, got %v", err)
	}
	if !strings.Contains(lockErr.Message, "guarded operation also failed") {
		t.Fatalf("work cancellation provenance missing: %v", err)
	}
	if time.Since(started) >= time.Second {
		t.Fatalf("cooperative work was not canceled promptly: %s", time.Since(started))
	}
	if !logContains(recorder.log, "ROLLBACK") {
		t.Fatalf("periodic failure did not roll back: %v", recorder.log)
	}
	if logContains(recorder.log, "COMMIT") {
		t.Fatalf("periodic failure committed: %v", recorder.log)
	}
}

func TestMaintainedRejectsChangedFencingIdentity(t *testing.T) {
	db, recorder := openRec(t, true, true)
	defer db.Close()
	lease := &scriptedMaintenanceLease{mutateToken: true}
	opts := DefaultAcquireOptions()
	opts.TTL = 3 * time.Second

	err := WithMaintainedXactLock(
		context.Background(),
		"t/maintained/malformed-renewal",
		false,
		opts,
		LeaseMaintenanceOptions{RenewInterval: time.Second},
		lease,
		db,
		func(context.Context, MaintainedXactGuarded) error { return nil },
	)
	var lockErr *Error
	if !errors.As(err, &lockErr) || lockErr.Kind != KindLostLease || lockErr.Step != StepFiduciaRenew || !strings.Contains(lockErr.Message, "fencing token") {
		t.Fatalf("want malformed fencing-token renewal rejection, got %v", err)
	}
	if !logContains(recorder.log, "ROLLBACK") {
		t.Fatalf("malformed renewal did not roll back: %v", recorder.log)
	}
	if logContains(recorder.log, "COMMIT") {
		t.Fatalf("malformed renewal committed: %v", recorder.log)
	}
}

func TestMaintainedContentionReleasesFiducia(t *testing.T) {
	db, recorder := openRec(t, false, true)
	defer db.Close()
	lease := &scriptedMaintenanceLease{}

	err := WithMaintainedXactLock(
		context.Background(),
		"t/maintained/contention",
		false,
		maintainedAcquireOptions(),
		LeaseMaintenanceOptions{RenewInterval: 20 * time.Millisecond},
		lease,
		db,
		func(context.Context, MaintainedXactGuarded) error {
			t.Fatal("work ran")
			return nil
		},
	)
	var lockErr *Error
	if !errors.As(err, &lockErr) || lockErr.Kind != KindContention || lockErr.Step != StepPgTryAdvisoryXactLock {
		t.Fatalf("want PostgreSQL contention, got %v", err)
	}
	if !logContains(recorder.log, "ROLLBACK") || logContains(recorder.log, "COMMIT") || lease.held {
		t.Fatalf("contention cleanup failed: log=%v held=%v", recorder.log, lease.held)
	}
}
