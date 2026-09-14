# `.ores-lock.toml` runtime coordination policy

`.ores-lock.toml` is the repository-local runtime policy manifest owned by `ORESoftware/ores-locks-and-leases`. It configures **which lock providers a consumer uses and their operational timing**, while keeping package/build metadata and unrelated concerns in their own authorities.

## Boundary

The config may select local-file, Fiducia, and PostgreSQL advisory-lock providers; define wait/retry/TTL/renewal timing; select the PostgreSQL scope; and name environment variables containing provider endpoints, credentials, database URLs, or local lock roots.

It must **not** carry package coordinates, immutable dependency pins, build/install/publish/test mechanics, rate-limit policy, Redis/LRU cache policy, Shared Auth/JWT/OAuth policy, telemetry/export configuration, middleware ordering, or secret values. Those stay respectively in `.zpkg.toml`, `.ores-rl.toml`, `.ores-lru.toml`, `.auth-shared.toml`/`.shared-auth.toml`, `.ores-otel.toml`, `.ores-mw.toml` plus its referenced middleware-stack JSON, and the process environment/secret store.

Correctness invariants are also deliberately not knobs. Fencing-token semantics, stale-holder rejection, local owner-token bounds, symlink/hard-link refusal, owner verification, crash-state classification, and recovery safety remain library/contract invariants.

## Contract authority

The normalized TOML shape has two independent human-authored peer authorities:

- `typespec/main.tsp`
- `json-schema/contract.schema.json`

Neither is generated from the other. `ORESoftware/ores-contracts` and `ORESoftware/typespec-json-schema-validator` provide parity/admission evidence. `fixtures/config.default.json` is normalized instance evidence, not a third authority.

Run from the repository root:

```sh
npx --yes \
  --package=https://github.com/ORESoftware/ores-contracts/archive/f79ea8d8d94d7a9e78c15f7e46ecae8e4b584d2e.tar.gz \
  ores-contracts check --config contracts/lock-config/contracts.config.json
```

Repository audits should additionally run `oresc audit repo` after the sibling `ores-cli` support lands. The fast audit enforces cross-field semantics that are awkward to express portably in both schema authorities, including provider/table agreement, secret environment references, default-profile existence, wait/retry coherence, and renewal cadence.

## Profiles

The checked-in root manifest intentionally provides two reference profiles:

- `local-install`: local-file coordination for single-machine package/install workflows; no Redis, Fiducia, or network service is required.
- `service-composed`: Fiducia + PostgreSQL advisory locking for multi-process/service workloads with fencing and maintained lease renewal.

Consumers may add profiles, but should prefer a small named set selected at process startup. Dynamic per-request mutation of locking policy is intentionally out of scope.
