# Durable Objects and external side effects

Cloudflare Durable Objects are a strong lease authority, but their safety boundary ends at the Durable Object's own transactional storage.

Cloudflare documents that a stale Durable Object incarnation can discover it is no longer current when it accesses its durable storage. Cloudflare also documents that non-storage I/O such as `fetch()` can interleave and that external calls need application-level coordination. Therefore ORE treats Durable Object storage and external systems as two different authority boundaries.

## Inside the Durable Object storage boundary

`managed/cloudflare-do` persists `next_token` in the Durable Object's SQLite storage and advances it in the same `transactionSync()` operation that installs the lease. A replacement in-memory object therefore resumes from the durable high-watermark instead of resetting a process-local counter.

For operations that only mutate the same Durable Object storage, callers do not need a second application-side fence merely to protect that storage transaction. Cloudflare's storage engine provides the local serialization and stale-instance detection.

That statement does **not** mean the lease grant may omit a fencing token. Every successful distributed grant still returns one because the caller may cross the Durable Object boundary later in the same workflow.

## Outside the boundary

Any effect outside the Durable Object's own storage must carry independent replay/staleness protection.

### Fence-aware datastore

For PostgreSQL, Neon, Supabase/Postgres, Redis/Valkey, or another datastore that can perform an atomic compare-and-set, pass the grant's fencing token with the mutation and persist the greatest accepted token for the protected resource.

The decision contract is:

```text
incoming token > watermark              -> advance watermark + mutate
incoming token < watermark              -> reject stale writer
same token + same operation + same body -> successful replay / no-op
same token + different operation/body   -> reject token reuse
```

The compare, watermark advance, and mutation must be one atomic datastore operation. A preflight token check followed by a separate write is not fencing.

### API without fencing support

For APIs such as payment processors or arbitrary HTTP services that cannot reject an older numeric fence, use a durable idempotency key / operation id generated before the external call. Reuse exactly that key when retrying an uncertain response.

If the external service supports both an idempotency key and conditional versioning, use both: the fencing token proves authority ordering; the idempotency key deduplicates retries of the same authorized operation.

Do not invent a fresh idempotency key after a timeout. That converts an uncertain retry into a second operation.

## Required propagation

A lock/lease wrapper must not hide authority metadata from the work callback. The callback needs at least:

- canonical resource key;
- holder / lease identity when available;
- fencing token;
- operation/idempotency identity for an external effect.

Adapters for Fiducia, Cloudflare Durable Objects, Redis/Valkey, and live-mutex should all expose the same fencing-token concept so callers do not weaken correctness when switching providers.

## Zombie-writer scenario

```text
A gets fence 41
A pauses before external POST/SQL write
lease expires
B gets fence 42
B writes with fence 42
A resumes
```

For a fence-aware datastore, A's write with `41` is rejected because `42` is already the watermark. For a non-fence-aware API, both calls must carry stable operation identities so retries are deduplicated according to that API's contract.

The executable TypeScript test `src/ts/test/cloudflare-do-external-fencing.test.mjs` covers both durable token continuity across Durable Object incarnation replacement and stale downstream rejection.

## References

- Cloudflare Durable Objects known issues: global uniqueness is revalidated when starting events and accessing storage; an old event that never accesses storage may not discover that it is stale.
- Cloudflare Durable Objects rules: non-storage I/O such as `fetch()` is outside storage input-gate protection and needs explicit race handling.
