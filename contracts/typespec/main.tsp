// ores-locks-and-leases — TypeSpec authority.
//
// This file and contracts/json-schema/contract.schema.json are independent,
// human-authored peers (ORESoftware/ores-contracts). Neither is generated
// from the other; `npx ores-contracts check` parses both and refuses to emit
// until they agree. Field names are camelCase here and on the wire; Rust, Go
// and Gleam emit snake_case identifiers with camelCase serialization.

@doc("Cross-language contract for composed distributed leases and Postgres advisory locks.")
namespace Ores.LocksAndLeases;

@doc("A caller-chosen lock identity. Convention: `<org>/<domain>/<name>`, e.g. `zed-pkg/registry/publish:zed-lib-core`.")
@maxLength(512)
scalar LockKey extends string;

@doc("The Postgres advisory-lock integer derived from a LockKey: FNV-1a 64 over the UTF-8 bytes, reinterpreted as a two's-complement bigint. Vectors: conformance/cases/advisory-key.json.")
scalar AdvisoryKey extends int64;

@doc("A monotonically increasing token minted by the lease authority on every grant. Writes guarded by the lease carry it so a stale holder cannot clobber a newer one.")
scalar FencingToken extends int64;

@doc("Which coordination layers a routine engages. Both false is a deliberate pass-through (tests, single-writer dev).")
model LockLayers {
  @doc("Engage the fiducia-cloud lease (outermost layer, cross-host, TTL-bounded, fenced).")
  fiducia: boolean;

  @doc("Engage a Postgres advisory lock (inner layer, single-database, released with the transaction or session).")
  pgAdvisory: boolean;
}

@doc("How the Postgres advisory lock is scoped.")
enum PgScope {
  @doc("pg_advisory_xact_lock inside a transaction the routine opens; released at commit/rollback. The caller's work runs inside that transaction.")
  transaction: "transaction",

  @doc("pg_advisory_lock / pg_advisory_unlock on one dedicated connection; no transaction is opened. For work that must not run inside a transaction.")
  session: "session",
}

@doc("The ordered actions a routine performs for a given LockLayers / PgScope / wait tuple. Matrix: conformance/cases/lock-plan.json.")
enum LockStep {
  fiduciaAcquire: "fiducia.acquire",
  fiduciaTryAcquire: "fiducia.try_acquire",
  fiduciaRelease: "fiducia.release",
  pgBegin: "pg.begin",
  pgAdvisoryXactLock: "pg.advisory_xact_lock",
  pgTryAdvisoryXactLock: "pg.try_advisory_xact_lock",
  pgCommit: "pg.commit",
  pgRollback: "pg.rollback",
  pgAdvisoryLock: "pg.advisory_lock",
  pgTryAdvisoryLock: "pg.try_advisory_lock",
  pgAdvisoryUnlock: "pg.advisory_unlock",
  work: "work",
}

@doc("A pure function of the inputs; every implementation must produce the same steps.")
model LockPlan {
  layers: LockLayers;
  pgScope: PgScope;
  @doc("true: block up to the wait budget; false: fail fast with `contention` when any layer is held.")
  wait: boolean;
  steps: LockStep[];
}

@doc("Acquisition tuning shared by every layer.")
model AcquireOptions {
  @doc("Lease TTL in milliseconds for the fiducia layer. The lease lapses if never renewed or released.")
  ttlMs: int64;

  @doc("Total time to keep waiting before giving up, in milliseconds. Ignored when wait is false.")
  waitTimeoutMs: int64;

  @doc("Poll interval while waiting on the fiducia layer, in milliseconds.")
  retryIntervalMs: int64;

  @doc("Caller identity for the fiducia layer; also the release key. Absent: an unguessable generated id.")
  holder?: string;
}

@doc("A held fiducia grant, as returned by the lease authority.")
model LeaseGrant {
  key: LockKey;
  holder: string;
  fencingToken: FencingToken;
  @doc("Absolute expiry in Unix milliseconds when the authority reports it.")
  leaseExpiresMs?: int64;
  ttlMs: int64;
}

@doc("Why an acquisition or guarded run failed. Implementations map their native error to exactly one kind.")
enum LockErrorKind {
  @doc("A layer is held by someone else and wait was false.")
  contention: "contention",

  @doc("The wait budget elapsed before every layer was held.")
  timeout: "timeout",

  @doc("The fiducia lease could not be renewed or was reaped: fenced authority is lost and the guarded work must not continue.")
  lostLease: "lost_lease",

  @doc("Transport or HTTP failure talking to the lease authority; ownership is unknown.")
  transport: "transport",

  @doc("The database refused the advisory-lock statement, the transaction, or the connection.")
  database: "database",

  @doc("The caller's work returned an error; outer layers were still released/rolled back.")
  work: "work",

  @doc("The inputs cannot be planned (e.g. pgAdvisory with session scope on a pooled connection).")
  invalidPlan: "invalid_plan",
}

@doc("The structured failure every implementation surfaces.")
model LockError {
  kind: LockErrorKind;
  key: LockKey;
  @doc("Which step failed, when known.")
  step?: LockStep;
  message: string;
}
