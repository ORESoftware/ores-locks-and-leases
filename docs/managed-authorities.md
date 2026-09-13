# Managed lease authorities

`Lease` is the production seam. Fiducia is still supported, but callers no longer
need to make an unfinished Fiducia deployment the availability dependency for
cross-host locking.

The recommended production order is:

1. acquire a fenced lease from **Cloudflare Durable Objects** or **Redis**;
2. begin the PostgreSQL transaction;
3. acquire `pg_advisory_xact_lock`;
4. perform guarded writes and persist the fencing watermark atomically;
5. renew/check the outer lease before commit for long-running work;
6. commit, then release the outer lease.

The v1 TypeSpec/JSON Schema and conformance corpus retain the historical
`layers.fiducia` and `fiducia.*` names. Until a contract-major release those
names mean **outer fenced lease authority**, whether the concrete backend is
Fiducia, Cloudflare Durable Objects, or Redis. This avoids a breaking rename
across five runtimes while making the authority replaceable now.

## Cloudflare Durable Objects

A deployable authority is in `managed/cloudflare-do`. It maps every lock key to
one Durable Object (`idFromName(key)`). Each object stores exactly one active
lease plus a persistent decimal fencing counter in SQLite-backed Durable Object
storage.

Properties:

- acquire/renew/release state transitions execute against strongly consistent
  object-local storage;
- the fencing counter survives lease release and expiry;
- the counter is stored and returned as decimal text so JavaScript never rounds
  unsigned-64 tokens;
- an alarm reaps expired holder state, but acquisition also checks expiry, so a
  delayed alarm cannot keep an expired grant authoritative;
- renew and release match both holder and fencing token;
- the public Worker fails closed if `ORES_LOCKS_API_TOKEN` is absent unless
  `ALLOW_UNAUTHENTICATED=true` is explicitly configured for development.

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

## Safety requirements shared by both backends

A lease alone does not make a paused process safe. Every successful acquisition
returns a fencing token and every authoritative datastore must reject a token
older than its stored watermark. For PostgreSQL/Supabase/Neon use
`persistence/postgres/fencing.sql` in the same transaction as the business
mutation. For Redis-resident protected state use `persistence/redis/fenced-write.lua`.

Never interpret a network error as contention or successful release. A
transport failure means ownership is unknown. Renewal refusal is `lost_lease`;
the guarded operation must stop and must not commit.
