# `live-mutex` integration

`ORESoftware/live-mutex` already ships the two clients this project needs:

- the canonical Node/TypeScript client in `src/client.ts`;
- the portable Rust NDJSON/TCP client in `clients/rust/src/lib.rs`.

Both surface broker-minted fencing tokens on successful grants. Do not create a second Node package or a second Rust wire client in this repository; keep the wire protocol implementation in `live-mutex` and adapt it here only after it satisfies the renewable `Lease` contract.

## Current compatibility status

`ores-locks-and-leases::Lease` requires three operations:

```text
acquire(key, ttl) -> grant(token, expiry)
renew(grant, ttl) -> same token, later expiry
release(grant)
```

The current `live-mutex` portable clients cover acquire/release (plus acquire-many/release-many) but do not expose a first-class renewal verb. Therefore `live-mutex` should currently be treated as a mutex authority, not substituted for the renewable `Lease` seam used by long-running guarded work.

A correct renewal addition must:

1. identify the exact holder UUID plus key;
2. fail if the holder was already TTL-evicted or transferred;
3. move the existing deadline without minting a new fencing token;
4. return the unchanged fencing token plus the new expiry;
5. never reacquire on renewal failure;
6. have Node and Rust client parity plus stale-holder tests.

## Fencing durability gate

The current Node broker keeps each key's fencing counter in process memory and seeds a new key from `Date.now()`. That gives strictly increasing tokens while one broker process and one `LockObj` live, but it is not a durable cross-restart epoch authority: a sufficiently rewound wall clock can allow a restarted broker to issue a token below an earlier process's token.

Until that is fixed, a `live-mutex` token must not be presented as equivalent to the persisted Fiducia, Durable Object, PostgreSQL, or Redis fencing authorities used by `ores-locks-and-leases` for durable stale-writer rejection.

Promotion options, in preferred order:

1. Persist the per-key epoch/counter durably and restore it before admitting lock traffic.
2. Mint the fence from a separate strong authority (for example the PostgreSQL `ores_locks.next_fencing_token` function in this repository) after `live-mutex` acquisition.
3. If the deployment is intentionally process-local/ephemeral, document that its token is only broker-incarnation monotonic and do not use it as the sole stale-writer barrier for durable external state.

A wall clock, random UUID, PID, or lock-request count is not a substitute for a durable monotonic epoch.

## Protocol parity gate

The Rust client must advertise the same supported protocol version as the broker package (or protocol negotiation must explicitly support a compatible version range). Keep the version handshake in conformance tests so an older portable client cannot appear healthy while the broker rejects it at connect time.

## Conformance scenarios before adding an adapter here

A future `LiveMutexLease` adapter should not merge until the upstream broker plus Node and Rust clients prove all of these:

- acquire A -> token N;
- renew A -> token still N and expiry increases;
- A expires -> B acquires -> token > N;
- stale A cannot renew B's grant;
- stale A cannot release B's grant;
- restart cannot regress the next token;
- lost connection during renew is treated as unknown/lost authority, never success;
- acquire-many retains independent monotonic fencing tokens per member key;
- Node and Rust clients pass the same wire fixtures.

Those are intentionally aligned with the stronger Fiducia stale-fencing test-org scenarios rather than inventing a weaker `live-mutex`-specific standard.
