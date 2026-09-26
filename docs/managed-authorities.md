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

## Durable Object design rules

Cloudflare Durable Objects are the primary managed-authority implementation
reference. The important rules also apply to other authority backends:

- choose the smallest **atom of coordination** that can own one correctness
  decision. A simple ORES lock maps one lock key to one Durable Object. Fiducia
  union locks must instead keep authority over the overlapping conflict domain;
- keep authoritative state durable. Application memory is cache only and may
  disappear on hibernation, restart, deployment, failover, or migration;
- serialize read/modify/write transitions through one authority and its
  transactional storage. Do not layer an independent Worker-side lock on top;
- alarms/timers are cleanup and wake-up mechanisms, never the lease clock. Every
  mutation re-checks persisted expiry, so delayed or repeated alarms cannot
  extend authority;
- make ambiguous acquisition retries idempotent. Re-acquiring with the same
  logical request replays the existing token and expiry without extending the
  lease; an explicit token-bound renew is required before guarded work resumes;
- treat transport ambiguity as unknown ownership, never contention;
- bound request bodies, keys, holders, request ids and TTLs before state change;
- fail closed when the fencing domain is exhausted. Never wrap, reset, or reuse
  a fencing token to recover availability.

## Cloudflare Durable Objects

A deployable authority is in `managed/cloudflare-do`. It maps every non-empty
lock key to one Durable Object. Each object stores exactly one active lease plus
a persistent decimal fencing counter in SQLite-backed Durable Object storage.

Properties:

- `LockLeaseObject` extends Cloudflare's built-in `DurableObject` class and
  exposes `acquire`, `renew`, and `release` as native Workers RPC methods;
- Worker-to-object calls use `DurableObjectNamespace<LockLeaseObject>` /
  `DurableObjectStub<LockLeaseObject>` semantics instead of an internal HTTP hop;
- `src/ts/src/cloudflare-do-rpc-types.ts` exports explicit request/result unions
  plus structural namespace/stub types, while `managed/cloudflare-do/src/index.d.ts`
  declares the deployed class for Worker tooling and `wrangler types`;
- `CloudflareDurableObjectRpcLease` implements the shared `Lease` interface for
  Workers that already hold the `LOCKS` binding. The older
  `CloudflareDurableObjectLease` remains the HTTP client for cross-network callers;
- expected validation, contention, stale-owner, and fencing-exhaustion outcomes
  are returned as typed values rather than RPC exceptions. Unexpected RPC faults
  remain transport failures; callers obtain a fresh stub for subsequent calls;
- the fencing counter survives lease release and expiry;
- newly minted fencing tokens are positive and capped at
  `9007199254740991` (`Number.MAX_SAFE_INTEGER`). Decimal-text watermark storage
  remains uint64-compatible for rolling migration and historical state;
- re-acquiring with the active holder/request replays the existing token without
  extending authority; both direct-RPC and HTTP TypeScript adapters follow a
  replay with explicit token-bound renewal before exposing the grant;
- key, holder, optional request id, request body, and TTL are bounded before
  state mutation;
- renew and release match both holder and fencing token;
- the public HTTP Worker fails closed if `ORES_LOCKS_API_TOKEN` is absent unless
  `ALLOW_UNAUTHENTICATED=true` is explicitly configured for development.

Deploy from the repository root:

```sh
cd managed/cloudflare-do
npx wrangler secret put ORES_LOCKS_API_TOKEN
npx wrangler deploy
```

### Direct Workers RPC

Inside another Worker with the `LOCKS` Durable Object namespace binding, prefer
the direct adapter:

```ts
import {
  CloudflareDurableObjectRpcLease,
  lockKey,
  withLease,
} from "@oresoftware/locks-and-leases";

const authority = new CloudflareDurableObjectRpcLease({ namespace: env.LOCKS });

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

The generated binding should resolve as `DurableObjectNamespace<LockLeaseObject>`.
The shared package intentionally depends only on the structural subset
`CloudflareDurableObjectRpcNamespace`, so using it does not force Cloudflare
runtime types into Node, Flutter, Rust, Go, or Gleam consumers.

### Public HTTP compatibility path

For callers outside the Worker binding graph, use the bearer-protected Worker API:

```ts
import { CloudflareDurableObjectLease } from "@oresoftware/locks-and-leases";

const authority = new CloudflareDurableObjectLease({
  baseUrl: process.env.ORES_LOCKS_CF_URL!,
  apiToken: process.env.ORES_LOCKS_CF_TOKEN!,
});
```

The HTTP Worker validates authentication and lock identity, selects the object
with `env.LOCKS.getByName(key)`, and then invokes the same typed RPC methods. The
Durable Object also keeps a `fetch()` adapter for older internal callers during
migration; it is no longer the canonical Worker-to-object path.

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

The acquire script does not use `tonumber` for fencing arithmetic and does not
use `INCR`. Redis Lua numbers are doubles, so fencing arithmetic is performed
digit-by-digit as decimal text. New grants fail closed above
`9007199254740991`, matching Cloudflare Durable Objects, Fiducia, TypeSpec, JSON
Schema, and browser/TypeScript exact-integer semantics. Same-holder acquisition
retries replay the current grant without resetting TTL or minting a new token.

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

## BeamScale Durable Objects / critical sections

`BeamScaleCriticalSectionLease` is the TypeScript adapter for a critical-section
deployment created by `bmscl durable-objects deploy`.

BeamScale's runtime authority token contains three fields:

```text
(runtime_epoch, owner_epoch, sequence)
```

The adapter retains that complete token privately for renew/release. The shared
`LeaseGrant.fencingToken` is `BigInt(sequence)`: the BeamScale runtime persists
`sequence` with critical-section state and advances it on every new grant, so it
remains the scalar monotonic watermark expected by the existing datastore
fencing contracts.

```ts
import { BeamScaleCriticalSectionLease } from "@oresoftware/locks-and-leases";

const authority = new BeamScaleCriticalSectionLease({
  baseUrl: process.env.BMSCL_API_URL!,
  apiToken: process.env.BMSCL_TOKEN!,
  deploymentId: "orders-critical-sections",
});
```

Durable Object deployments are tenant-dedicated: one tenant per BEAM OS
process. This is separate from BeamScale Lambda pricing, where the free tier may
multiplex tenants and the pro tier is tenant-dedicated.

Acquire transport errors are deliberately not retried. BeamScale does not yet
publish a request-id replay contract for critical-section acquisition, so a
connection failure after sending the request means ownership is unknown and
maps to `transport`, not contention. A future request-id contract can add safe
idempotent replay without changing the `Lease` interface.
