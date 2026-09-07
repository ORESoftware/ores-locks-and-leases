# Application-side fencing

Fiducia grants a monotonically increasing token, but the grant alone cannot
stop a paused holder from resuming after its lease expires. The datastore that
owns the protected state must reject that stale holder.

This directory supplies two atomic adapters with one decision contract:

| decision | meaning | mutate protected state? |
| --- | --- | --- |
| `advanced` | no watermark exists, or the incoming token is larger | yes, exactly once |
| `replay` | equal token, operation id, and payload SHA-256 | no |
| `stale` | incoming token is smaller | no |
| `token_reuse` | equal token with a different operation id or payload | no |

Tokens cross JSON, SQL, and Redis boundaries as canonical unsigned-64 decimal
strings. They may be native `u64`/`uint64`/`bigint`/`BigInt` only inside a
runtime. Never use JavaScript `number`, Dart `num`, Redis Lua `tonumber`, or a
PostgreSQL signed `bigint` for a full-width Fiducia token.

One resource/token pair carries one canonical operation id and payload digest.
Group all statements protected by that grant into one atomic mutation. Use a
separate durable product idempotency key when retries must remain no-ops after
acquiring a newer token.

## PostgreSQL: Supabase and Neon

`postgres/fencing.sql` installs one watermark table and
`ores_locks.try_advance_fence`. Supabase and Neon are separate PostgreSQL
systems; install the migration in **each physical database that stores guarded
state**. A fence accepted in one database does not authorize a write in the
other.

The call, watermark advance, and business mutation must be one transaction:

```sql
BEGIN;

WITH fence AS MATERIALIZED (
  SELECT *
  FROM ores_locks.try_advance_fence(
    'tenant/acme',
    'my-org/order/123',
    '18446744073709551615',
    'checkout-request-9f2c',
    '6f1ed002ab5595859014ebf0951522d9a0f1db7a81d5e10e4b3397f14a4d4117',
    'api-pod-7',
    'fiducia-lease-456'
  )
), applied AS (
  UPDATE app.orders AS orders
  SET status = 'paid',
      last_fencing_token = fence.current_token::numeric
  FROM fence
  WHERE fence.should_apply
    AND orders.tenant_id = 'acme'
    AND orders.id = 123
  RETURNING 1
)
SELECT fence.*, EXISTS (SELECT 1 FROM applied) AS mutation_applied
FROM fence;

COMMIT;
```

The table uses `NUMERIC(20,0)`, not `BIGINT`: PostgreSQL `BIGINT` is signed and
cannot represent values above `9223372036854775807`, while Fiducia tokens are
unsigned 64-bit. The migration creates a dedicated schema, revokes access from
`PUBLIC`, and grants nothing to Supabase `anon` or `authenticated`. Product
infrastructure must grant only its backend API/worker role the required schema,
table, and function privileges. Do not expose this function directly to
untrusted clients through PostgREST.

For a transaction-scoped advisory lock, invoke the function through the same
SeaORM/SQL transaction passed to guarded work. For a session-scoped lock, open
an explicit business transaction around the fence and mutation when the
protected state is PostgreSQL-backed; a session mutex by itself does not make
the watermark update and business write atomic.

## Redis

`redis/fenced-write.lua` atomically compares the watermark and `SET`s one
Redis-resident value. The watermark key and state key must share one non-empty
Redis Cluster hash tag:

```text
my-org:{tenant/acme:order/123}:fence
my-org:{tenant/acme:order/123}:state
```

Invoke it with two keys and the token, operation id, payload digest, serialized
value, optional holder, and optional lease id. The script compares decimal
strings by length and lexicographic order; it never calls `tonumber`.

Redis can fence a mutation whose source of truth is Redis. It must **not** be
the sole fence for a later PostgreSQL write: a crash between Redis acceptance
and the database mutation recreates the stale-writer window. PostgreSQL state
must use the PostgreSQL adapter in the same database transaction.

## Multi-database writes

There is no atomic transaction spanning Supabase, Neon, and Redis here.
Use an outbox/saga:

1. fence and commit the authoritative mutation in its owning database;
2. write an outbox event in that same transaction, carrying the token,
   operation id, and payload digest;
3. each downstream datastore independently fences its own projection before
   applying the event.

That gives every physical store a local monotonic watermark and makes retries
idempotent without pretending the stores share a transaction.
