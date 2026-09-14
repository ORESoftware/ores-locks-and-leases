# Managed lease authorities

`Lease` is the production seam. The library deliberately separates an **outer,
fenced lease authority** from an optional **inner PostgreSQL advisory lock**.
The supported first-class outer authorities are:

1. **fiducia-cloud**, through the official Fiducia clients;
2. **Cloudflare Durable Objects**, through the deployable SQLite-backed authority
   in `managed/cloudflare-do`;
3. Redis/Valkey remains an additional managed authority.

The PostgreSQL layer has two first-class scopes:

- **transaction**: `pg_advisory_xact_lock` / `pg_try_advisory_xact_lock`, released
  automatically by commit or rollback;
- **session**: `pg_advisory_lock` / `pg_try_advisory_lock` plus explicit
  `pg_advisory_unlock` on one dedicated physical connection. This mode opens no
  database transaction and is appropriate for DDL, external orchestration, or
  other work that must not live inside a transaction.

That yields four recommended profiles when PostgreSQL exclusion is desired:

| Outer fenced authority | PostgreSQL transaction scope | PostgreSQL session scope |
| --- | --- | --- |
| fiducia-cloud | Fiducia -> `pg_advisory_xact_lock` -> work -> commit -> Fiducia release | Fiducia -> `pg_advisory_lock` -> work -> `pg_advisory_unlock` -> Fiducia release |
| Cloudflare Durable Objects | Durable Object -> `pg_advisory_xact_lock` -> work -> commit -> Durable Object release | Durable Object -> `pg_advisory_lock` -> work -> `pg_advisory_unlock` -> Durable Object release |

A caller may also use only the outer authority or only PostgreSQL when its
failure domain permits it. The two outer authorities are **alternatives behind
the same `Lease` seam** in v1; the library does not acquire Fiducia and a
Durable Object simultaneously. Stacking two independent fencing authorities
would require a separately specified composite-token ordering and partial-
failure policy rather than an implicit extra layer.

For transaction-scoped guarded writes the recommended production order is:

1. acquire a fenced lease from **fiducia-cloud** or **Cloudflare Durable Objects**;
2. begin the PostgreSQL transaction;
3. acquire `pg_advisory_xact_lock`;
4. perform guarded writes and persist the fencing watermark atomically;
5. renew/check the outer lease before commit for long-running work;
6. commit, then release the outer lease.

For work that must not run in a database transaction:

1. acquire the outer fenced lease;
2. reserve one dedicated PostgreSQL physical connection;
3. acquire `pg_advisory_lock` on that connection;
4. perform the guarded work without opening a transaction;
5. explicitly call `pg_advisory_unlock` on the same connection;
6. release the outer lease.

Never take a session advisory lock through an ordinary pool operation and later
unlock through another pooled operation. Advisory session locks belong to the
PostgreSQL session that acquired them; every runtime therefore keeps one
physical connection for lock, work, and unlock.

The v1 TypeSpec/JSON Schema and conformance corpus retain the historical
`layers.fiducia` and `fiducia.*` names. Until a contract-major release those
names mean **outer fenced lease authority**, whether the concrete backend is
Fiducia, Cloudflare Durable Objects, or Redis. This avoids a breaking rename
across five runtimes while making the authority replaceable now.

## fiducia-cloud

Fiducia remains a first-class authority, not merely a legacy compatibility
path. The Rust adapter uses the official `fiducia_client::AsyncFiduciaClient`;
Go, TypeScript, Dart, and Gleam expose equivalent adapters. Acquire returns a
monotonic fencing token, renewal preserves that token, and transport ambiguity
fails closed instead of being interpreted as contention.

Use Fiducia when its Raft-backed coordination service is available and its
failure domain is the one you want to depend on. The same Postgres transaction
or session scope can be nested inside it.

## Cloudflare Durable Objects

A deployable authority is in `managed/cloudflare-do`. It maps every non-empty
lock key to one Durable Object (`idFromName(key)`). Each object stores exactly
one active lease plus a persistent decimal fencing counter in SQLite-backed
Durable Object storage.

Properties:

- acquire/renew/release state transitions execute atomically against
  object-local storage;
- the fencing counter survives lease release and expiry;
- the counter is stored and returned as decimal text so JavaScript never rounds
  unsigned-64 tokens;
- an alarm reaps expired holder state, but acquisition also checks expiry, so a
  delayed alarm cannot keep an expired grant authoritative;
- renew and release match both holder and fencing token;
- empty lock keys are rejected before object routing;
- the public Worker fails closed if `ORES_LOCKS_API_TOKEN` is absent unless
  `ALLOW_UNAUTHENTICATED=true` is explicitly configured for development.

The Durable Object's **persisted SQLite state is authoritative**. Application
memory is only a cache while an object instance is active; correctness must not
rely on arbitrary JavaScript memory surviving eviction, hibernation, restart,
or migration.

Deploy from the repository root:

```sh
cd managed/cloudflare-do
npx wrangler secret put ORES_LOCKS_API_TOKEN
npx wrangler deploy
```

TypeScript:

```ts
import {
  CloudflareDurableObjectLease,
  lockKey,
  withLease,
} from "@oresoftware/locks-and-leases";

const authority = new CloudflareDurableObjectLease({
  baseUrl: process.env.ORES_LOCKS_CF_URL!,
  apiToken: process.env.ORES_LOCKS_CF_TOKEN!,
});

await withLease(
  lockKey("zed-pkg/registry/publish"),
  true,
  true,
  { ttlMs: 60_000, waitTimeoutMs: 30_000, retryIntervalMs: 250 },
  authority,
  async ({ grant }) => {
    // Persist grant!.fencingToken with the protected write.
  },
);
```

Rust exposes `ManagedLease::cloudflare(transport)` /
`CloudflareDurableObjectLease<T>`. The transport is intentionally supplied by
consumers so the dependency-free core does not force reqwest into every
`*-lib-core`; it must implement `ManagedLeaseTransport` against the Worker API.

## PostgreSQL advisory locks

Both PostgreSQL flavors are intentional public surfaces, not aliases for one
another.

### Transaction scope

`pg_advisory_xact_lock` is the default for ordinary database mutations. The
library opens a transaction, acquires the lock inside it, runs the callback in
that transaction, and relies on PostgreSQL to release the lock at commit or
rollback. `pg_try_advisory_xact_lock` provides non-blocking contention.

This scope is preferred when the protected work and its fencing watermark can
commit atomically in PostgreSQL.

### Session scope: no database transaction

`pg_advisory_lock` is held by a PostgreSQL session rather than a transaction.
The library checks out or constructs a dedicated physical connection, acquires
the lock, runs the callback with no transaction, then explicitly calls
`pg_advisory_unlock` on that same connection. `pg_try_advisory_lock` provides
non-blocking contention.

CI exercises two independent dedicated sessions: while the first owns a
session-scoped lock the second must observe contention; after the first
explicitly unlocks, the second must acquire; an unmatched second unlock must
return false rather than being silently treated as success.

## Redis / Valkey

`managed/redis/{acquire,renew,release}.lua` are the native RESP scripts. The
TypeScript package also exports `UpstashRedisLease`, which runs the same
semantics through Upstash's Redis-compatible REST API and therefore needs no
additional npm dependency.

Use two keys per logical lock:

```text
<namespace>:{<utf8-key-as-hex>}:lease
<namespace>:{<utf8-key-as-hex>}:fence
```

The braces are intentional: both keys land in one Redis Cluster hash slot so
`EVAL` remains legal and atomic. The `:fence` key has **no TTL**. It is the
monotonic authority watermark and must survive every lease expiry/release.

The acquire script does not use `tonumber` and does not use `INCR`. Redis Lua
numbers are doubles and `INCR` is signed-64; either choice would narrow the
repository's unsigned-64 fencing contract. Instead, the script increments the
counter digit-by-digit as decimal text and rejects overflow above
`18446744073709551615`.

TypeScript / Upstash:

```ts
import { UpstashRedisLease } from "@oresoftware/locks-and-leases";

const authority = new UpstashRedisLease({
  restUrl: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  namespace: "ores-locks",
});
```

Redis Cloud, self-managed Redis, and Valkey should execute the scripts directly
with a native client. Rust exposes `ManagedLease::redis(transport)` /
`RedisLease<T>` for this purpose.

## Safety requirements shared by all fenced authorities

A lease alone does not make a paused process safe. Every successful acquisition
returns a fencing token and every authoritative datastore must reject a token
older than its stored watermark. For PostgreSQL/Supabase/Neon use
`persistence/postgres/fencing.sql` in the same transaction as the business
mutation. For Redis-resident protected state use `persistence/redis/fenced-write.lua`.

Never interpret a network error as contention or successful release. A
transport failure means ownership is unknown. Renewal refusal is `lost_lease`;
the guarded operation must stop and must not commit.
