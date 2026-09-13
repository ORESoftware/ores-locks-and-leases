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

## Durable Object design rules

Cloudflare Durable Objects are the primary implementation reference for the
managed-authority shape. The important ideas are broader than Cloudflare itself:

- choose the smallest **atom of coordination** that can own a correctness
  decision. For a simple ORES lock that is one lock key, so one key maps to one
  Durable Object. For Fiducia union locks the atom is the overlapping conflict
  domain, not an individual key; blindly sharding `{a,b}` and `{b,c}` to separate
  authorities would break mutual exclusion;
- keep authoritative state durable. In-memory state is cache only and may vanish
  on hibernation, restart, deployment, or failover;
- serialize read/modify/write transitions through one authority and its
  transactional storage. Do not recreate a second independent lock in the
  Worker/client layer;
- alarms/timers are **cleanup and wake-up mechanisms, never the lease clock**.
  Every acquire, renew, release, and guarded read re-checks persisted expiry.
  Alarm delivery may be delayed or repeated without extending authority;
- make retries idempotent. Re-acquiring an active lease with the same holder
  replays the existing token and expiry without extending the lease. Clients
  recovering such a replay perform an explicit token-bound renew before exposing
  the grant to protected work;
- treat restart and transport ambiguity as normal distributed-system events.
  A lost response is not contention and not proof that acquisition failed;
- bound request sizes and identity fields before they reach the authority, and
  fail closed on fencing exhaustion rather than wrapping/reusing a token;
- design backpressure as part of deterministic authority semantics. Local memory
  pressure or one process's queue length must not create a different ownership
  decision on another replica.

## Cloudflare Durable Objects

A deployable authority is in `managed/cloudflare-do`. It maps every lock key to
one Durable Object (`idFromName(key)`). Each object stores exactly one active
lease plus a persistent decimal fencing counter in SQLite-backed Durable Object
storage.

Properties:

- acquire/renew/release state transitions execute against strongly consistent
  object-local storage;
- the fencing counter survives lease release and expiry;
- fencing tokens are positive and capped at `9007199254740991`, JavaScript's
  largest exactly representable integer and the same public ceiling used by
  fiducia-cloud. The Worker keeps decimal text on its existing JSON boundary for
  compatibility, but values above the ceiling are neither accepted nor minted;
- re-acquiring with the active holder replays the existing token without
  extending authority; the TypeScript adapter follows a replay with explicit
  token-bound renewal before returning the grant;
- an alarm reaps expired holder state, but every mutation also checks expiry, so
  delayed or at-least-once alarm delivery cannot keep an expired grant
  authoritative;
- key, holder, optional request id, request body, and TTL are bounded before
  state mutation;
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

The acquire script does not use `tonumber` for fencing arithmetic and does not
use `INCR`. Redis Lua numbers are doubles, so fencing arithmetic is performed
digit-by-digit as decimal text. The script rejects the next token above
`9007199254740991`, matching Cloudflare DO, Fiducia, TypeSpec, and JSON Schema.
It also treats a same-holder retry as an idempotent replay rather than minting a
second token or extending the lease.

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
