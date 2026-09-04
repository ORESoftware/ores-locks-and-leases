package oreslocks

import (
	"context"
	"database/sql"
	"fmt"
)

// XactGuarded is what transaction-scoped work receives: the Guarded layers
// plus the transaction holding the advisory lock. Run every statement of the
// work through Tx; the lock is released when the routine commits it.
type XactGuarded struct {
	Guarded
	Tx *sql.Tx
}

// WithXactLock runs work under a fiducia lease and/or a transaction-scoped
// Postgres advisory lock (pg_advisory_xact_lock), via database/sql.
//
//   - layers.Fiducia needs a non-nil lease; layers.PgAdvisory needs a non-nil
//     db. A missing one is KindInvalidPlan before anything is acquired.
//   - wait=false uses the non-blocking form of every acquisition and fails
//     fast with KindContention.
//   - The transaction is committed after work succeeds and rolled back when
//     it fails; the lease is released in both cases.
//   - If work and commit succeeded but the lease had already lapsed, the
//     result is KindLostLease — the effects are durable but may have raced
//     the next holder.
func WithXactLock(ctx context.Context, key LockKey, layers Layers, wait bool, opts AcquireOptions, lease Lease, db *sql.DB, work func(context.Context, XactGuarded) error) error {
	if layers.Fiducia && lease == nil {
		return invalidPlan(key, "layers.fiducia is enabled but no lease authority was supplied")
	}
	if layers.PgAdvisory && db == nil {
		return invalidPlan(key, "layers.pg_advisory is enabled but no database was supplied")
	}
	if !layers.Fiducia {
		lease = nil
	}

	var grant LeaseGrant
	if lease != nil {
		g, err := acquireLease(ctx, key, wait, opts, lease)
		if err != nil {
			return err
		}
		grant = g
	}
	guarded := Guarded{Key: key}
	if lease != nil {
		guarded.Grant = &grant
	}

	var inner error
	if !layers.PgAdvisory {
		if err := work(ctx, XactGuarded{Guarded: guarded}); err != nil {
			inner = workErr(key, err)
		}
	} else {
		inner = runXact(ctx, key, wait, db, guarded, work)
	}

	if lease == nil {
		return inner
	}
	return settle(ctx, key, lease, grant, inner)
}

func runXact(ctx context.Context, key LockKey, wait bool, db *sql.DB, guarded Guarded, work func(context.Context, XactGuarded) error) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return dbErr(key, StepPgBegin, err)
	}
	if err := xactLock(ctx, tx, key, wait); err != nil {
		_ = tx.Rollback()
		return err
	}
	if err := work(ctx, XactGuarded{Guarded: guarded, Tx: tx}); err != nil {
		_ = tx.Rollback()
		return workErr(key, err)
	}
	if err := tx.Commit(); err != nil {
		return dbErr(key, StepPgCommit, err)
	}
	return nil
}

func xactLock(ctx context.Context, tx *sql.Tx, key LockKey, wait bool) error {
	if wait {
		if _, err := tx.ExecContext(ctx, "SELECT pg_advisory_xact_lock($1)", key.Advisory()); err != nil {
			return dbErr(key, StepPgAdvisoryXactLock, err)
		}
		return nil
	}
	var acquired bool
	if err := tx.QueryRowContext(ctx, "SELECT pg_try_advisory_xact_lock($1)", key.Advisory()).Scan(&acquired); err != nil {
		return dbErr(key, StepPgTryAdvisoryXactLock, err)
	}
	if !acquired {
		return contention(key, StepPgTryAdvisoryXactLock)
	}
	return nil
}

// WithSessionLock runs work under a fiducia lease and/or a session-scoped
// Postgres advisory lock (pg_advisory_lock / pg_advisory_unlock). No
// transaction is opened: this is the routine for work that must not run
// inside one. The session lock is taken on a connection checked out of db
// for the whole guarded section (sql.DB.Conn), so lock, work and unlock are
// guaranteed to reach the same Postgres session; work receives that
// connection and should run its statements through it.
//
// An unlock that reports the session did not hold the lock is KindDatabase
// at pg.advisory_unlock and wins over a successful work, because the
// exclusion the caller relied on was not real.
func WithSessionLock(ctx context.Context, key LockKey, layers Layers, wait bool, opts AcquireOptions, lease Lease, db *sql.DB, work func(context.Context, SessionGuarded) error) error {
	if layers.Fiducia && lease == nil {
		return invalidPlan(key, "layers.fiducia is enabled but no lease authority was supplied")
	}
	if layers.PgAdvisory && db == nil {
		return invalidPlan(key, "layers.pg_advisory is enabled with session scope but no database was supplied")
	}
	if !layers.Fiducia {
		lease = nil
	}

	var grant LeaseGrant
	if lease != nil {
		g, err := acquireLease(ctx, key, wait, opts, lease)
		if err != nil {
			return err
		}
		grant = g
	}
	guarded := Guarded{Key: key}
	if lease != nil {
		guarded.Grant = &grant
	}

	var inner error
	if !layers.PgAdvisory {
		if err := work(ctx, SessionGuarded{Guarded: guarded}); err != nil {
			inner = workErr(key, err)
		}
	} else {
		inner = runSession(ctx, key, wait, db, guarded, work)
	}

	if lease == nil {
		return inner
	}
	return settle(ctx, key, lease, grant, inner)
}

// SessionGuarded is what session-scoped work receives: the Guarded layers
// plus the dedicated connection holding the advisory lock (nil when the
// Postgres layer is off).
type SessionGuarded struct {
	Guarded
	Conn *sql.Conn
}

func runSession(ctx context.Context, key LockKey, wait bool, db *sql.DB, guarded Guarded, work func(context.Context, SessionGuarded) error) error {
	conn, err := db.Conn(ctx)
	if err != nil {
		return dbErr(key, StepPgAdvisoryLock, err)
	}
	defer conn.Close()

	if wait {
		if _, err := conn.ExecContext(ctx, "SELECT pg_advisory_lock($1)", key.Advisory()); err != nil {
			return dbErr(key, StepPgAdvisoryLock, err)
		}
	} else {
		var acquired bool
		if err := conn.QueryRowContext(ctx, "SELECT pg_try_advisory_lock($1)", key.Advisory()).Scan(&acquired); err != nil {
			return dbErr(key, StepPgTryAdvisoryLock, err)
		}
		if !acquired {
			return contention(key, StepPgTryAdvisoryLock)
		}
	}

	var inner error
	if err := work(ctx, SessionGuarded{Guarded: guarded, Conn: conn}); err != nil {
		inner = workErr(key, err)
	}

	// Unlock on a context that ignores cancellation: a leaked session lock
	// outlives the request.
	var unlocked bool
	err = conn.QueryRowContext(context.WithoutCancel(ctx), "SELECT pg_advisory_unlock($1)", key.Advisory()).Scan(&unlocked)
	switch {
	case inner != nil:
		return inner
	case err != nil:
		return dbErr(key, StepPgAdvisoryUnlock, err)
	case !unlocked:
		return newError(KindDatabase, key, StepPgAdvisoryUnlock, fmt.Sprintf("pg_advisory_unlock reported the session did not hold `%s`", key), nil)
	default:
		return nil
	}
}
