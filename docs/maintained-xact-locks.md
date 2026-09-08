# Maintained Fiducia + PostgreSQL transaction locks

The maintained transaction APIs are for database work that can approach or
exceed the initial Fiducia lease TTL. They compose one cross-host lease with
one PostgreSQL transaction-scoped advisory lock and make lease renewal part of
commit admission.

```text
validate
  -> fiducia.acquire
  -> pg.begin
  -> poll pg_try_advisory_xact_lock
       \-> fiducia.renew as needed
  -> work inside the supplied transaction
       \-> fiducia.renew as needed
  -> stop the maintainer
  -> fiducia.renew       # mandatory final admission check
  -> pg.commit
  -> fiducia.release
```

Any failure before `pg.commit` follows the failure path:

```text
failure -> pg.rollback -> fiducia.release -> return the strongest error
```

A release or rollback failure is not hidden. Cleanup uncertainty takes
precedence and includes the earlier acquisition/work/renewal failure as
provenance.

## Invariants

A successful return proves all of the following:

1. the caller acquired a Fiducia grant before opening the protected PostgreSQL
   transaction;
2. the transaction acquired the advisory key derived from the same lock key;
3. every successful renewal returned the same key, holder, and fencing token;
4. one renewal succeeded after user work completed and immediately before
   commit was attempted;
5. PostgreSQL accepted the commit; and
6. Fiducia accepted the release.

A successful return does **not** prove that an arbitrary external side effect
was transactional. Publish messages, invoke remote APIs, and write object
storage through a transactional outbox or another fencing/idempotency boundary.

## Timing

`renewIntervalMs` must be a positive integer and no greater than half of the
lease `ttlMs`. This is a fail-closed configuration check performed before
Fiducia or PostgreSQL is touched.

The default is:

```text
ttlMs             = 60000
renewIntervalMs   = 20000
waitTimeoutMs     = 30000
retryIntervalMs   = 250
```

The interval is a maximum intended cadence, not a real-time guarantee. Runtime
scheduling, transport latency, stop-the-world pauses, or process suspension can
still consume the safety margin. Protected writes therefore also carry the
Fiducia fencing token and advance a datastore-local watermark atomically with
the mutation.

## PostgreSQL contention

The maintained path does not call the blocking
`pg_advisory_xact_lock` function. It polls
`pg_try_advisory_xact_lock` within the configured wait budget so a failed
Fiducia renewal can interrupt contention promptly.

PostgreSQL transaction advisory locks are reentrant within one session. Keep
one maintained routine responsible for a key/transaction boundary rather than
nesting unrelated abstractions around the same connection.

## Cancellation

Renewal loss is always commit-blocking. Runtime cancellation is additionally
provided so cooperative work can stop early:

| Runtime | Cancellation behavior |
| --- | --- |
| Rust | the pending work future is dropped before rollback |
| Go | the work `context.Context` is canceled with the renewal error as its cause |
| TypeScript | `guarded.signal` is aborted with the renewal error |
| Dart | `guarded.signal.whenCancelled` completes with the renewal error |
| Gleam | work receives an explicit maintenance checkpoint; final renewal still gates commit |

Code that ignores a cooperative signal may continue computing until its work
function returns, but it cannot make this routine commit after renewal loss.
All protected SQL must use the transaction/session supplied by the guard.

## Rust

```rust,ignore
let value = with_maintained_xact_lock(
    &key,
    true,
    &AcquireOptions::default(),
    &LeaseMaintenanceOptions::default(),
    &fiducia,
    &database,
    |guarded| Box::pin(async move {
        let txn = guarded.txn.expect("maintained transaction");
        // Execute the protected SQL through `txn` and carry
        // `guarded.fencing_token()` into the atomic fenced mutation.
        Ok::<_, sea_orm::DbErr>(42)
    }),
).await?;
```

## Go

```go
err := oreslocks.WithMaintainedXactLock(
    ctx,
    key,
    true,
    oreslocks.DefaultAcquireOptions(),
    oreslocks.DefaultLeaseMaintenanceOptions(),
    fiducia,
    db,
    func(workCtx context.Context, guarded oreslocks.MaintainedXactGuarded) error {
        // Use guarded.Tx; observe workCtx.Done() during long operations.
        return nil
    },
)
```

## TypeScript

```ts
await withMaintainedXactLock(
  key,
  true,
  DEFAULT_ACQUIRE_OPTIONS,
  DEFAULT_LEASE_MAINTENANCE_OPTIONS,
  fiducia,
  pool,
  async ({ client, grant, signal }) => {
    signal.throwIfAborted();
    // Use client for protected SQL and grant.fencingToken for the fence.
  },
);
```

## Dart

```dart
await withMaintainedXactLock(
  key,
  wait: true,
  acquire: const AcquireOptions(),
  maintenance: const LeaseMaintenanceOptions(),
  lease: fiducia,
  db: pool,
  work: (guarded) async {
    // Use guarded.tx and race long work with guarded.signal.whenCancelled.
  },
);
```

## Legacy transaction routine

`with_xact_lock` remains available and source-compatible. It does not maintain
the outer lease and therefore belongs only on short, tightly bounded code paths
whose maximum transaction duration is comfortably below the TTL. New
long-running mutation paths should use the maintained API.
