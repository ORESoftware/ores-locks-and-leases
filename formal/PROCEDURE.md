# Formal review procedure: leases and fencing

Canonical repository instructions: <https://github.com/ORESoftware/my-ai/blob/main/AGENTS.md>.

## Boundary

`formal/model.mjs` is a dependency-free, finite exhaustive model of one logical
lock key, two competing clients, lease expiry, renewal, explicit release,
process crash, fencing-token minting, and a fenced protected resource. It is an
independent oracle for the Rust, TypeScript, Dart, Go, Gleam, PostgreSQL, and
Redis implementations; it does not import production code.

The model checks every reachable state within the bounds recorded in
`formal/fm.toml`. It also executes explicit witnesses for crash-before-expiry,
successor acquisition, stale-leader rejection, exact replay, and ambiguous
same-token reuse.

## Required safety properties

1. A live authority grant is exclusive.
2. Every successful acquisition mints a strictly newer fencing token.
3. Renewal preserves the current token and holder.
4. A process crash is not an implicit release.
5. Persisted fencing tokens never regress.
6. A stale holder cannot overwrite a newer holder's work.
7. An exact retry is idempotent; same-token/different-payload reuse fails closed.
8. Rejected writes leave the protected resource unchanged.

## Refinement obligation

A change to lock acquisition, renewal, release, TTL handling, fencing checks,
PostgreSQL or Redis guarded writes, or the TypeSpec/JSON Schema contract must
keep this model green and must retain native implementation and persistence
integration tests. Cross-language adapters should replay JSON-lines action
traces through `node formal/model.mjs --json-stdin` and compare accepted/rejected
outcomes plus final state.

## Bounds and nonclaims

The proof is exhaustive only for the finite bounds in `fm.toml`. It does not
prove transport liveness, real-time clock accuracy, cryptographic identity,
provider availability, or arbitrary integer overflow behavior. Those remain
implementation, integration, and operational obligations. Increasing a bound
must not weaken an invariant or delete a counterexample-producing trace.

## Commands

```sh
node formal/model.mjs
printf '%s\n' '{"actions":[{"kind":"acquire","client":"a"},{"kind":"write","client":"a","value":1}]}' \
  | node formal/model.mjs --json-stdin
```
