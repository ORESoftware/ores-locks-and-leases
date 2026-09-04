//// Composed distributed locking for the ORESoftware fleet — the Gleam slice
//// of `ORESoftware/ores-locks-and-leases`.
////
//// Two layers, each individually switchable through `Layers`: an outer
//// fiducia-cloud lease (cross-host, TTL-bounded, fenced) and an inner
//// Postgres advisory lock (transaction- or session-scoped). The order is the
//// contract's and the same in every language slice:
////
////     fiducia.acquire -> pg.begin -> pg.advisory_xact_lock -> work -> pg.commit -> fiducia.release
////
//// This module is the dependency-free core: keys, the plan, errors, the
//// `Lease` seam and `with_lease` (fiducia only / neither). The adapters live
//// beside it: `ores_locks_and_leases/pg` (pog) and
//// `ores_locks_and_leases/fiducia` (gleam_httpc).

import gleam/bit_array
import gleam/int
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result

// --- keys -------------------------------------------------------------------

/// The longest key the contract admits, in UTF-8 bytes.
pub const max_lock_key_bytes = 512

/// A caller-chosen lock identity. Convention: `<org>/<domain>/<name>`.
pub opaque type LockKey {
  LockKey(String)
}

/// Validate the contract's length bound.
pub fn lock_key(key: String) -> Result(LockKey, String) {
  let bytes = bit_array.byte_size(bit_array.from_string(key))
  case bytes > max_lock_key_bytes {
    True ->
      Error(
        "lock key is "
        <> int.to_string(bytes)
        <> " bytes; the contract allows at most "
        <> int.to_string(max_lock_key_bytes),
      )
    False -> Ok(LockKey(key))
  }
}

pub fn key_to_string(key: LockKey) -> String {
  let LockKey(s) = key
  s
}

const fnv_offset_basis = 14_695_981_039_346_656_037

const fnv_prime = 1_099_511_628_211

const mask64 = 18_446_744_073_709_551_615

const two_63 = 9_223_372_036_854_775_808

const two_64 = 18_446_744_073_709_551_616

/// FNV-1a, 64-bit, over the UTF-8 bytes of `key`, as an unsigned integer.
/// Gleam integers are arbitrary precision on the Erlang target, so the
/// product is masked back to 64 bits after every step.
pub fn fnv1a64(key: String) -> Int {
  fold_bytes(bit_array.from_string(key), fnv_offset_basis)
}

fn fold_bytes(bytes: BitArray, hash: Int) -> Int {
  case bytes {
    <<byte:int, rest:bits>> ->
      fold_bytes(
        rest,
        int.bitwise_and(
          int.bitwise_exclusive_or(hash, byte) * fnv_prime,
          mask64,
        ),
      )
    _ -> hash
  }
}

/// The Postgres `bigint` every runtime locks for `key`: FNV-1a 64
/// reinterpreted as a two's-complement signed integer. Vectors:
/// `conformance/cases/advisory-key.json`.
pub fn advisory_key(key: String) -> Int {
  let unsigned = fnv1a64(key)
  case unsigned >= two_63 {
    True -> unsigned - two_64
    False -> unsigned
  }
}

pub fn key_advisory(key: LockKey) -> Int {
  advisory_key(key_to_string(key))
}

// --- plan -------------------------------------------------------------------

/// Which coordination layers a routine engages. Both `False` is a deliberate
/// pass-through for tests and single-writer development.
pub type Layers {
  Layers(fiducia: Bool, pg_advisory: Bool)
}

pub const layers_none = Layers(fiducia: False, pg_advisory: False)

pub const layers_fiducia_only = Layers(fiducia: True, pg_advisory: False)

pub const layers_pg_only = Layers(fiducia: False, pg_advisory: True)

pub const layers_both = Layers(fiducia: True, pg_advisory: True)

/// How the Postgres advisory lock is scoped.
pub type PgScope {
  /// `pg_advisory_xact_lock` inside a transaction the routine opens; the
  /// work runs inside it; released at commit/rollback.
  Transaction
  /// `pg_advisory_lock` / `pg_advisory_unlock` on one dedicated connection;
  /// no transaction is opened.
  Session
}

pub fn pg_scope_to_string(scope: PgScope) -> String {
  case scope {
    Transaction -> "transaction"
    Session -> "session"
  }
}

pub fn pg_scope_from_string(value: String) -> Result(PgScope, Nil) {
  case value {
    "transaction" -> Ok(Transaction)
    "session" -> Ok(Session)
    _ -> Error(Nil)
  }
}

/// One action in a plan. The string forms are the contract's `LockStep`.
pub type Step {
  FiduciaAcquire
  FiduciaTryAcquire
  FiduciaRelease
  PgBegin
  PgAdvisoryXactLock
  PgTryAdvisoryXactLock
  PgCommit
  PgRollback
  PgAdvisoryLock
  PgTryAdvisoryLock
  PgAdvisoryUnlock
  Work
}

pub const all_steps = [
  FiduciaAcquire,
  FiduciaTryAcquire,
  FiduciaRelease,
  PgBegin,
  PgAdvisoryXactLock,
  PgTryAdvisoryXactLock,
  PgCommit,
  PgRollback,
  PgAdvisoryLock,
  PgTryAdvisoryLock,
  PgAdvisoryUnlock,
  Work,
]

pub fn step_to_string(step: Step) -> String {
  case step {
    FiduciaAcquire -> "fiducia.acquire"
    FiduciaTryAcquire -> "fiducia.try_acquire"
    FiduciaRelease -> "fiducia.release"
    PgBegin -> "pg.begin"
    PgAdvisoryXactLock -> "pg.advisory_xact_lock"
    PgTryAdvisoryXactLock -> "pg.try_advisory_xact_lock"
    PgCommit -> "pg.commit"
    PgRollback -> "pg.rollback"
    PgAdvisoryLock -> "pg.advisory_lock"
    PgTryAdvisoryLock -> "pg.try_advisory_lock"
    PgAdvisoryUnlock -> "pg.advisory_unlock"
    Work -> "work"
  }
}

pub fn step_from_string(value: String) -> Result(Step, Nil) {
  list.find(all_steps, fn(step) { step_to_string(step) == value })
}

/// The ordered actions for one `(layers, scope, wait)` tuple.
pub type Plan {
  Plan(layers: Layers, pg_scope: PgScope, wait: Bool, steps: List(Step))
}

/// Compute the plan. Pure; identical across every language slice. `wait`
/// blocks each layer up to its budget; otherwise the non-blocking form of
/// each acquisition is used and the routine fails fast with `Contention`.
pub fn plan(layers: Layers, pg_scope: PgScope, wait: Bool) -> Plan {
  let pick = fn(blocking: Step, non_blocking: Step) -> Step {
    case wait {
      True -> blocking
      False -> non_blocking
    }
  }
  let outer_open = case layers.fiducia {
    True -> [pick(FiduciaAcquire, FiduciaTryAcquire)]
    False -> []
  }
  let inner = case layers.pg_advisory, pg_scope {
    False, _ -> [Work]
    True, Transaction -> [
      PgBegin,
      pick(PgAdvisoryXactLock, PgTryAdvisoryXactLock),
      Work,
      PgCommit,
    ]
    True, Session -> [
      pick(PgAdvisoryLock, PgTryAdvisoryLock),
      Work,
      PgAdvisoryUnlock,
    ]
  }
  let outer_close = case layers.fiducia {
    True -> [FiduciaRelease]
    False -> []
  }
  Plan(
    layers: layers,
    pg_scope: pg_scope,
    wait: wait,
    steps: list.flatten([outer_open, inner, outer_close]),
  )
}

// --- errors -----------------------------------------------------------------

/// Why an acquisition or guarded run failed. The contract's `LockErrorKind`.
pub type Kind {
  /// A layer is held by someone else and `wait` was `False`.
  Contention
  /// The wait budget elapsed before every layer was held.
  Timeout
  /// The fiducia lease could not be renewed or was reaped; fenced authority
  /// is gone and the guarded work must not continue.
  LostLease
  /// Transport/HTTP failure talking to the lease authority; ownership is
  /// unknown — never treat this as "not held".
  Transport
  /// The database refused the advisory statement, the transaction, or the
  /// connection.
  Database
  /// The caller's work failed; outer layers were still released and the
  /// transaction, if any, rolled back.
  WorkFailed
  /// The inputs cannot be planned.
  InvalidPlan
}

pub fn kind_to_string(kind: Kind) -> String {
  case kind {
    Contention -> "contention"
    Timeout -> "timeout"
    LostLease -> "lost_lease"
    Transport -> "transport"
    Database -> "database"
    WorkFailed -> "work"
    InvalidPlan -> "invalid_plan"
  }
}

/// The one structured failure every routine surfaces. The contract's
/// `LockError`.
pub type LockError {
  LockError(kind: Kind, key: LockKey, step: Option(Step), message: String)
}

pub fn error_to_string(error: LockError) -> String {
  let at = case error.step {
    Some(step) -> " at " <> step_to_string(step)
    None -> ""
  }
  kind_to_string(error.kind)
  <> at
  <> " for `"
  <> key_to_string(error.key)
  <> "`: "
  <> error.message
}

/// Retrying the whole routine is reasonable: busy or out of budget, nothing
/// half-done.
pub fn retryable(error: LockError) -> Bool {
  case error.kind {
    Contention | Timeout -> True
    _ -> False
  }
}

pub fn contention(key: LockKey, step: Step) -> LockError {
  LockError(
    Contention,
    key,
    Some(step),
    "`" <> key_to_string(key) <> "` is held by another holder",
  )
}

pub fn timeout(key: LockKey, step: Step, waited_ms: Int) -> LockError {
  LockError(
    Timeout,
    key,
    Some(step),
    "gave up waiting for `"
      <> key_to_string(key)
      <> "` after "
      <> int.to_string(waited_ms)
      <> " ms",
  )
}

pub fn work_error(key: LockKey, cause: String) -> LockError {
  LockError(WorkFailed, key, Some(Work), cause)
}

pub fn invalid_plan(key: LockKey, message: String) -> LockError {
  LockError(InvalidPlan, key, None, message)
}

pub fn database_error(key: LockKey, step: Step, message: String) -> LockError {
  LockError(Database, key, Some(step), message)
}

pub fn transport_error(key: LockKey, message: String) -> LockError {
  LockError(Transport, key, None, message)
}

/// Fill in the step on an error that has none.
pub fn tag_step(error: LockError, step: Step) -> LockError {
  case error.step {
    Some(_) -> error
    None -> LockError(..error, step: Some(step))
  }
}

// --- lease ------------------------------------------------------------------

/// Acquisition tuning shared by every layer. The contract's `AcquireOptions`.
pub type AcquireOptions {
  AcquireOptions(
    /// Lease TTL in ms. Size it to the longest the guarded work can take.
    ttl_ms: Int,
    /// Total time to keep waiting, in ms. Ignored when `wait` is `False`.
    wait_timeout_ms: Int,
    /// Poll interval while waiting on the fiducia layer, in ms.
    retry_interval_ms: Int,
    /// Caller identity for the fiducia layer; also the release key. `None`
    /// lets the adapter generate an unguessable id.
    holder: Option(String),
  )
}

/// Mirrors the official fiducia clients: 60s lease, 30s wait budget, 250ms poll.
pub fn default_acquire_options() -> AcquireOptions {
  AcquireOptions(
    ttl_ms: 60_000,
    wait_timeout_ms: 30_000,
    retry_interval_ms: 250,
    holder: None,
  )
}

/// A held grant. The contract's `LeaseGrant`. `fencing_token` is minted on
/// every grant and increases monotonically; guarded writes should record it.
pub type LeaseGrant {
  LeaseGrant(
    key: LockKey,
    holder: String,
    fencing_token: Int,
    lease_expires_ms: Option(Int),
    ttl_ms: Int,
  )
}

/// A lease authority: three verbs, fenced. Implementations map their native
/// failures onto `Kind`.
pub type Lease {
  Lease(
    /// With `wait`, block up to `wait_timeout_ms`; without it, return
    /// `Contention` at once if the key is held.
    acquire: fn(LockKey, AcquireOptions, Bool) -> Result(LeaseGrant, LockError),
    /// Extend a grant without changing its fencing token. A refusal is
    /// `LostLease`, never a warning.
    renew: fn(LeaseGrant, Int) -> Result(LeaseGrant, LockError),
    /// `Ok(False)` is a committed no-op: the authority matched no grant —
    /// the lease had already lapsed.
    release: fn(LeaseGrant) -> Result(Bool, LockError),
  )
}

/// Run `work` under a fiducia lease only — no database layer. `engage` is
/// the `layers.fiducia` boolean: `False` is the contract's "neither" plan
/// (work runs with `None`, nothing is acquired); `True` with no lease is
/// `InvalidPlan`. The lease is always released, even when `work` fails; a
/// release that matched no grant after a successful `work` is `LostLease`.
pub fn with_lease(
  key: LockKey,
  engage: Bool,
  wait: Bool,
  opts: AcquireOptions,
  lease: Option(Lease),
  work: fn(Option(LeaseGrant)) -> Result(t, String),
) -> Result(t, LockError) {
  case engage, lease {
    False, _ -> work(None) |> result.map_error(work_error(key, _))
    True, None ->
      Error(invalid_plan(
        key,
        "layers.fiducia is enabled but no lease authority was supplied",
      ))
    True, Some(lease) -> {
      use grant <- result.try(acquire_lease(key, wait, opts, lease))
      let inner = work(Some(grant)) |> result.map_error(work_error(key, _))
      settle(key, lease, grant, inner)
    }
  }
}

/// Acquire through the lease, tagging the step on an untagged error.
pub fn acquire_lease(
  key: LockKey,
  wait: Bool,
  opts: AcquireOptions,
  lease: Lease,
) -> Result(LeaseGrant, LockError) {
  let step = case wait {
    True -> FiduciaAcquire
    False -> FiduciaTryAcquire
  }
  lease.acquire(key, opts, wait) |> result.map_error(tag_step(_, step))
}

/// Release the lease and combine its outcome with the inner one.
pub fn settle(
  key: LockKey,
  lease: Lease,
  grant: LeaseGrant,
  inner: Result(t, LockError),
) -> Result(t, LockError) {
  let released = lease.release(grant)
  case inner, released {
    Error(error), _ -> Error(error)
    Ok(_), Error(error) -> Error(tag_step(error, FiduciaRelease))
    Ok(_), Ok(False) ->
      Error(LockError(
        LostLease,
        key,
        Some(FiduciaRelease),
        "release of `"
          <> key_to_string(key)
          <> "` (holder "
          <> grant.holder
          <> ", fencing token "
          <> int.to_string(grant.fencing_token)
          <> ") matched no grant: the lease lapsed while the work ran",
      ))
    Ok(value), Ok(True) -> Ok(value)
  }
}

/// A holder id for adapters when the caller supplied none.
pub fn holder_or(opts: AcquireOptions, generate: fn() -> String) -> String {
  case opts.holder {
    Some(holder) -> holder
    None -> generate()
  }
}
