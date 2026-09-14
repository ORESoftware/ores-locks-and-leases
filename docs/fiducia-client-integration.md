# Fiducia client integration

`ores-locks-and-leases` treats Fiducia as the outer distributed lease/fencing
layer. The wire/API authority is `fiducia-cloud/fiducia-clients/operations.json`;
high-level behavior should additionally match the hard-gated locking helpers in
that repository.

## Required lock invariants

For a single logical blocking acquisition:

1. Generate one holder identity and one distinct request identity.
2. Reuse both identities on every `/v1/locks/acquire` poll.
3. Send `wait: true` and a bounded `wait_timeout_ms`; try-lock sends
   `wait: false`.
4. Never map transport ambiguity to contention. A failed response does not prove
   that the command failed to commit.
5. A grant discovered on a retry must be fenced/renewed before application work
   starts so stale authority is not exposed.
6. Renew with `keys: [key]`, `holder`, `fencing_token`, and `ttl_ms`.
7. Release the whole grant by `holder` + `fencing_token`.
8. Refuse credential-bearing redirects and public cleartext HTTP.
9. Bound server error text before it reaches logs/errors.
10. Pass fencing tokens to downstream writes and fail closed when exact integer
    representation cannot be preserved.

The official hard-gated clients additionally cancel abandoned/ambiguous queued
acquisition identities and release a raced grant returned by cancellation. The
local `Lease` interface does not yet expose cancellation, so timeout cleanup
remains bounded by `wait_timeout_ms` and the grant TTL. Adding explicit
cancel-on-timeout/abort is a follow-up hardening item rather than silently
pretending it is implemented.

## Runtime status

| Runtime | Integration | Status |
| --- | --- | --- |
| Go | local `net/http` adapter | Current acquire/renew/release wire shapes and stable request identity are enforced by tests; response error bodies are bounded. |
| TypeScript | local `fetch` adapter | Current acquire/renew/release wire shapes and stable request identity are enforced by tests; redirects are refused and response error bodies are bounded. |
| Dart | local `package:http` adapter | Current acquire/renew/release wire shapes and stable request identity are implemented; response error bodies are bounded and CI exercises the package. |
| Gleam | local `gleam_httpc` adapter | Current acquire/renew/release wire shapes and stable request identity are implemented. CI exercises the package; bounded error-body rendering and stronger request-id entropy remain hardening follow-ups. |
| Rust | official `fiducia-client::AsyncFiduciaClient` | Uses an older pinned revision. Do not bump blindly: the current hand-written async helper in `fiducia-clients` still needs to converge with the generated `operations.json` lock shapes/high-level queue semantics. |

## Upstream-client rule

Prefer a hard-gated official client when its runtime/API is current. When a local
adapter is intentionally retained to keep the core package lightweight, treat
`operations.json` plus the hard-gated Go/TypeScript locking helpers as the
compatibility oracle and keep explicit wire-shape tests here.

Hosted customer traffic should target the Fiducia edge load balancer. Direct
node access is only for trusted internal topology; the node is not a substitute
for the hosted HTTP idempotency/replay boundary.
