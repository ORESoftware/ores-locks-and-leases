# Formal review procedure: leases, fencing, and maintained commits

Canonical repository instructions: <https://github.com/ORESoftware/my-ai/blob/main/AGENTS.md>.

## Lease and fencing boundary

`formal/model.mjs` is a dependency-free, finite exhaustive model of one logical
lock key, two competing clients, lease expiry, renewal, explicit release,
process crash, fencing-token minting, and a fenced protected resource. It is an
independent oracle for the Rust, TypeScript, Dart, Go, Gleam, PostgreSQL, and
Redis implementations; it does not import production code.

The model checks every reachable state within the bounds recorded in
`formal/fm.toml`. It also executes explicit witnesses for crash-before-expiry,
successor acquisition, stale-leader rejection, exact replay, and ambiguous
same-token reuse.

### Required lease and fencing properties

1. A live authority grant is exclusive.
2. Every successful acquisition mints a strictly newer fencing token.
3. Renewal preserves the current token and holder.
4. A process crash is not an implicit release.
5. Persisted fencing tokens never regress.
6. A stale holder cannot overwrite a newer holder's work.
7. An exact retry is idempotent; same-token/different-payload reuse fails closed.
8. Rejected writes leave the protected resource unchanged.

## Maintained transaction commit admission

`formal/maintained-model.mjs` is a second independent finite model for the
opt-in Fiducia-plus-PostgreSQL maintained transaction path. It enumerates
acquisition, transaction begin, bounded try-lock contention, periodic renewal,
work completion/failure, mandatory final renewal, commit, rollback, release,
and cleanup-failure precedence.

The reviewed bound permits up to two successful periodic renewals and two
advisory-lock contention retries. Within that bound the model explores 878
states, 889 transitions, and 568 terminal outcomes. The normal model must prove:

1. Commit requires successful acquire, begin, advisory lock, and work.
2. Commit requires a successful final same-token renewal.
3. Renewal failure or token drift prevents commit and leads to rollback when a
   transaction is open.
4. Commit and rollback are mutually exclusive.
5. Every acquired terminal path attempts release exactly once; failed
   acquisition never releases a grant it did not receive.
6. Rollback and release cleanup failures become primary while retaining the
   earlier guarded-operation failure.
7. Terminal states have no outgoing transition and cannot become live again.
8. A successful return requires both commit and successful release.

The model includes a negative control that deliberately removes final renewal.
It must then produce an unsafe successful trace:

```text
acquire.success
pg.begin.success
pg.lock.success
work.success
pg.commit.success
fiducia.release.success
```

If that witness disappears, the model is no longer demonstrating that final
renewal is a real safety obligation and the review must stop.

## Refinement obligation

A change to lock acquisition, renewal, release, TTL handling, fencing checks,
maintained transaction admission, PostgreSQL or Redis guarded writes, or the
TypeSpec/JSON Schema contract must keep the applicable models green and retain
native implementation and persistence integration tests. Cross-language
fencing adapters should replay JSON-lines action traces through
`node formal/model.mjs --json-stdin` and compare accepted/rejected outcomes
plus final state.

The maintained model is an abstraction of common control flow, not a claim that
all five runtime implementations are textually identical. Native Rust live-
PostgreSQL, Go, TypeScript, Dart, and Gleam tests remain the refinement evidence.

## Bounds and nonclaims

The proofs are exhaustive only for their declared finite bounds. They do not
prove transport liveness, real-time clock accuracy, cryptographic identity,
provider availability, arbitrary integer overflow behavior, or that an
external side effect can be undone. The final renewal completes immediately
before the PostgreSQL commit call in the abstraction; protected mutations must
still atomically admit the unchanged fencing token in the datastore that owns
them. Authority deadline continuity is provided by the separate renewal
supervisor when callers require that stronger metadata guarantee.

Increasing a bound must not weaken an invariant or delete a
counterexample-producing trace.

## Commands

```sh
node formal/model.mjs
printf '%s\n' '{"actions":[{"kind":"acquire","client":"a"},{"kind":"write","client":"a","value":1}]}' \
  | node formal/model.mjs --json-stdin

node formal/maintained-model.mjs \
  --receipt target/formal-maintained/receipt.json
```
