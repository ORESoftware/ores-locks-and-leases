# Locks and leases contract authorities

The TypeSpec files under `contracts/**/typespec/` and the JSON Schema Draft
2020-12 files under `contracts/**/json-schema/` are independently authored,
top-level peer authorities. Neither authority is generated from, copied over,
or allowed to replace the other.

## Required TJSV admission

`ORESoftware/typespec-json-schema-validator` (TJSV) is the fail-closed
peer-authority validator for this repository. The admitted revision is pinned to
commit `6bb5b7c1ee41c8b43741e50a264c33a1165549c4`; floating branches and tags are
not accepted as merge evidence.

For each contract bundle, TJSV must:

1. inventory the independently authored TypeSpec and JSON Schema declarations;
2. compile TypeSpec into generated JSON Schema B as disposable comparison
   evidence;
3. validate authored Schema A and generated Schema B as Draft 2020-12 resource
   graphs;
4. normalize and recursively compare declaration shapes and constraints;
5. differentially execute both authorities over a non-empty deterministic probe
   corpus;
6. stop evaluation on missing declarations, unsupported semantics, generator
   failure, stale or contradictory mappings, divergence, refusal, or an
   indeterminate result; and
7. retain JSON, SARIF, Contract IR, and generated-schema evidence under
   `target/` without modifying either authored authority.

Generated Schema B is comparison evidence only. It must never overwrite or
become the source for the authored JSON Schema.

Run both maintained bundles locally with:

```sh
sh scripts/check-tjsv-contracts.sh all
```

`sh scripts/test-all.sh` includes that command whenever Node.js and npm are
available.

## Exact-head cross-runtime enforcement

`.github/workflows/contract-runtime-boundary.yml` binds the two TJSV receipts to
one exact pull-request head and to successful Rust, Go, TypeScript/Node.js,
Dart/Flutter-facing, and Gleam test lanes, RustSec, and a freshly generated
zed-pkg `*-lib-core` consumer. Its final receipt fails unless:

- the checked-out revision equals the pull-request head;
- both TJSV runs report zero unexplained findings;
- differential execution is enabled and evaluates at least one probe;
- divergences and refusals are both zero;
- every language/runtime lane succeeds; and
- the generated consumer compiles and passes its own TJSV contract admission.

`.github/workflows/renewal-supervisor.yml` applies the same TJSV and exact-head
requirements specifically to the independent renewal contract and its shared
polyglot conformance corpus.

## Mapping-integrity canary

`.github/workflows/peer-authority-validator.yml` executes the same immutable
TJSV revision and retains a deliberate negative test.
`mapping-tests/stale.mapping.json` names absent TypeSpec declaration
`Ores.LocksAndLeases.MissingLeaseGrant` while targeting real JSON Schema
resources. The workflow must:

- return the expected stopped-for-evaluation result;
- emit the attributable missing-declaration finding with a stable fingerprint;
- emit no generic or unrelated finding;
- leave both authored authorities and the mapping fixture byte-identical; and
- retain positive and negative JSON, SARIF, Contract IR, and generated-schema
  evidence separately.

A negative lane that unexpectedly passes, produces the wrong rule, cannot write
its receipt, or mutates an authored input fails the workflow.

## Application-fencing declarations

Both main authorities independently declare the datastore-facing fencing
boundary:

- `FencingTokenText`: canonical unsigned-64 decimal text, never a lossy JSON
  number;
- `FenceDecisionKind`: `advanced`, `replay`, `stale`, or `token_reuse`;
- `FencedWriteRequest`: resource identity, token, operation id, canonical
  payload SHA-256, and optional holder/lease diagnostics;
- `FenceWatermark`: the last accepted request identity for one protected
  resource; and
- `FenceDecision`: whether the mutation may apply and which token remains
  current.

The runtime helpers and `conformance/cases/fence-decision.json` must agree with
these declarations. PostgreSQL and Redis persistence adapters enforce the same
state machine atomically in the datastore; contract parity alone is not a
substitute for datastore fencing.

## Complementary generated-artifact validation

The pinned `ores-contracts` gate remains because it validates this repository's
existing Rust, TypeScript, Dart, and generated-package configuration. It is
complementary rather than authoritative over TJSV:

- TJSV proves independent TypeSpec/JSON Schema declaration, structural, and
  differential parity and emits digest-bound Contract IR.
- `ores-contracts` continues to exercise the existing multi-language projection
  and artifact configuration.

A mergeable pull request, skipped workflow, green synthetic merge commit, or
job that failed before exact-head checkout is not passing contract evidence.
