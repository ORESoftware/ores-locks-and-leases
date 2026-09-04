//// The inner layer over `pog`: transaction- and session-scoped Postgres
//// advisory locks, composed with the fiducia lease from the core module.
////
//// Session scope needs one physical connection for lock, work and unlock.
//// `pog` pools, so `DedicatedConnection` wraps a pool built with
//// `pog.pool_size(1)` — the only handle `with_session_lock` accepts.

import gleam/dynamic/decode
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import ores_locks_and_leases as core
import pog

/// What `work` receives: whichever layers are engaged.
pub type Guarded {
  Guarded(
    key: core.LockKey,
    /// The fiducia grant when `layers.fiducia` is on; its `fencing_token`
    /// is what guarded writes should record.
    grant: Option(core.LeaseGrant),
    /// The connection whose open transaction holds the advisory lock (or the
    /// dedicated session, for `with_session_lock`), when the Postgres layer
    /// is on. Run every statement of the work through it.
    conn: Option(pog.Connection),
  )
}

fn key_param(key: core.LockKey) -> pog.Value {
  pog.int(core.key_advisory(key))
}

fn query_error_message(error: pog.QueryError) -> String {
  string.inspect(error)
}

fn exec(
  conn: pog.Connection,
  key: core.LockKey,
  sql: String,
  step: core.Step,
) -> Result(Nil, core.LockError) {
  pog.query(sql)
  |> pog.parameter(key_param(key))
  |> pog.execute(conn)
  |> result.map(fn(_) { Nil })
  |> result.map_error(fn(error) {
    core.database_error(key, step, query_error_message(error))
  })
}

fn query_bool(
  conn: pog.Connection,
  key: core.LockKey,
  sql: String,
  step: core.Step,
) -> Result(Bool, core.LockError) {
  let decoder = {
    use value <- decode.field(0, decode.bool)
    decode.success(value)
  }
  pog.query(sql)
  |> pog.parameter(key_param(key))
  |> pog.returning(decoder)
  |> pog.execute(conn)
  |> result.map_error(fn(error) {
    core.database_error(key, step, query_error_message(error))
  })
  |> result.try(fn(returned) {
    case returned.rows {
      [value, ..] -> Ok(value)
      [] ->
        Error(core.database_error(key, step, "`" <> sql <> "` returned no row"))
    }
  })
}

/// `SELECT pg_advisory_xact_lock($1)` on `conn`, which must be inside a
/// transaction. Released at commit/rollback.
pub fn xact_lock(
  conn: pog.Connection,
  key: core.LockKey,
) -> Result(Nil, core.LockError) {
  exec(conn, key, "SELECT pg_advisory_xact_lock($1)", core.PgAdvisoryXactLock)
}

/// `SELECT pg_try_advisory_xact_lock($1)`. A held key is `Contention`.
pub fn try_xact_lock(
  conn: pog.Connection,
  key: core.LockKey,
) -> Result(Nil, core.LockError) {
  use acquired <- result.try(query_bool(
    conn,
    key,
    "SELECT pg_try_advisory_xact_lock($1)",
    core.PgTryAdvisoryXactLock,
  ))
  case acquired {
    True -> Ok(Nil)
    False -> Error(core.contention(key, core.PgTryAdvisoryXactLock))
  }
}

/// Run `work` under a fiducia lease and/or a transaction-scoped advisory
/// lock. `layers.fiducia` needs `lease`; `layers.pg_advisory` needs `db`; a
/// missing one is `InvalidPlan` before anything is acquired. The
/// transaction commits when `work` returns `Ok` and rolls back on `Error`;
/// the lease is released either way.
pub fn with_xact_lock(
  key: core.LockKey,
  layers: core.Layers,
  wait: Bool,
  opts: core.AcquireOptions,
  lease: Option(core.Lease),
  db: Option(pog.Connection),
  work: fn(Guarded) -> Result(t, String),
) -> Result(t, core.LockError) {
  use lease <- result.try(pick_lease(key, layers, lease))
  use db <- result.try(case layers.pg_advisory, db {
    False, _ -> Ok(None)
    True, Some(db) -> Ok(Some(db))
    True, None ->
      Error(core.invalid_plan(
        key,
        "layers.pg_advisory is enabled but no database connection was supplied",
      ))
  })
  use grant <- result.try(acquire(key, wait, opts, lease))

  let inner = case db {
    None ->
      work(Guarded(key, grant, None))
      |> result.map_error(core.work_error(key, _))
    Some(db) -> run_xact(db, key, wait, grant, work)
  }
  finish(key, lease, grant, inner)
}

fn run_xact(
  db: pog.Connection,
  key: core.LockKey,
  wait: Bool,
  grant: Option(core.LeaseGrant),
  work: fn(Guarded) -> Result(t, String),
) -> Result(t, core.LockError) {
  // pog rolls the transaction back when the callback returns Error; the
  // error string carries the serialized LockError so the step survives.
  let outcome =
    pog.transaction(db, fn(conn) {
      let locked = case wait {
        True -> xact_lock(conn, key)
        False -> try_xact_lock(conn, key)
      }
      case locked {
        Error(error) -> Error(encode_error(error))
        Ok(Nil) ->
          case work(Guarded(key, grant, Some(conn))) {
            Ok(value) -> Ok(value)
            Error(cause) -> Error(encode_error(core.work_error(key, cause)))
          }
      }
    })
  case outcome {
    Ok(value) -> Ok(value)
    Error(pog.TransactionRolledBack(encoded)) ->
      Error(decode_error(key, encoded))
    Error(pog.TransactionQueryError(error)) ->
      Error(core.database_error(key, core.PgCommit, query_error_message(error)))
  }
}

// pog's transaction callback carries a String on the error path. The kind and
// step are packed into it and unpacked on the way out so callers see the
// same structured error as every other slice.
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

/// A `pog` pool holding exactly one physical connection, so every statement
/// — lock, work, unlock — reaches the same Postgres session.
pub opaque type DedicatedConnection {
  DedicatedConnection(pog.Connection)
}

/// Wrap a connection the caller built with `pog.pool_size(1)`. A larger
/// pool makes `pg_advisory_unlock` a silent no-op on a different session.
pub fn dedicated(conn: pog.Connection) -> DedicatedConnection {
  DedicatedConnection(conn)
}

pub fn dedicated_inner(conn: DedicatedConnection) -> pog.Connection {
  let DedicatedConnection(inner) = conn
  inner
}

/// Run `work` under a fiducia lease and/or a session-scoped advisory lock.
/// No transaction is opened. The lock is always unlocked after `work`; an
/// unlock that reports the session did not hold the lock is `Database` at
/// `pg.advisory_unlock` and wins over a successful `work`.
pub fn with_session_lock(
  key: core.LockKey,
  layers: core.Layers,
  wait: Bool,
  opts: core.AcquireOptions,
  lease: Option(core.Lease),
  conn: Option(DedicatedConnection),
  work: fn(Guarded) -> Result(t, String),
) -> Result(t, core.LockError) {
  use lease <- result.try(pick_lease(key, layers, lease))
  use conn <- result.try(case layers.pg_advisory, conn {
    False, _ -> Ok(None)
    True, Some(conn) -> Ok(Some(dedicated_inner(conn)))
    True, None ->
      Error(core.invalid_plan(
        key,
        "layers.pg_advisory is enabled with session scope but no dedicated connection was supplied",
      ))
  })
  use grant <- result.try(acquire(key, wait, opts, lease))

  let inner = case conn {
    None ->
      work(Guarded(key, grant, None))
      |> result.map_error(core.work_error(key, _))
    Some(conn) -> run_session(conn, key, wait, grant, work)
  }
  finish(key, lease, grant, inner)
}

fn run_session(
  conn: pog.Connection,
  key: core.LockKey,
  wait: Bool,
  grant: Option(core.LeaseGrant),
  work: fn(Guarded) -> Result(t, String),
) -> Result(t, core.LockError) {
  use _ <- result.try(case wait {
    True -> exec(conn, key, "SELECT pg_advisory_lock($1)", core.PgAdvisoryLock)
    False -> {
      use acquired <- result.try(query_bool(
        conn,
        key,
        "SELECT pg_try_advisory_lock($1)",
        core.PgTryAdvisoryLock,
      ))
      case acquired {
        True -> Ok(Nil)
        False -> Error(core.contention(key, core.PgTryAdvisoryLock))
      }
    }
  })
  let inner =
    work(Guarded(key, grant, Some(conn)))
    |> result.map_error(core.work_error(key, _))
  let unlocked =
    query_bool(
      conn,
      key,
      "SELECT pg_advisory_unlock($1)",
      core.PgAdvisoryUnlock,
    )
  case inner, unlocked {
    Error(inner), Error(cleanup) -> Error(core.cleanup_failure(cleanup, inner))
    Error(inner), Ok(False) ->
      Error(core.cleanup_failure(unlock_mismatch(key), inner))
    Error(inner), Ok(True) -> Error(inner)
    Ok(_), Error(error) -> Error(error)
    Ok(_), Ok(False) -> Error(unlock_mismatch(key))
    Ok(value), Ok(True) -> Ok(value)
  }
}

fn unlock_mismatch(key: core.LockKey) -> core.LockError {
  core.database_error(
    key,
    core.PgAdvisoryUnlock,
    "pg_advisory_unlock reported the session did not hold the lock",
  )
}

fn pick_lease(
  key: core.LockKey,
  layers: core.Layers,
  lease: Option(core.Lease),
) -> Result(Option(core.Lease), core.LockError) {
  case layers.fiducia, lease {
    False, _ -> Ok(None)
    True, Some(lease) -> Ok(Some(lease))
    True, None ->
      Error(core.invalid_plan(
        key,
        "layers.fiducia is enabled but no lease authority was supplied",
      ))
  }
}

fn acquire(
  key: core.LockKey,
  wait: Bool,
  opts: core.AcquireOptions,
  lease: Option(core.Lease),
) -> Result(Option(core.LeaseGrant), core.LockError) {
  case lease {
    None -> Ok(None)
    Some(lease) ->
      core.acquire_lease(key, wait, opts, lease) |> result.map(Some)
  }
}

fn finish(
  key: core.LockKey,
  lease: Option(core.Lease),
  grant: Option(core.LeaseGrant),
  inner: Result(t, core.LockError),
) -> Result(t, core.LockError) {
  case lease, grant {
    Some(lease), Some(grant) -> core.settle(key, lease, grant, inner)
    _, _ -> inner
  }
}
