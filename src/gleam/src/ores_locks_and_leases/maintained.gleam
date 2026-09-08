//// Fail-closed Fiducia + PostgreSQL transaction coordination for Gleam.
////
//// Gleam work is synchronous at this API boundary, so long-running work gets
//// an explicit `maintain` checkpoint. Advisory-lock contention renews
//// automatically, and one final renewal is unconditional before the pog
//// transaction callback may return `Ok` and commit.

import gleam/erlang/process
import gleam/option.{None, Some}
import gleam/result
import gleam/string
import ores_locks_and_leases as core
import ores_locks_and_leases/pg as locks_pg
import pog

/// What maintained work receives. All protected SQL must use `conn`.
pub type Guarded {
  Guarded(
    key: core.LockKey,
    grant: core.LeaseGrant,
    conn: pog.Connection,
    /// Call this checkpoint during long synchronous work. Failure means stop
    /// immediately and return an error so the transaction rolls back.
    maintain: fn() -> Result(Nil, core.LockError),
  )
}

/// Hold a Fiducia lease around one PostgreSQL transaction-scoped advisory
/// lock. Waiting polls `pg_try_advisory_xact_lock` so the outer lease can be
/// renewed. Work can renew cooperatively through `guarded.maintain`; a final
/// renewal always gates commit.
pub fn with_maintained_xact_lock(
  key: core.LockKey,
  wait: Bool,
  opts: core.AcquireOptions,
  maintenance: core.LeaseMaintenanceOptions,
  lease: core.Lease,
  db: pog.Connection,
  work: fn(Guarded) -> Result(t, String),
) -> Result(t, core.LockError) {
  use _ <- result.try(core.validate_lease_maintenance_options(
    key,
    opts,
    maintenance,
    wait,
  ))
  use grant <- result.try(core.acquire_lease(key, wait, opts, lease))
  let inner = run_transaction(
    db,
    key,
    wait,
    opts,
    maintenance,
    lease,
    grant,
    work,
  )
  core.settle(key, lease, grant, inner)
}

/// Maintained both-layer path with package defaults.
pub fn with_maintained_both(
  key: core.LockKey,
  lease: core.Lease,
  db: pog.Connection,
  work: fn(Guarded) -> Result(t, String),
) -> Result(t, core.LockError) {
  with_maintained_xact_lock(
    key,
    True,
    core.default_acquire_options(),
    core.default_lease_maintenance_options(),
    lease,
    db,
    work,
  )
}

fn run_transaction(
  db: pog.Connection,
  key: core.LockKey,
  wait: Bool,
  opts: core.AcquireOptions,
  maintenance: core.LeaseMaintenanceOptions,
  lease: core.Lease,
  grant: core.LeaseGrant,
  work: fn(Guarded) -> Result(t, String),
) -> Result(t, core.LockError) {
  let outcome =
    pog.transaction(db, fn(conn) {
      let maintain = fn() {
        core.renew_checked(lease, grant, opts.ttl_ms)
        |> result.map(fn(_) { Nil })
      }
      case acquire_lock(
        conn,
        key,
        wait,
        opts,
        maintenance,
        lease,
        grant,
        0,
        0,
      ) {
        Error(error) -> Error(encode_error(error))
        Ok(Nil) ->
          case work(Guarded(key, grant, conn, maintain)) {
            Error(cause) -> Error(encode_error(core.work_error(key, cause)))
            Ok(value) ->
              case maintain() {
                Ok(Nil) -> Ok(value)
                Error(error) -> Error(encode_error(error))
              }
          }
      }
    })

  case outcome {
    Ok(value) -> Ok(value)
    Error(pog.TransactionRolledBack(encoded)) ->
      Error(decode_error(key, encoded))
    Error(pog.TransactionQueryError(error)) ->
      Error(core.database_error(
        key,
        core.PgCommit,
        string.inspect(error),
      ))
  }
}

fn acquire_lock(
  conn: pog.Connection,
  key: core.LockKey,
  wait: Bool,
  opts: core.AcquireOptions,
  maintenance: core.LeaseMaintenanceOptions,
  lease: core.Lease,
  grant: core.LeaseGrant,
  elapsed_ms: Int,
  since_renew_ms: Int,
) -> Result(Nil, core.LockError) {
  case locks_pg.try_xact_lock(conn, key) {
    Ok(Nil) -> Ok(Nil)
    Error(error) ->
      case error.kind, wait {
        core.Contention, False -> Error(error)
        core.Contention, True -> {
          case elapsed_ms >= opts.wait_timeout_ms {
            True ->
              Error(core.timeout(
                key,
                core.PgAdvisoryXactLock,
                opts.wait_timeout_ms,
              ))
            False -> {
              let remaining = opts.wait_timeout_ms - elapsed_ms
              let delay = min_int(opts.retry_interval_ms, remaining)
              process.sleep(delay)
              let next_elapsed = elapsed_ms + delay
              let next_since_renew = since_renew_ms + delay
              case next_since_renew >= maintenance.renew_interval_ms {
                True -> {
                  use _ <- result.try(core.renew_checked(
                    lease,
                    grant,
                    opts.ttl_ms,
                  ))
                  acquire_lock(
                    conn,
                    key,
                    wait,
                    opts,
                    maintenance,
                    lease,
                    grant,
                    next_elapsed,
                    0,
                  )
                }
                False ->
                  acquire_lock(
                    conn,
                    key,
                    wait,
                    opts,
                    maintenance,
                    lease,
                    grant,
                    next_elapsed,
                    next_since_renew,
                  )
              }
            }
          }
        }
        _, _ -> Error(error)
      }
  }
}

fn min_int(left: Int, right: Int) -> Int {
  case left <= right {
    True -> left
    False -> right
  }
}

// pog's transaction callback carries a String on the error path. Preserve the
// shared structured failure across that boundary.
const error_separator = "\u{1F}"

fn encode_error(error: core.LockError) -> String {
  let step = case error.step {
    Some(step) -> core.step_to_string(step)
    None -> ""
  }
  core.kind_to_string(error.kind)
  <> error_separator
  <> step
  <> error_separator
  <> error.message
}

fn decode_error(key: core.LockKey, encoded: String) -> core.LockError {
  case string.split(encoded, error_separator) {
    [kind, step, message] -> {
      let kind = case kind {
        "contention" -> core.Contention
        "timeout" -> core.Timeout
        "lost_lease" -> core.LostLease
        "transport" -> core.Transport
        "database" -> core.Database
        "work" -> core.WorkFailed
        _ -> core.InvalidPlan
      }
      let step = case core.step_from_string(step) {
        Ok(step) -> Some(step)
        Error(Nil) -> None
      }
      core.LockError(kind, key, step, message)
    }
    _ -> core.database_error(key, core.PgRollback, encoded)
  }
}
