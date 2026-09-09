//// Maintained Fiducia + PostgreSQL transaction coordination.
////
//// This module owns the database boundary while the core module owns grant
//// identity, renewal validation, cleanup precedence, and plan vocabulary.
//// PostgreSQL acquisition is polled with `pg_try_advisory_xact_lock` so a
//// failed maintenance checkpoint can interrupt contention.

import gleam/int
import gleam/option.{None, Some}
import gleam/result
import gleam/string
import ores_locks_and_leases as core
import ores_locks_and_leases/pg
import ores_locks_and_leases/renewal as renewal_supervisor

/// A clock/sleep seam for deterministic maintained-wait tests and runtime
/// adapters. `now_ms` must be monotonic; `sleep_ms` may return a lock error when
/// the runtime has already observed cancellation.
pub type Scheduler {
  Scheduler(
    now_ms: fn() -> Int,
    sleep_ms: fn(Int) -> Result(Nil, core.LockError),
  )
}

/// Build a scheduler from caller-provided runtime functions.
pub fn scheduler(
  now_ms: fn() -> Int,
  sleep_ms: fn(Int) -> Result(Nil, core.LockError),
) -> Scheduler {
  Scheduler(now_ms: now_ms, sleep_ms: sleep_ms)
}

/// What maintained Gleam work receives. Because Gleam callbacks are
/// synchronous, cooperative long-running work explicitly calls
/// `maintenance_checkpoint` at its own yield points. Final renewal still gates
/// transaction commit even when work performs no checkpoints.
pub type Guarded {
  Guarded(
    key: core.LockKey,
    grant: core.LeaseGrant,
    transaction: pg.Transaction,
    maintenance_checkpoint: fn() -> Result(Nil, core.LockError),
  )
}

fn acquisition_step(wait: Bool) -> core.Step {
  case wait {
    True -> core.FiduciaAcquire
    False -> core.FiduciaTryAcquire
  }
}

fn lost_authority(
  key: core.LockKey,
  step: core.Step,
  field: String,
  phase: String,
) -> core.LockError {
  core.LockError(
    core.LostLease,
    key,
    Some(step),
    "fiducia "
      <> phase
      <> " returned an invalid grant "
      <> field
      <> "; maintained authority cannot be proven",
  )
}

fn valid_expiry(grant: core.LeaseGrant) -> Bool {
  case grant.lease_expires_ms {
    None -> True
    Some(value) -> value > 0
  }
}

/// Validate the authority result before opening PostgreSQL.
pub fn validate_acquired_grant(
  key: core.LockKey,
  wait: Bool,
  opts: core.AcquireOptions,
  grant: core.LeaseGrant,
) -> Result(Nil, core.LockError) {
  let holder_matches = case opts.holder {
    None -> True
    Some(expected) -> grant.holder == expected
  }
  let changed = case
    core.key_to_string(grant.key) != core.key_to_string(key),
    string.is_empty(grant.holder),
    holder_matches,
    grant.ttl_ms == opts.ttl_ms,
    valid_expiry(grant)
  {
    True, _, _, _, _ -> Some("key")
    _, True, _, _, _ -> Some("holder")
    _, _, False, _, _ -> Some("holder")
    _, _, _, False, _ -> Some("TTL")
    _, _, _, _, False -> Some("expiry")
    False, False, True, True, True -> None
  }
  case changed {
    None -> Ok(Nil)
    Some(field) ->
      Error(lost_authority(key, acquisition_step(wait), field, "acquisition"))
  }
}

/// Maintained renewal requires the exact requested effective TTL in addition
/// to the core key/holder/fencing-token continuity check.
pub fn renew_checked(
  lease: core.Lease,
  grant: core.LeaseGrant,
  ttl_ms: Int,
) -> Result(core.LeaseGrant, core.LockError) {
  use renewed <- result.try(core.renew_checked(lease, grant, ttl_ms))
  let changed = case renewed.ttl_ms == ttl_ms, valid_expiry(renewed) {
    False, _ -> Some("TTL")
    _, False -> Some("expiry")
    True, True -> None
  }
  case changed {
    None -> Ok(renewed)
    Some(field) ->
      Error(lost_authority(grant.key, core.FiduciaRenew, field, "renewal"))
  }
}

fn validate_options(
  key: core.LockKey,
  opts: core.AcquireOptions,
  maintenance: core.LeaseMaintenanceOptions,
  wait: Bool,
) -> Result(Nil, core.LockError) {
  use _ <- result.try(core.validate_lease_maintenance_options(
    key,
    opts,
    maintenance,
    wait,
  ))
  case opts.ttl_ms > renewal_supervisor.max_renewal_ttl_ms {
    True ->
      Error(core.invalid_plan(
        key,
        "fiducia lease TTL must be no greater than "
          <> int.to_string(renewal_supervisor.max_renewal_ttl_ms)
          <> " ms",
      ))
    False -> Ok(Nil)
  }
}

/// Execute one maintained transaction. The scheduler supplies monotonic time
/// and bounded sleeping while the lease supplies checked renewal. Acquisition
/// and renewal must preserve the requested effective TTL. Any inner error is
/// rolled back; release happens on every path after acquisition.
pub fn with_maintained_xact_lock(
  key: core.LockKey,
  wait: Bool,
  opts: core.AcquireOptions,
  maintenance: core.LeaseMaintenanceOptions,
  lease: core.Lease,
  database: pg.Database,
  scheduler: Scheduler,
  work: fn(Guarded) -> Result(t, String),
) -> Result(t, core.LockError) {
  use _ <- result.try(validate_options(key, opts, maintenance, wait))
  use grant <- result.try(core.acquire_lease(key, wait, opts, lease))

  case validate_acquired_grant(key, wait, opts, grant) {
    Error(error) -> core.settle(key, lease, grant, Error(error))
    Ok(Nil) -> {
      let inner =
        run_transaction(
          key,
          wait,
          opts,
          maintenance,
          lease,
          grant,
          database,
          scheduler,
          work,
        )
      core.settle(key, lease, grant, inner)
    }
  }
}

fn run_transaction(
  key: core.LockKey,
  wait: Bool,
  opts: core.AcquireOptions,
  maintenance: core.LeaseMaintenanceOptions,
  lease: core.Lease,
  grant: core.LeaseGrant,
  database: pg.Database,
  scheduler: Scheduler,
  work: fn(Guarded) -> Result(t, String),
) -> Result(t, core.LockError) {
  use transaction <- result.try(pg.begin(database, key))
  let Scheduler(now_ms: now_ms, sleep_ms: sleep_ms) = scheduler
  let started_ms = now_ms()
  let next_renewal_ms = started_ms + maintenance.renew_interval_ms

  case
    acquire_lock(
      transaction,
      key,
      wait,
      opts,
      maintenance,
      lease,
      grant,
      now_ms,
      sleep_ms,
      started_ms,
      next_renewal_ms,
    )
  {
    Error(error) -> rollback_or_cleanup(transaction, key, error)
    Ok(next_renewal_ms) -> {
      let checkpoint = fn() {
        case now_ms() >= next_renewal_ms {
          True ->
            renew_checked(lease, grant, opts.ttl_ms) |> result.replace(Nil)
          False -> Ok(Nil)
        }
      }
      case work(Guarded(key, grant, transaction, checkpoint)) {
        Error(cause) ->
          rollback_or_cleanup(transaction, key, core.work_error(key, cause))
        Ok(value) ->
          case renew_checked(lease, grant, opts.ttl_ms) {
            Error(error) -> rollback_or_cleanup(transaction, key, error)
            Ok(_) -> pg.commit(transaction, key) |> result.replace(value)
          }
      }
    }
  }
}

fn acquire_lock(
  transaction: pg.Transaction,
  key: core.LockKey,
  wait: Bool,
  opts: core.AcquireOptions,
  maintenance: core.LeaseMaintenanceOptions,
  lease: core.Lease,
  grant: core.LeaseGrant,
  now_ms: fn() -> Int,
  sleep_ms: fn(Int) -> Result(Nil, core.LockError),
  started_ms: Int,
  next_renewal_ms: Int,
) -> Result(Int, core.LockError) {
  case pg.try_xact_lock(transaction, key) {
    Ok(True) -> Ok(next_renewal_ms)
    Error(error) -> Error(error)
    Ok(False) if !wait ->
      Error(core.contention(key, core.PgTryAdvisoryXactLock))
    Ok(False) -> {
      let now = now_ms()
      case now - started_ms >= opts.wait_timeout_ms {
        True ->
          Error(core.timeout(key, core.PgAdvisoryXactLock, opts.wait_timeout_ms))
        False -> {
          let next_renewal_ms = case now >= next_renewal_ms {
            False -> Ok(next_renewal_ms)
            True ->
              renew_checked(lease, grant, opts.ttl_ms)
              |> result.replace(now + maintenance.renew_interval_ms)
          }
          use next_renewal_ms <- result.try(next_renewal_ms)
          let remaining_ms = opts.wait_timeout_ms - { now - started_ms }
          let sleep_for = case opts.retry_interval_ms < remaining_ms {
            True -> opts.retry_interval_ms
            False -> remaining_ms
          }
          use _ <- result.try(sleep_ms(sleep_for))
          acquire_lock(
            transaction,
            key,
            wait,
            opts,
            maintenance,
            lease,
            grant,
            now_ms,
            sleep_ms,
            started_ms,
            next_renewal_ms,
          )
        }
      }
    }
  }
}

fn rollback_or_cleanup(
  transaction: pg.Transaction,
  key: core.LockKey,
  inner: core.LockError,
) -> Result(t, core.LockError) {
  case pg.rollback(transaction, key) {
    Ok(Nil) -> Error(inner)
    Error(cleanup) -> Error(core.cleanup_failure(cleanup, inner))
  }
}
