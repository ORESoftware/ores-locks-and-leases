package oreslocks

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sync"
	"time"
)

// LeaseMaintenanceOptions controls renewal while a Fiducia lease encloses a
// PostgreSQL advisory-lock transaction.
type LeaseMaintenanceOptions struct {
	// RenewInterval must be positive and no greater than half of AcquireOptions.TTL.
	RenewInterval time.Duration
}

// DefaultLeaseMaintenanceOptions leaves a 40-second margin inside the default
// 60-second Fiducia TTL.
func DefaultLeaseMaintenanceOptions() LeaseMaintenanceOptions {
	return LeaseMaintenanceOptions{RenewInterval: 20 * time.Second}
}

// Validate rejects unsafe timing before either coordination layer is acquired.
func (o LeaseMaintenanceOptions) Validate(key LockKey, acquire AcquireOptions, wait bool) error {
	switch {
	case acquire.TTL <= 0:
		return invalidPlan(key, "fiducia lease TTL must be greater than zero")
	case o.RenewInterval <= 0:
		return invalidPlan(key, "fiducia renewal interval must be greater than zero")
	case o.RenewInterval > acquire.TTL/2:
		return invalidPlan(key, fmt.Sprintf(
			"fiducia renewal interval %d ms is unsafe for TTL %d ms; it must be no greater than half the TTL",
			o.RenewInterval.Milliseconds(), acquire.TTL.Milliseconds(),
		))
	case acquire.WaitTimeout < 0:
		return invalidPlan(key, "PostgreSQL advisory-lock wait timeout must not be negative")
	case wait && acquire.RetryInterval <= 0:
		return invalidPlan(key, "PostgreSQL advisory-lock retry interval must be greater than zero when wait is enabled")
	default:
		return nil
	}
}

// MaintainedXactGuarded is what maintained work receives. Every protected SQL
// statement must use Tx. The supplied work context is canceled with the
// renewal failure as its cause so cooperative work can stop promptly.
type MaintainedXactGuarded struct {
	Guarded
	Tx *sql.Tx
}

// WithMaintainedXactLock holds a Fiducia lease around one PostgreSQL
// transaction-scoped advisory lock.
//
// Waiting is implemented with pg_try_advisory_xact_lock polling so renewal
// loss can interrupt the wait. The lease is renewed periodically while lock
// acquisition and work are pending, and one final renewal is mandatory before
// Commit. Any failure before commit rolls the transaction back, then releases
// the outer grant while preserving cleanup-error precedence.
func WithMaintainedXactLock(
	ctx context.Context,
	key LockKey,
	wait bool,
	acquire AcquireOptions,
	maintenance LeaseMaintenanceOptions,
	lease Lease,
	db *sql.DB,
	work func(context.Context, MaintainedXactGuarded) error,
) error {
	if lease == nil {
		return invalidPlan(key, "a Fiducia lease authority is required")
	}
	if db == nil {
		return invalidPlan(key, "a PostgreSQL database is required")
	}
	if work == nil {
		return invalidPlan(key, "maintained transaction work must not be nil")
	}
	if err := maintenance.Validate(key, acquire, wait); err != nil {
		return err
	}

	grant, err := acquireLease(ctx, key, wait, acquire, lease)
	if err != nil {
		return err
	}
	inner := runMaintainedXact(ctx, key, wait, acquire, maintenance, lease, grant, db, work)
	return settle(ctx, key, lease, grant, inner)
}

// WithMaintainedBoth is the blocking both-layer path with package defaults.
func WithMaintainedBoth(
	ctx context.Context,
	key LockKey,
	lease Lease,
	db *sql.DB,
	work func(context.Context, MaintainedXactGuarded) error,
) error {
	return WithMaintainedXactLock(
		ctx,
		key,
		true,
		DefaultAcquireOptions(),
		DefaultLeaseMaintenanceOptions(),
		lease,
		db,
		work,
	)
}

func runMaintainedXact(
	ctx context.Context,
	key LockKey,
	wait bool,
	acquire AcquireOptions,
	maintenance LeaseMaintenanceOptions,
	lease Lease,
	grant LeaseGrant,
	db *sql.DB,
	work func(context.Context, MaintainedXactGuarded) error,
) error {
	workCtx, maintainer := startLeaseMaintainer(ctx, lease, grant, acquire.TTL, maintenance.RenewInterval)

	tx, err := db.BeginTx(workCtx, nil)
	if err != nil {
		maintained := maintainer.stop()
		if maintained != nil {
			return cleanupFailure(maintained, dbErr(key, StepPgBegin, err))
		}
		if cause := maintenanceCause(workCtx); cause != nil {
			return cause
		}
		return dbErr(key, StepPgBegin, err)
	}

	inner := acquireMaintainedXactLock(workCtx, key, wait, acquire, tx)
	if inner == nil {
		if err := work(workCtx, MaintainedXactGuarded{
			Guarded: Guarded{Key: key, Grant: &grant},
			Tx:      tx,
		}); err != nil {
			inner = workErr(key, err)
		}
	}

	if maintained := maintainer.stop(); maintained != nil {
		inner = cleanupFailure(maintained, inner)
	}
	if inner == nil && ctx.Err() != nil {
		inner = workErr(key, ctx.Err())
	}
	if inner == nil {
		_, inner = renewChecked(ctx, lease, grant, acquire.TTL)
	}
	if inner != nil {
		return rollbackMaintained(tx, key, inner)
	}

	if err := tx.Commit(); err != nil {
		return dbErr(key, StepPgCommit, err)
	}
	return nil
}

func acquireMaintainedXactLock(
	ctx context.Context,
	key LockKey,
	wait bool,
	acquire AcquireOptions,
	tx *sql.Tx,
) error {
	started := time.Now()
	for {
		var acquired bool
		err := tx.QueryRowContext(ctx, "SELECT pg_try_advisory_xact_lock($1)", key.Advisory()).Scan(&acquired)
		if err != nil {
			if cause := maintenanceCause(ctx); cause != nil {
				return cause
			}
			step := StepPgTryAdvisoryXactLock
			if wait {
				step = StepPgAdvisoryXactLock
			}
			return dbErr(key, step, err)
		}
		if acquired {
			return nil
		}
		if !wait {
			return contention(key, StepPgTryAdvisoryXactLock)
		}

		elapsed := time.Since(started)
		if elapsed >= acquire.WaitTimeout {
			return timeout(key, StepPgAdvisoryXactLock, acquire.WaitTimeout.Milliseconds())
		}
		remaining := acquire.WaitTimeout - elapsed
		delay := acquire.RetryInterval
		if remaining < delay {
			delay = remaining
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			if cause := maintenanceCause(ctx); cause != nil {
				return cause
			}
			return workErr(key, ctx.Err())
		case <-timer.C:
		}
	}
}

func renewChecked(
	ctx context.Context,
	lease Lease,
	original LeaseGrant,
	ttl time.Duration,
) (LeaseGrant, error) {
	renewed, err := lease.Renew(ctx, original, ttl)
	if err != nil {
		return LeaseGrant{}, tagStep(err, StepFiduciaRenew)
	}

	var changed string
	switch {
	case renewed.Key != original.Key:
		changed = "key"
	case renewed.Holder != original.Holder:
		changed = "holder"
	case renewed.FencingToken != original.FencingToken:
		changed = "fencing token"
	}
	if changed != "" {
		return LeaseGrant{}, newError(
			KindLostLease,
			original.Key,
			StepFiduciaRenew,
			"fiducia renewal changed the grant "+changed+"; fenced authority cannot be proven",
			nil,
		)
	}
	return renewed, nil
}

func rollbackMaintained(tx *sql.Tx, key LockKey, inner error) error {
	if err := tx.Rollback(); err != nil && !errors.Is(err, sql.ErrTxDone) {
		return cleanupFailure(dbErr(key, StepPgRollback, err), inner)
	}
	return inner
}

func maintenanceCause(ctx context.Context) error {
	cause := context.Cause(ctx)
	var lockErr *Error
	if errors.As(cause, &lockErr) {
		return lockErr
	}
	return nil
}

type leaseMaintainer struct {
	stopOnce sync.Once
	stopCh   chan struct{}
	doneCh   chan struct{}
	cancel   context.CancelCauseFunc

	mu      sync.Mutex
	failure error
}

func startLeaseMaintainer(
	parent context.Context,
	lease Lease,
	grant LeaseGrant,
	ttl time.Duration,
	interval time.Duration,
) (context.Context, *leaseMaintainer) {
	workCtx, cancel := context.WithCancelCause(parent)
	maintainer := &leaseMaintainer{
		stopCh: make(chan struct{}),
		doneCh: make(chan struct{}),
		cancel: cancel,
	}
	go maintainer.run(parent, lease, grant, ttl, interval)
	return workCtx, maintainer
}

func (m *leaseMaintainer) run(
	ctx context.Context,
	lease Lease,
	grant LeaseGrant,
	ttl time.Duration,
	interval time.Duration,
) {
	defer close(m.doneCh)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-m.stopCh:
			return
		case <-ctx.Done():
			return
		case <-ticker.C:
			if _, err := renewChecked(ctx, lease, grant, ttl); err != nil {
				m.mu.Lock()
				m.failure = err
				m.mu.Unlock()
				m.cancel(err)
				return
			}
		}
	}
}

func (m *leaseMaintainer) stop() error {
	m.stopOnce.Do(func() { close(m.stopCh) })
	<-m.doneCh
	m.cancel(nil)
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.failure
}
