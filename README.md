# ores-locks-and-leases

Composed distributed locking for the ORESoftware fleet: a **fiducia-cloud
lease** around a **PostgreSQL advisory lock**, each layer individually
switchable, plus **application-side fencing** that prevents an expired holder
from overwriting work committed by a newer holder.

```text
fiducia.acquire ─► pg.begin ─► pg_advisory_xact_lock ─► fenced work ─► pg.commit ─► fiducia.release
```

One zed package ships five runtime slices—Rust, Go, TypeScript, Dart/Flutter,
and Gleam—plus peer TypeSpec and JSON Schema contracts, one cross-runtime
conformance corpus, a PostgreSQL adapter for Supabase/Neon, and an atomic Redis
script.

| Path | Package / purpose | PostgreSQL via | Fiducia via |
| --- | --- | --- | --- |
| `src/rust` | `ores-locks-and-leases` crate | SeaORM (`pg` feature) | official async client (`fiducia` feature) |
| `src/go` | `github.com/ORESoftware/ores-locks-and-leases/src/go` | `database/sql` | `net/http` |
| `src/ts` | `@oresoftware/locks-and-leases` | node-postgres-shaped pool | `fetch` |
| `src/dart` | `ores_locks_and_leases` | `package:postgres` | `package:http` |
| `src/gleam` | `ores_locks_and_leases` | `pog` | `gleam_httpc` |
| `persistence/postgres` | Supabase/Neon/PostgreSQL watermark table and function | native SQL | |
| `persistence/redis` | atomic fenced `SET` for Redis-resident state | | |
| `contracts` | independent TypeSpec + JSON Schema authorities | | |
| `conformance` | vectors every runtime follows | | |

Every `*-lib-core` consumes this repository through zed-pkg and wraps lock keys
with its own `<org>/<domain>/<name>` prefix rather than reimplementing the
coordination or fencing rules.

## Lock routines

Every runtime exposes the same three routines:

- **`with_xact_lock`**: optional Fiducia lease around
  `pg_advisory_xact_lock`, inside a transaction opened around the caller's
  work. This is the default for PostgreSQL mutations.
- **`with_session_lock`**: optional Fiducia lease around
  `pg_advisory_lock`/`pg_advisory_unlock` on one dedicated physical
  connection. No transaction is opened automatically.
- **`with_lease`**: Fiducia only, for non-PostgreSQL work or callers that own
  their transaction boundary.

Each routine accepts switchable `LockLayers`, a transaction/session scope, and
blocking versus fail-fast acquisition. Fiducia is always outermost; the
database lock sits inside it; work is innermost.

Lease renewal is explicit. Work approaching the configured TTL must renew
before expiry and stop producing effects when renewal fails. A successful
renewal keeps the same fencing token. A new grant receives a larger token.

## Fencing is mandatory for guarded writes

A lease can expire while a process is paused. The process can resume after a
new holder has committed. The protected datastore—not the old process—must
decide whether the write is still authoritative.

For one `(tenantScope, resourceKey)` watermark:

| comparison | decision | apply mutation? |
| --- | --- | --- |
| no prior watermark or incoming token is larger | `advanced` | yes, once |
| equal token, operation id, and payload digest | `replay` | no |
| incoming token is smaller | `stale` | no |
| equal token with different operation id or digest | `token_reuse` | no |

The compare, watermark advance, and business mutation must be one atomic unit.
See [`docs/fencing-tokens.md`](docs/fencing-tokens.md) and
[`persistence/README.md`](persistence/README.md).

### Supabase and Neon

Both are PostgreSQL. Install `persistence/postgres/fencing.sql` independently
in every physical database that stores protected state. A fence accepted by
Supabase does not authorize a Neon write, and a Redis watermark cannot protect
a PostgreSQL mutation.

The migration stores the full Fiducia `uint64` in `NUMERIC(20,0)`, because
PostgreSQL `BIGINT` is signed. Call the function and mutate business state in
the same transaction:

```sql
BEGIN;

WITH fence AS MATERIALIZED (
  SELECT *
  FROM ores_locks.try_advance_fence(
    'tenant/acme',
    'zed-pkg/registry/publish:zed-lib-core',
    '18446744073709551615',
    'publish-request-9f2c',
    '6f1ed002ab5595859014ebf0951522d9a0f1db7a81d5e10e4b3397f14a4d4117',
    'registry-worker-7',
    'fiducia-lease-456'
  )
), applied AS (
  UPDATE registry.packages AS package
  SET published_version = '1.4.0',
      last_fencing_token = fence.current_token::numeric
  FROM fence
  WHERE fence.should_apply
    AND package.package_name = 'zed-lib-core'
  RETURNING 1
)
SELECT fence.*, EXISTS (SELECT 1 FROM applied) AS mutation_applied
FROM fence;

COMMIT;
```

The migration creates a dedicated schema, revokes `PUBLIC`, and grants nothing
to Supabase `anon` or `authenticated`. Product infrastructure explicitly
grants access only to trusted API/worker roles.

### Redis

`persistence/redis/fenced-write.lua` compares the decimal token and writes one
Redis-resident value in a single script. The watermark and state keys must use
the same non-empty cluster hash tag. The script never calls `tonumber`, because
Redis Lua numbers cannot preserve all unsigned-64 values.

Redis fencing protects Redis state only. For PostgreSQL state, use the
PostgreSQL adapter in the same transaction as the SQL mutation.

## Runtime decision helpers

The five language slices expose the same dependency-free request, watermark,
and decision types. They validate untrusted data before any datastore call:

- Rust: `FencingTokenText`, `FencedWriteRequest`, `evaluate_fence`
- Go: `ParseFencingTokenText`, `FencedWriteRequest`, `EvaluateFence`
- TypeScript: `fencingTokenText`, `fencedWriteRequest`, `evaluateFence`
- Dart: `FencingTokenText`, `FencedWriteRequest`, `evaluateFence`
- Gleam: `ores_locks_and_leases/fence`

These helpers are semantic mirrors of the SQL and Redis adapters. They are not
a substitute for datastore atomicity.

## Token representation

Fiducia tokens are unsigned 64-bit integers with maximum value:

```text
18446744073709551615
```

Use canonical decimal strings at JSON, SQL, Redis, and cross-language
boundaries. Native `u64`, `uint64`, `bigint`, `BigInt`, or BEAM `Int` is safe
inside a runtime. Never pass a token through JavaScript `number`, Dart `num`,
Redis Lua `tonumber`, or PostgreSQL signed `BIGINT`.

The existing Fiducia clients fail closed when a JSON numeric token is above
the exact range of their decoder and accept decimal-string responses, allowing
the Fiducia wire API to migrate losslessly.

## Keys

Keys follow `<org>/<domain>/<name>`. `advisory_key(key)` is FNV-1a 64 over the
UTF-8 bytes, reinterpreted as a signed PostgreSQL `bigint`. Every runtime is
pinned to `conformance/cases/advisory-key.json`, so the same key locks the same
integer everywhere.

## Failure kinds

Lock acquisition and cleanup use:

```text
contention, timeout, lost_lease, transport, database, work, invalid_plan
```

`transport` is never interpreted as “not held.” Cleanup failures take
precedence over an earlier work failure: a failed lease release leaves
ownership unknown, and a failed session unlock makes the physical connection
unsafe to reuse.

Fencing decisions are separate from acquisition failures:
`advanced`, `replay`, `stale`, and `token_reuse`.

## Contracts and conformance

`contracts/typespec/main.tsp` and
`contracts/json-schema/contract.schema.json` are independently authored peers.
`ORESoftware/ores-contracts` and
`ORESoftware/typespec-json-schema-validator` compile TypeSpec to disposable
Schema B, compare it with authored Schema A, and refuse final artifacts when
the declarations disagree.

The corpus includes:

- `advisory-key.json`
- `lock-plan.json`
- `fence-decision.json`

Changing a decision vector must update every runtime, SQL/Redis adapter test,
and both contract authorities.

## Testing

```sh
sh scripts/test-all.sh
```

CI runs every runtime, the contract parity gate, live PostgreSQL fencing tests,
Redis script tests, and a generated `*-lib-core` preflight. Local live
PostgreSQL lock tests run when `ORES_LOCKS_TEST_DATABASE_URL` is set.
