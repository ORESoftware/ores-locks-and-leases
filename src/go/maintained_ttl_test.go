package oreslocks

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

type ttlDriftLease struct {
	renewed LeaseGrant
}

func (l ttlDriftLease) Acquire(
	_ context.Context,
	_ LockKey,
	_ AcquireOptions,
	_ bool,
) (LeaseGrant, error) {
	return LeaseGrant{}, errors.New("unused")
}

func (l ttlDriftLease) Renew(
	_ context.Context,
	_ LeaseGrant,
	_ time.Duration,
) (LeaseGrant, error) {
	return l.renewed, nil
}

func (l ttlDriftLease) Release(
	_ context.Context,
	_ LeaseGrant,
) (bool, error) {
	return true, nil
}

func TestMaintainedAcquiredGrantMustMatchRequestedTTLAndHolder(t *testing.T) {
	key := LockKey("tests/maintained/acquired-continuity")
	opts := maintainedAcquireOptions()
	opts.Holder = "holder-a"
	grant := LeaseGrant{
		Key:          key,
		Holder:       "holder-a",
		FencingToken: 99,
		TTLMs:        opts.TTL.Milliseconds(),
	}
	if err := validateMaintainedAcquiredGrant(key, true, opts, grant); err != nil {
		t.Fatalf("valid grant rejected: %v", err)
	}

	changedTTL := grant
	changedTTL.TTLMs--
	err := validateMaintainedAcquiredGrant(key, false, opts, changedTTL)
	var lockErr *Error
	if !errors.As(err, &lockErr) || lockErr.Kind != KindLostLease || lockErr.Step != StepFiduciaTryAcquire || !strings.Contains(lockErr.Message, "TTL") {
		t.Fatalf("want acquired TTL mismatch at fiducia.try_acquire, got %v", err)
	}

	changedHolder := grant
	changedHolder.Holder = "holder-b"
	if err := validateMaintainedAcquiredGrant(key, true, opts, changedHolder); err == nil {
		t.Fatal("holder mismatch was accepted")
	}

	invalidExpiry := grant
	invalidExpiry.LeaseExpiresMs = -1
	if err := validateMaintainedAcquiredGrant(key, true, opts, invalidExpiry); err == nil {
		t.Fatal("negative authority expiry was accepted")
	}
}

func TestMaintainedRenewalRejectsEffectiveTTLDrift(t *testing.T) {
	key := LockKey("tests/maintained/renewal-ttl")
	original := LeaseGrant{
		Key:          key,
		Holder:       "holder-a",
		FencingToken: 99,
		TTLMs:        120,
	}
	renewed := original
	renewed.TTLMs = 119

	_, err := renewChecked(
		context.Background(),
		ttlDriftLease{renewed: renewed},
		original,
		120*time.Millisecond,
	)
	var lockErr *Error
	if !errors.As(err, &lockErr) || lockErr.Kind != KindLostLease || lockErr.Step != StepFiduciaRenew || !strings.Contains(lockErr.Message, "TTL") {
		t.Fatalf("want renewal TTL drift rejection, got %v", err)
	}
}
