# Fencing and lock-plan formal model

This crate imports the production Rust `fence.rs`, `key.rs`, and `plan.rs`
modules directly.

## Symbolic proofs

Kani 0.67.0 checks:

- the complete `u64` current/incoming token domain and both operation/payload
  identity bits partition exactly into `advanced`, `replay`, `stale`, and
  `token_reuse`;
- `should_apply`, current watermark, and previous watermark agree with that
  partition;
- cross-resource identity mismatch always fails closed;
- every symbolic lock-layer/scope/wait combination contains exactly one work
  step and preserves the required Fiducia and PostgreSQL ordering.

The symbolic fencing harness uses the public canonical `from_u64` constructor,
so token serialization and numeric value remain coupled to production code.

## Concurrent bounded model

The normal Rust test exhaustively explores two holders, token generations 0–2,
two operation/payload identities, absent and pre-existing watermarks, crashes
before and after the atomic boundary, retries, and every actor interleaving.
It proves watermark monotonicity, at most one application per token generation,
no mutation on replay/stale/token-reuse, and crash-free completion from every
reachable state. A negative control witnesses the regression produced by using
a cached pre-transaction classification instead of recomputing inside the
atomic compare-and-advance operation.

## Refinement boundary

The model assumes PostgreSQL or Redis performs classification, watermark
advance, and protected mutation atomically. Live database/script tests remain
required. It does not prove Fiducia availability, network delivery, or a
consumer datastore that fails to install its own watermark.
