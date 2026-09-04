package oreslocks

import (
	"context"
	"fmt"
	"time"
)

// FencingToken is minted on every grant and increases monotonically. Guarded
// writes should record it (WHERE fencing_token < $new) so a holder whose
// lease lapsed cannot overwrite a newer holder's work.
type FencingToken = uint64

// AcquireOptions is the acquisition tuning shared by every layer. Contract
// model AcquireOptions.
type AcquireOptions struct {
	// TTL is the fiducia lease TTL. Size it to the longest the guarded work
	// can take; the lease lapses if never renewed or released.
	TTL time.Duration
	// WaitTimeout is the total time to keep waiting. Ignored when wait is false.
	WaitTimeout time.Duration
	// RetryInterval is the poll interval while waiting on the fiducia layer.
	RetryInterval time.Duration
	// Holder is the caller identity for the fiducia layer (also the release
	// key). Empty lets the adapter generate an unguessable id.
	Holder string
}

// DefaultAcquireOptions mirrors the official fiducia clients: 60s lease,
// 30s wait budget, 250ms poll.
func DefaultAcquireOptions() AcquireOptions {
	return AcquireOptions{TTL: 60 * time.Second, WaitTimeout: 30 * time.Second, RetryInterval: 250 * time.Millisecond}
}

// LeaseGrant is a held grant. Contract model LeaseGrant.
type LeaseGrant struct {
	Key            LockKey
	Holder         string
	FencingToken   FencingToken
	LeaseExpiresMs int64 // 0 when the authority did not report it
	TTLMs          int64
}

// Lease is a lease authority: three verbs, fenced. Implementations map their
// native failures onto Kind: contention (wait=false, held elsewhere),
// timeout (budget elapsed), transport (unknown ownership), lost_lease
// (renewal refused).
type Lease interface {
	// Acquire key. With wait, block up to opts.WaitTimeout; without it,
	// return KindContention at once if the key is held.
	Acquire(ctx context.Context, key LockKey, opts AcquireOptions, wait bool) (LeaseGrant, error)
	// Renew extends a grant without changing its fencing token. A refusal is
	// KindLostLease, never a warning.
	Renew(ctx context.Context, grant LeaseGrant, ttl time.Duration) (LeaseGrant, error)
	// Release a grant. false is a committed no-op: the authority matched no
	// grant, which almost always means the lease had already lapsed.
	Release(ctx context.Context, grant LeaseGrant) (bool, error)
}

// Guarded is what work receives: whichever layers are engaged, valid for
// the duration of the guarded section.
type Guarded struct {
	Key LockKey
	// Grant is the fiducia grant when Layers.Fiducia is on; its FencingToken
	// is what guarded writes should record.
	Grant *LeaseGrant
}

// FencingToken returns the grant's token, or 0 and false without a grant.
func (g Guarded) FencingToken() (FencingToken, bool) {
	if g.Grant == nil {
		return 0, false
	}
	return g.Grant.FencingToken, true
}

// WithLease runs work under a fiducia lease only — no database layer. This
// is the routine for work that touches no Postgres, or that manages its own
// transactions and only needs cross-host exclusion and a fencing token.
//
// engage=false is the contract's "neither" plan: work runs with no grant
// and nothing is acquired. engage=true with a nil lease is KindInvalidPlan.
//
// Ordering: acquire → work → release. The lease is always released, even
// when work fails. If work succeeded but the authority reports that the
// release matched no grant, the result is KindLostLease.
func WithLease(ctx context.Context, key LockKey, engage, wait bool, opts AcquireOptions, lease Lease, work func(context.Context, Guarded) error) error {
	if !engage {
		if err := work(ctx, Guarded{Key: key}); err != nil {
			return workErr(key, err)
		}
		return nil
	}
	if lease == nil {
		return invalidPlan(key, "layers.fiducia is enabled but no lease authority was supplied")
	}
	grant, err := acquireLease(ctx, key, wait, opts, lease)
	if err != nil {
		return err
	}
	var inner error
	if err := work(ctx, Guarded{Key: key, Grant: &grant}); err != nil {
		inner = workErr(key, err)
	}
	return settle(ctx, key, lease, grant, inner)
}

func acquireLease(ctx context.Context, key LockKey, wait bool, opts AcquireOptions, lease Lease) (LeaseGrant, error) {
	step := StepFiduciaTryAcquire
	if wait {
		step = StepFiduciaAcquire
	}
	grant, err := lease.Acquire(ctx, key, opts, wait)
	if err != nil {
		return LeaseGrant{}, tagStep(err, step)
	}
	return grant, nil
}

// settle releases the lease and combines its outcome with the inner one. The
// release runs on a context that ignores cancellation: an unreleased lease
// costs everyone a full TTL.
func settle(ctx context.Context, key LockKey, lease Lease, grant LeaseGrant, inner error) error {
	released, err := lease.Release(context.WithoutCancel(ctx), grant)
	var cleanup error
	switch {
	case err != nil:
		cleanup = tagStep(err, StepFiduciaRelease)
	case !released:
		cleanup = newError(KindLostLease, key, StepFiduciaRelease,
			fmt.Sprintf("release of `%s` (holder %s, fencing token %d) matched no grant: the lease lapsed while the work ran", key, grant.Holder, grant.FencingToken), nil)
	}
	if cleanup != nil {
		return cleanupFailure(cleanup, inner)
	}
	return inner
}
