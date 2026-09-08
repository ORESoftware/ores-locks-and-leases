# Supervised lease renewal

A Fiducia lease proves temporary ownership. Long-running work must not assume
that the grant remains live until the callback happens to return.

The renewal supervisor provides one deterministic lifecycle across Rust,
TypeScript/Node.js, Go, Dart/Flutter, and Gleam:

1. Start with the exact acquired grant, a process-local monotonic clock, and a
   validated renewal policy.
2. Schedule the next checkpoint at the earlier of the preferred interval or
   the configured safety margin before the local TTL deadline.
3. Before every authoritative commit, call `checkpoint` (or the pure
   `decision`/`accept_renewal` pair).
4. A successful renewal must preserve the lock key, holder, and full-width
   fencing token. Once the authority reports an absolute deadline, later
   renewals must continue reporting a strictly greater deadline.
5. Refusal, transport ambiguity, identity drift, token drift, malformed or
   regressing deadlines, local expiry, clock regression, or a renewal response
   completing at the old deadline permanently marks the supervisor lost.
6. A lost supervisor is sticky. It will not call the authority again and can
   never re-enable protected effects.

## The commit rule

A checkpoint is cooperative cancellation, not write authority. It cannot undo
an email, payment, file upload, or other effect already sent by stale work. The
protected mutation must still atomically admit the Fiducia fencing token in its
own datastore.

```text
checkpoint live
    |
    v
BEGIN
  SELECT watermark FOR UPDATE
  reject token < watermark
  compare-and-advance token + exact operation identity
  apply protected mutation
COMMIT
```

For the built-in PostgreSQL/Supabase/Neon and Redis fencing adapters, use the
same grant token that the supervisor retains. Redis never authorizes a later
PostgreSQL write; each datastore independently fences the state it owns.

## Clock model

Scheduling uses process-local monotonic milliseconds, not `Date.now()` or a
wall clock. The logical-clock domain is `0..=9007199254740991`; TTL is
additionally capped at `9223372036854` ms so every supported runtime duration
type can represent it without overflow. Thus every runtime, including browser
JavaScript, represents values exactly. Authority-provided `leaseExpiresMs`
remains absolute metadata: the supervisor checks continuity and strict
advancement, but does not compare it to the process-relative clock.

## JavaScript authority snapshots

TypeScript `readonly` annotations disappear at runtime. The TypeScript
supervisor therefore snapshots both the grant and renewal policy into frozen,
closed objects before retaining them. Required fields must be own data
properties; inherited fields, accessors, unknown fields, arrays, malformed
proxies, and explicit `undefined` deadlines are rejected without invoking
caller getters or coercion hooks. The frozen grant is also the value handed to
the renewal adapter, so the adapter cannot rewrite the token, holder, or key
that its response is compared against.

This runtime defense mirrors the renewal contract's
`unevaluatedProperties: false` boundary. It is not a replacement for validating
wire JSON before constructing a grant.

## Release after loss

Release is best-effort cleanup. A successful release after a terminal renewal
failure does not restore ownership and must not make the supervisor live again.
Correctness comes from expiry plus datastore fencing, not from release success.

## Policy sizing

Both `renewEvery` and `safetyMargin` must be positive and strictly less than the
active TTL. Choose a margin larger than expected transport, leader-election,
and scheduling jitter. A renewal that completes at or after the previous local
deadline is rejected even if the remote response says it renewed.
