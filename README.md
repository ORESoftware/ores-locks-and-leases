# ores-locks-and-leases

Composed distributed locking for the ORESoftware fleet: a **fiducia-cloud
lease** around a **Postgres advisory lock**, each layer individually
switchable, with **fencing tokens** threaded through to the guarded work.

```text
fiducia.acquire ─► pg.begin ─► pg.advisory_xact_lock ─► work ─► pg.commit ─► fiducia.release
```

One package, five slices — Rust, Go, TypeScript, Dart, Gleam — all held to the
same `conformance/cases/*.json`, so a job in a Gleam server and a job in a
Rust API server lock the same integer for the same key and unwind in the
same order when something fails. Shared repository, same precedent as
`ores-transport` and `ores-proximity`; every `*-lib-core` imports it through
zed-pkg rather than re-implementing it.

| Path | Package | Postgres via | Fiducia via |
| --- | --- | --- | --- |
| `src/rust` | `ores-locks-and-leases` (crate) | SeaORM (`pg` feature) | official async client (`fiducia` feature) |
| `src/go` | `github.com/ORESoftware/ores-locks-and-leases/src/go` | `database/sql` | `net/http` |
| `src/ts` | `@oresoftware/locks-and-leases` | node-postgres-shaped pool (no `pg` import) | `fetch` |
| `src/dart` | `ores_locks_and_leases` | `package:postgres` | `package:http` |
| `src/gleam` | `ores_locks_and_leases` | `pog` | `gleam_httpc` |
| `contracts` | TypeSpec + JSON Schema authorities (ores-contracts) | | |
| `conformance` | the corpus every slice is tested against | | |

## The routines

Every slice exposes the same three, named for the Postgres scope they use:

- **`with_xact_lock`** — fiducia lease (optional) around `pg_advisory_xact_lock`
  inside a transaction the routine opens and commits. `work` receives the
  transaction and the fencing token. The default.
- **`with_session_lock`** — fiducia lease (optional) around `pg_advisory_lock`
  / `pg_advisory_unlock` on one dedicated connection. **No transaction** —
  for DDL, batch jobs that commit as they go, or work that touches no
  database but wants a database-enforced mutex.
- **`with_lease`** — fiducia only, no database layer.

Each takes `LockLayers { fiducia, pg_advisory }` so a call site can run with
both, either, or neither (`neither` is a pass-through for tests and
single-writer development), and `wait` to choose blocking or fail-fast
acquisition.

### Rust

```rust
use ores_locks_and_leases::{
    AcquireOptions, LockKey, LockLayers, fiducia::FiduciaLease, with_xact_lock,
};

let key = LockKey::new("zed-pkg/registry/publish:zed-lib-core")?;
let lease = FiduciaLease::internal("http://fiducia-node.fiducia.svc:8090", &secret, &org_id);

let published = with_xact_lock(
    &key,
    LockLayers::BOTH,
    true,                       // wait for the lock; false fails fast with `contention`
    &AcquireOptions::default(), // 60s lease, 30s wait budget, 250ms poll
    Some(&lease),
    Some(&db),                  // sea_orm::DatabaseConnection
    |g| Box::pin(async move {
        let txn = g.txn.expect("pg layer is on");
        let token = g.fencing_token().expect("fiducia layer is on");
        publish_version(txn, token).await   // guarded writes record `token`
    }),
).await?;
```

### Go

```go
err := oreslocks.WithXactLock(ctx, key, oreslocks.LayersBoth, true, oreslocks.DefaultAcquireOptions(), lease, db,
    func(ctx context.Context, g oreslocks.XactGuarded) error {
        token, _ := g.FencingToken()
        _, err := g.Tx.ExecContext(ctx, "UPDATE … WHERE fencing_token < $1", token)
        return err
    })
```

### TypeScript

```ts
await withXactLock(key, LAYERS_BOTH, true, DEFAULT_ACQUIRE_OPTIONS, lease, pool, async (g) => {
  await g.client!.query("UPDATE … WHERE fencing_token < $1", [g.grant!.fencingToken.toString()]);
});
```

### Dart

```dart
await withXactLock(key, layers: LockLayers.both, wait: true, lease: lease, db: pool, work: (g) async {
  await g.tx!.execute(Sql.named('UPDATE … WHERE fencing_token < @t'), parameters: {'t': g.fencingToken!.toInt()});
});
```

### Gleam

```gleam
pg.with_xact_lock(key, locks.layers_both, True, locks.default_acquire_options(), Some(lease), Some(db), fn(g) {
  // g.conn is inside the transaction; g.grant carries the fencing token
  Ok(Nil)
})
```

## Keys

`<org>/<domain>/<name>` — `advisory_key(key)` is FNV-1a 64 over the UTF-8
bytes, reinterpreted as a signed `bigint`; identical in every slice and
pinned by `conformance/cases/advisory-key.json`. Each `*-lib-core` wraps the
routines with its org prefix so orgs sharing a database cannot collide.

## Failure kinds

`contention`, `timeout`, `lost_lease`, `transport`, `database`, `work`,
`invalid_plan` — one structured error in every slice, always naming the step
that failed. `transport` is never treated as "not held". Details, and why the
layers are ordered the way they are, in [`docs/design.md`](docs/design.md).

## Contracts and conformance

`contracts/typespec/main.tsp` and `contracts/json-schema/contract.schema.json`
are independent authorities checked for parity by
[`ORESoftware/ores-contracts`](https://github.com/ORESoftware/ores-contracts)
(`npx ores-contracts check --config contracts/contracts.config.json`).
`conformance/cases/` is what the slices' tests read; adding a case there
fails every slice that disagrees.

## Testing

`sh scripts/test-all.sh` runs every slice the local toolchain can run. Live
Postgres checks (Rust `tests/live_postgres.rs`) run when
`ORES_LOCKS_TEST_DATABASE_URL` is set.
