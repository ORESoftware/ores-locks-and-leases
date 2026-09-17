# Cloudflare Durable Object service profile

`service-cloudflare-pg` is the preferred ORE service profile for destructive or otherwise authority-sensitive work that mutates PostgreSQL-compatible state from more than one process/host.

The authority stack is intentionally layered:

```text
Cloudflare Durable Object fenced lease
  -> PostgreSQL BEGIN
    -> transaction-scoped pg advisory lock
      -> ores_locks fencing watermark
        -> guarded mutation
      -> mandatory final same-token lease renewal
    -> COMMIT
  -> release outer lease
```

The exact lifecycle lock-key shape used by `ores-archived-and-delete-data` is:

`<github-org>/data-lifecycle/<environment>/<policy-id>`

For example, every maintained runtime must receive the same opaque key value:

- Rust: `oresoftware/data-lifecycle/prod/default-v2`
- TypeScript: `oresoftware/data-lifecycle/prod/default-v2`
- Go: `oresoftware/data-lifecycle/prod/default-v2`
- Gleam: `oresoftware/data-lifecycle/prod/default-v2`
- Dart: `oresoftware/data-lifecycle/prod/default-v2`

The shared library does not parse product semantics out of that key. The consumer owns normalization and must ensure delimiters cannot be injected by untrusted org/environment/policy components.

## Configuration ownership

Today Rust is the only maintained runtime that directly parses `.ores-lock.toml`. TypeScript, Go, Gleam and Dart consume already-selected provider/lease objects and therefore do **not** need independent TOML parsers merely to satisfy parity. If another runtime starts parsing `.ores-lock.toml` directly, it must add a projection of `outer_authority = "cloudflare_durable_object"`, the `service-cloudflare-pg` provider blocks, and the same validation/error taxonomy before the runtime can be added to `config_runtime_owners` in `conformance/cases/service-cloudflare-pg.json`.

This keeps configuration parsing single-purpose while preserving cross-runtime lock/lease semantics through the existing TypeSpec + independently authored JSON Schema authorities and maintained-path conformance.

## Final-renewal rule

A successful work callback is not sufficient authority to commit. The maintained transaction path must renew the exact same outer grant immediately before commit. Changed key, holder, fencing token, explicit lease loss, renewal transport ambiguity, or failed final renewal all require rollback. This rule is provider-neutral and therefore applies unchanged when the outer `Lease` implementation is Cloudflare Durable Objects instead of Fiducia.

The formal maintained-transaction model and Rust/TypeScript/Go/Dart executable suites cover the final-renewal/rollback rule. Cloudflare only supplies the outer fenced lease; it does not weaken the commit protocol.

## Scheduler-local locks are not authority

Google Apps Script `LockService`, GitHub Actions `concurrency`, Kubernetes `concurrencyPolicy: Forbid`, cron singleton files, and similar scheduler-local mechanisms are useful **duplicate-trigger suppression**. They reduce wasted concurrent invocations.

They are not a fenced distributed authority and must never replace the Cloudflare Durable Object lease or datastore fence. A scheduler can be duplicated, retried, restarted, or invoked from a second scheduler. Correctness therefore remains:

1. acquire the shared Cloudflare DO lease;
2. carry its fencing token into the protected transaction;
3. acquire the transaction-scoped PostgreSQL advisory lock;
4. advance/check the datastore fence;
5. mutate exact admitted rows;
6. perform the mandatory final same-token renewal;
7. commit only while authority is still proven.

## Secrets

`.ores-lock.toml` contains environment-variable names, not secret values. Keep the Cloudflare API/token material in the consumer's secret store (for ORE deployments, prefer the existing sops+age/env-enc path). Never place bearer tokens in lock keys, error text, telemetry, or repository config.
