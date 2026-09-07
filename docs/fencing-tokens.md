# Fencing-token design

## Threat model

A lease limits how long a coordinator considers a holder authoritative. It
cannot stop a process that pauses before expiry and resumes after another
holder has acquired the same key. Mutual exclusion can therefore be violated
from the application's point of view even when the lease service is correct:

```text
holder A gets token 41 ─ pauses ─ lease expires
holder B gets token 42 ─ writes new state
holder A resumes ─────── must be rejected by the datastore
```

The datastore rejects A by remembering the greatest accepted token for the
protected resource and allowing only a strictly greater token to advance that
watermark. Equal tokens are handled as idempotency retries, not as fresh
authority.

## One identity, one watermark

A watermark is scoped by:

```text
(tenantScope, resourceKey)
```

`resourceKey` should normally be the same canonical `<org>/<domain>/<name>`
used to acquire the Fiducia lease. `tenantScope` is a second partition key for
shared databases and RLS-aware products. Both values are compared on every
request; a persisted watermark may never be reused for a different identity.

The stored row also contains:

- `fencingToken`: canonical unsigned-64 decimal text on the wire and
  `NUMERIC(20,0)` in PostgreSQL;
- `operationId`: caller-generated idempotency key;
- `payloadSha256`: lowercase SHA-256 of a canonical serialization of the
  mutation;
- optional `holder` and `leaseId` diagnostics.

## Decision state machine

Given an incoming request and the current watermark:

```text
no current watermark                 -> advanced
incoming token > current token       -> advanced
incoming token < current token       -> stale
equal token + same op + same payload -> replay
equal token + different op/payload   -> token_reuse
```

Only `advanced` may mutate protected state. `replay` is a successful no-op.
`stale` and `token_reuse` are rejected. Equal-token reuse is distinguished
from a stale token because it usually indicates a programming error, a broken
idempotency-key boundary, or token corruption.

This contract intentionally admits one canonical mutation identity per
`(resource, fencing token)`. If one lease protects several SQL statements,
treat them as one transaction payload and one operation id. Independent
mutations should use distinct resource keys or fresh grants. Idempotency that
must survive reacquiring a newer token belongs in the product's durable
idempotency/outbox table; the fencing watermark is not a replacement for that
longer-lived business invariant.

## Atomicity rule

The compare, watermark advance, and protected mutation are one atomic unit:

- PostgreSQL: one transaction on the same physical database;
- Redis: one script/function touching keys in the same cluster slot;
- another datastore: its own compare-and-swap primitive.

A preflight check followed by a later write is not fencing. Neither is storing
the watermark in Redis and then writing PostgreSQL. A crash or competing
writer can enter between those operations.

For data duplicated across Supabase, Neon, and Redis, each physical store
maintains its own watermark. An outbox event carries the token and idempotency
identity to downstream projections, which independently fence the event.

## Full-width token representation

Fiducia tokens are `uint64`, whose maximum is:

```text
18446744073709551615
```

Representation rules:

| boundary | representation |
| --- | --- |
| JSON / TypeSpec / JSON Schema wire contract | canonical decimal string |
| Rust | `u64` internally, `FencingTokenText` at boundaries |
| Go | `uint64` internally, `FencingTokenText` at boundaries |
| TypeScript | `bigint` internally, branded decimal string at boundaries |
| Dart / Flutter | `BigInt` internally, decimal string at boundaries |
| Gleam / BEAM | arbitrary-precision `Int` internally, decimal string at boundaries |
| PostgreSQL | `NUMERIC(20,0)` with unsigned-range check |
| Redis | decimal string compared without `tonumber` |

A canonical string is `0` or a non-zero digit followed by decimal digits, with
no sign, whitespace, fractional part, or leading zeroes, and its numeric value
must not exceed the unsigned-64 maximum.

## Payload digest

`payloadSha256` is the digest of a canonical representation, not whatever byte
sequence happened to arrive from a client. Products should use their existing
JCS/canonical-JSON contract tooling before hashing. Otherwise semantically
identical maps with different property order could be mistaken for token
reuse.

The digest is an idempotency guard, not an authentication mechanism. Requests
still require Shared-Auth authorization, tenant isolation, and normal input
validation.

## Failure handling

- Stop producing effects immediately after lease renewal fails.
- A datastore `stale` or `token_reuse` response is authoritative even if the
  caller still believes it owns the lease.
- Do not retry `token_reuse` with the same token. Acquire a new grant only
  after investigating why one token was associated with two mutations.
- Retrying an uncertain network response is safe with the same token,
  operation id, and digest: it returns `replay` if the first attempt committed.
- Do not delete watermarks merely because the protected business row was
  deleted. Recreating the same resource identity must not allow an old holder
  to write. Archive or tombstone watermarks according to a retention policy
  that exceeds every possible delayed-work window.

## Generated consumers

`templates/lib-core/gen_org_locks.py` creates the org-prefixed lock package.
`templates/lib-core/gen_org_fencing.py` adds the datastore migrations,
deployment notes, and conformance fixture. The fanout script runs both, so
every generated `*-lib-core` gets the same application-side fencing boundary
alongside its Rust, TypeScript, Dart, Gleam, and Go wrappers.
