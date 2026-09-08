package oreslocks

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"
)

type renewalCorpus struct {
	Cases []struct {
		Name           string `json:"name"`
		StartMS        int64  `json:"startMs"`
		TTLMS          int64  `json:"ttlMs"`
		RenewEveryMS   int64  `json:"renewEveryMs"`
		SafetyMarginMS int64  `json:"safetyMarginMs"`
		NowMS          int64  `json:"nowMs"`
		Expect         struct {
			Kind      string `json:"kind"`
			CheckInMS int64  `json:"checkInMs"`
			Reason    string `json:"reason"`
		} `json:"expect"`
	} `json:"cases"`
}

type fakeRenewalLease struct {
	response LeaseGrant
	err      error
	calls    int
}

func (f *fakeRenewalLease) Acquire(context.Context, LockKey, AcquireOptions, bool) (LeaseGrant, error) {
	return LeaseGrant{}, errors.New("unused")
}
func (f *fakeRenewalLease) Renew(context.Context, LeaseGrant, time.Duration) (LeaseGrant, error) {
	f.calls++
	if f.err != nil {
		return LeaseGrant{}, f.err
	}
	return f.response, nil
}
func (f *fakeRenewalLease) Release(context.Context, LeaseGrant) (bool, error) { return true, nil }

type sequenceRenewalClock struct{ values []int64 }

func (c *sequenceRenewalClock) NowMillis() int64 {
	value := c.values[0]
	c.values = c.values[1:]
	return value
}

func renewalGrant(token uint64) LeaseGrant {
	key, err := NewLockKey("renewal/test/resource")
	if err != nil {
		panic(err)
	}
	return LeaseGrant{Key: key, Holder: "holder-a", FencingToken: token, LeaseExpiresMs: 100_000, TTLMs: 10_000}
}

func renewalPolicy() RenewalPolicy {
	return RenewalPolicy{RenewEvery: 4 * time.Second, SafetyMargin: 2 * time.Second}
}

func TestRenewalDecisionCorpus(t *testing.T) {
	contents, err := os.ReadFile("../../conformance/cases/renewal-decision.json")
	if err != nil {
		t.Fatal(err)
	}
	var corpus renewalCorpus
	if err := json.Unmarshal(contents, &corpus); err != nil {
		t.Fatal(err)
	}
	for _, entry := range corpus.Cases {
		t.Run(entry.Name, func(t *testing.T) {
			grant := renewalGrant(^uint64(0))
			grant.TTLMs = entry.TTLMS
			supervisor, err := NewRenewalSupervisor(grant, RenewalPolicy{
				RenewEvery:   time.Duration(entry.RenewEveryMS) * time.Millisecond,
				SafetyMargin: time.Duration(entry.SafetyMarginMS) * time.Millisecond,
			}, entry.StartMS)
			if entry.Expect.Kind == "invalid" {
				var renewal *RenewalError
				if !errors.As(err, &renewal) || string(renewal.Reason) != entry.Expect.Reason {
					t.Fatalf("got %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			decision := supervisor.Decision(entry.NowMS)
			if string(decision.Kind) != entry.Expect.Kind {
				t.Fatalf("kind %s", decision.Kind)
			}
			if decision.CheckInMS != entry.Expect.CheckInMS {
				t.Fatalf("checkIn %d", decision.CheckInMS)
			}
			if string(decision.Reason) != entry.Expect.Reason {
				t.Fatalf("reason %s", decision.Reason)
			}
			if supervisor.Grant().FencingToken != ^uint64(0) {
				t.Fatal("full-width token changed")
			}
		})
	}
}

func TestRenewalCheckpointPreservesIdentity(t *testing.T) {
	response := renewalGrant(^uint64(0))
	response.LeaseExpiresMs = 110_000
	lease := &fakeRenewalLease{response: response}
	clock := &sequenceRenewalClock{values: []int64{5_000, 5_100}}
	supervisor, err := NewRenewalSupervisor(renewalGrant(^uint64(0)), renewalPolicy(), 1_000)
	if err != nil {
		t.Fatal(err)
	}
	checkpoint, err := supervisor.Checkpoint(context.Background(), lease, clock)
	if err != nil {
		t.Fatal(err)
	}
	if checkpoint.Kind != RenewalCheckpointRenewed || checkpoint.CheckInMS != 4_000 {
		t.Fatalf("checkpoint %#v", checkpoint)
	}
	if lease.calls != 1 || supervisor.Grant().FencingToken != ^uint64(0) {
		t.Fatal("renewal identity changed")
	}
	if supervisor.LocalDeadlineMS() != 15_100 || supervisor.NextRenewalMS() != 9_100 {
		t.Fatal("wrong schedule")
	}
}

func TestRenewalFailureIsSticky(t *testing.T) {
	lease := &fakeRenewalLease{err: errors.New("partition")}
	supervisor, err := NewRenewalSupervisor(renewalGrant(7), renewalPolicy(), 1_000)
	if err != nil {
		t.Fatal(err)
	}
	_, err = supervisor.Checkpoint(context.Background(), lease, RenewalClockFunc(func() int64 { return 5_000 }))
	var renewal *RenewalError
	if !errors.As(err, &renewal) || renewal.Reason != RenewalFailed {
		t.Fatalf("got %v", err)
	}
	_, err = supervisor.Checkpoint(context.Background(), lease, RenewalClockFunc(func() int64 { return 5_001 }))
	if !errors.As(err, &renewal) || renewal.Reason != RenewalFailed {
		t.Fatalf("got %v", err)
	}
	if lease.calls != 1 {
		t.Fatalf("calls %d", lease.calls)
	}
}

func TestRenewalRejectsDriftAndLateCompletion(t *testing.T) {
	for name, mutate := range map[string]func(*LeaseGrant){
		"holder":   func(grant *LeaseGrant) { grant.Holder = "holder-b"; grant.LeaseExpiresMs = 110_000 },
		"token":    func(grant *LeaseGrant) { grant.FencingToken = 8; grant.LeaseExpiresMs = 110_000 },
		"deadline": func(grant *LeaseGrant) { grant.LeaseExpiresMs = 100_000 },
	} {
		t.Run(name, func(t *testing.T) {
			supervisor, _ := NewRenewalSupervisor(renewalGrant(7), renewalPolicy(), 1_000)
			renewed := renewalGrant(7)
			mutate(&renewed)
			if _, err := supervisor.AcceptRenewal(5_100, renewed); err == nil {
				t.Fatal("expected refusal")
			}
			if supervisor.IsLive() {
				t.Fatal("loss must be sticky")
			}
		})
	}
	late, _ := NewRenewalSupervisor(renewalGrant(7), renewalPolicy(), 1_000)
	renewed := renewalGrant(7)
	renewed.LeaseExpiresMs = 110_000
	_, err := late.AcceptRenewal(11_000, renewed)
	var renewal *RenewalError
	if !errors.As(err, &renewal) || renewal.Reason != RenewalCompletionAfterDeadline {
		t.Fatalf("got %v", err)
	}
}
