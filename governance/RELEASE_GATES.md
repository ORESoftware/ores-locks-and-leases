# Release and admission gates

This file names the evidence families that protect the repository. The workflow
files remain the executable source for exact commands, versions, and path filters.

## Required evidence families

| Evidence family | Primary repository lanes |
| --- | --- |
| bounded lease/fencing safety | `formal-model.yml`, `formal-state-machines.yml`, `formal-leases-model.yml` |
| cross-runtime conformance | `ci.yml`, `provider-conformance-matrix.yml`, renewal and local-file conformance lanes |
| peer contract parity | `contract-runtime-boundary.yml`, `tjsv-language-runtime-boundary.yml`, peer-authority validator lanes |
| adversarial fencing / persistence behavior | `adversarial-fencing.yml` plus datastore/runtime adversarial scripts |
| renewal supervision and cancellation safety | `renewal-supervisor.yml` and the shared renewal/cancellation corpora |
| consumer/refinement evidence | generated `*-lib-core` checks and the exact-head runtime-boundary receipts |

The applicable set depends on the change classification in
[`CHANGE_CONTROL.md`](CHANGE_CONTROL.md). A documentation-only pull request does
not need to invent runtime changes just to touch every lane, but existing gates must
not be weakened or bypassed.

## Local preflight

For changes that touch the core distributed safety boundary, the expected local
preflight includes:

```sh
node formal/model.mjs
node formal/maintained-model.mjs --receipt target/formal-maintained/receipt.json
cargo test --locked --manifest-path formal/fencing-model/Cargo.toml
sh conformance/check.sh
sh scripts/check-tjsv-contracts.sh all
sh scripts/test-all.sh
```

Run narrower provider- or runtime-specific checks in addition when the changed path
has its own workflow.

## Evidence acceptance

Evidence is acceptable only when it is attributable to the exact revision under
review and the relevant check actually executed. A green status is insufficient if
the job was skipped, failed before checkout, evaluated another SHA, or omitted the
proof/test step because of path or setup drift.

Receipts and generated schemas are evidence, not editable authorities. Authored
TypeSpec, authored JSON Schema, maintained conformance vectors, and reviewed model
sources remain version-controlled inputs.

When a negative control exists, it is part of the gate. A model that can no longer
demonstrate the unsafe trace it is intended to forbid is not stronger merely because
it is green; the negative control must continue proving that the safety obligation is
meaningful.

## Merge rule

Do not admit a semantic change while any required evidence family is missing,
indeterminate, or contradictory. Resolve the contradiction at the invariant or
contract level; do not weaken one authority simply to match another.

Tracked by #108.
