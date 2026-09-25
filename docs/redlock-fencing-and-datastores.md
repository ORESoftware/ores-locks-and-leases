# Redlock, fencing tokens, and datastore writes

Redlock and fencing solve different failure modes and should remain separate in the architecture.

## Safety model

A Redlock grant is a TTL-bounded quorum lease. It does not inherently provide a monotonically increasing fencing token. A client can pause long enough for its Redlock lease to lapse, another client can acquire the resource, and the old client can later resume. Protected datastores therefore still need a monotonically increasing fencing token and must reject stale tokens.

`FencedRedlockLease` uses this ordering:

```text
Redlock quorum acquire
        |
        v
strong fencing authority: next_fencing_token(key)
        |
        v
guarded work receives one immutable token N
        |
        +--> Supabase transaction checks/advances N then writes
        +--> Neon transaction checks/advances N then writes
        +--> Redis script checks/advances N then writes
        |
        v
Redlock release
```

If fencing-token allocation fails, the adapter best-effort releases the Redlock handle and returns no grant. Guarded work must not begin.

Renewal extends the Redlock TTL but **never** changes the fencing token. A new token is minted only for a new acquisition.

## Token authority

`persistence/postgres/token-authority.sql` installs `ores_locks.next_fencing_token(tenant_scope, resource_key)`. It uses a row-level PostgreSQL UPSERT to allocate full-width unsigned-64 epochs represented as decimal text.

It can be installed in Supabase, Neon, or ordinary PostgreSQL. Treat the database containing this counter as an authority: its failover/durability configuration must preserve committed increments. Do not replace it with a process-local counter, a timestamp, the random Redlock lock value, or independent `INCR` calls on each Redlock member.

A Cloudflare Durable Object or Fiducia can also provide the monotonic token source, provided the adapter exposes the same strictly-increasing-per-key contract.

## Supabase and Neon writes

Both are PostgreSQL, but a token accepted in one database does not authorize a write in the other. Install `persistence/postgres/fencing.sql` in every physical database that stores protected state.

For a Neon/direct-Postgres transaction:

```sql
BEGIN;

SELECT *
FROM ores_locks.try_advance_fence(
  'tenant/acme',
  'invoice/123',
  '42',
  'op-7b9e',
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  'worker-a',
  'redlock:invoice/123'
);

-- Apply the business mutation only when should_apply = true.
UPDATE app.invoices
SET status = 'paid'
WHERE tenant_id = 'acme' AND id = '123';

COMMIT;
```

The fence check and mutation must execute in the **same transaction**. Do not perform the fence check through one connection and the business write through another.

For Supabase clients, prefer a server-side RPC function that calls `ores_locks.try_advance_fence(...)` and performs the business mutation in the same PL/pgSQL function/transaction. Do not make two client-side RPC calls (`check fence`, then `update`) because another transaction can interleave between them.

Keep `ores_locks` backend-only. The migration revokes access from `PUBLIC`; grant `EXECUTE` and table privileges only to the trusted API/Worker role that performs guarded writes, not `anon` or ordinary `authenticated` clients.

## Redis protected state

`persistence/redis/fenced-write.lua` is the equivalent store-local barrier for Redis-resident data. Pass the same fencing token obtained after Redlock acquisition. Redlock's random ownership value is still used to release/extend the Redlock lease; the fencing token is a separate monotonic epoch used by downstream state.

## Recommended authority order

For the ORESoftware fleet:

1. Cloudflare Durable Objects remain a strong low-ops authority where one object ID naturally maps to one lock key.
2. Fiducia is the consensus-backed authority when the product specifically needs its Raft/failover semantics.
3. Redis/Valkey single-authority Lua is useful for managed Redis deployments.
4. Redlock is optional for deployments that explicitly want a Redis quorum; pair it with an independent fencing-token authority as described above.
5. Local filesystem locks remain single-host coordination only and must not be promoted to a multi-host authority.
