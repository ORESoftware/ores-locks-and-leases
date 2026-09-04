# Design

## Two layers, one order

Every routine in every slice performs the same sequence for the same inputs:

```text
fiducia.acquire ─► pg.begin ─► pg.advisory_xact_lock ─► work ─► pg.commit ─► fiducia.release   (transaction scope)
fiducia.acquire ─► pg.advisory_lock ─► work ─► pg.advisory_unlock ─► fiducia.release            (session scope)
```

The fiducia lease is the **outermost** layer because it is the only one that
spans hosts and databases, and because it is the one with a clock: a holder
that dies mid-work stops renewing and the lease lapses, so the next holder is
never blocked forever. The Postgres advisory lock is **inside** it because it
is the layer the database enforces — a transaction-scoped lock cannot leak,
and a session-scoped lock dies with its connection — so it protects the data
even when the lease authority is misconfigured, split, or switched off.

`plan(layers, scope, wait)` returns that sequence as data. It is a pure
function in each language and every slice is tested against the same matrix,
`conformance/cases/lock-plan.json`, so the ordering is a checked fact rather
than a convention.

## Each layer is a boolean

`LockLayers { fiducia, pgAdvisory }` is what a call site flips:

| fiducia | pgAdvisory | meaning |
| --- | --- | --- |
| false | false | pass-through: `work` runs, nothing is acquired (tests, single-writer dev) |
| true | false | cross-host exclusion + fencing token, no database |
| false | true | single-database exclusion; the lease authority is not involved |
| true | true | the fleet default for anything that mutates shared state |

Turning a layer on without supplying its dependency (a lease authority, a
pool, a dedicated connection) is `invalid_plan` *before* anything is
acquired, never a silent downgrade.

## Transaction vs session scope

`PgScope::Transaction` opens a transaction, takes `pg_advisory_xact_lock`
inside it, runs `work` with that transaction, and commits. The lock is
released by Postgres at commit or rollback; there is nothing to unlock and
nothing that can be forgotten. This is the default and the right choice
whenever the work is itself a set of statements.

`PgScope::Session` takes `pg_advisory_lock` on one connection, runs `work`,
then `pg_advisory_unlock`. No transaction is opened, which is the point: DDL
that cannot run in a transaction, long jobs that commit in batches, or work
that touches no database at all but wants a database-enforced mutex. The
catch is pooling — lock and unlock must reach the *same* Postgres session.
Each slice makes that a type or a checked-out handle rather than a comment:
Rust's `DedicatedConnection` (SeaORM pool of one), Go's `sql.DB.Conn`, TS's
`pool.connect()` held for the section, Dart's `Pool.withConnection`, Gleam's
`dedicated(pog.pool_size(1))`.

## Key derivation

Postgres advisory functions take a `bigint`. Every slice derives it the same
way — FNV-1a 64 over the UTF-8 bytes of the string key, reinterpreted as a
two's-complement signed 64-bit integer — with vectors pinned in
`conformance/cases/advisory-key.json`. FNV-1a was chosen over a cryptographic
hash because every runtime implements it in a dozen dependency-free lines,
and over `hashtext()` because that is `int4` and version-dependent. A
collision only costs unnecessary serialization: advisory locks are
cooperative, never a correctness boundary.

Keys follow `<org>/<domain>/<name>`; each `*-lib-core` wraps this package
with its org prefix so two orgs sharing a database cannot collide by
accident.

## Fencing

A fiducia grant carries a `fencing_token` that increases monotonically per
key. The routines hand it to `work` so guarded writes can record it
(`UPDATE … SET fencing_token = $t WHERE fencing_token < $t`). A holder whose
lease lapsed mid-work — GC pause, network partition — then cannot overwrite
the next holder's writes even though its process believes it still holds the
lock. The `LostLease` error kind exists for exactly that case: `work`
succeeded, but the release matched no grant, so the effects are durable and
may have raced the next holder. Callers decide whether that is recoverable;
the routine will not hide it.

## Failure semantics

| kind | when | outer layers |
| --- | --- | --- |
| `contention` | `wait == false` and a layer is held | everything already held is released |
| `timeout` | `wait == true` and the budget elapsed | same |
| `lost_lease` | renewal refused, or release matched no grant after successful work | — |
| `transport` | the lease authority could not be reached; **ownership unknown** | nothing is assumed |
| `database` | begin / lock statement / commit / unlock failed | transaction rolled back, lease released |
| `work` | the caller's work failed | transaction rolled back, lease released |
| `invalid_plan` | inputs cannot be planned | nothing was acquired |

`transport` is deliberately not `contention`: a 503 from the node does not
mean the key is free, and treating it that way is the two-leader bug.

## Contracts

The types above are authored twice — `contracts/typespec/main.tsp` and
`contracts/json-schema/contract.schema.json` — as independent, human-written
peers that `ORESoftware/ores-contracts` parses separately and refuses to emit
from until they agree. The generated Rust/TypeScript/Dart types are what the
`*-interfaces` repositories import; the slices here keep hand-written types
with the same names and wire forms because they predate the emitters and
carry behavior (builders, `Display`, `parse`).
