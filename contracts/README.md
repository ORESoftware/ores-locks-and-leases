# Locks and leases contract authorities

The TypeSpec file at `typespec/main.tsp` and the JSON Schema Draft 2020-12 file
at `json-schema/contract.schema.json` are independently authored, top-level
peer authorities. Neither file is generated from, copied over, or allowed to
replace the other.

The validation sequence is deliberately bidirectional:

1. inventory and compare top-level declarations in TypeSpec and authored JSON
   Schema A;
2. compile TypeSpec into generated JSON Schema B as disposable comparison
   evidence;
3. normalize and compare authored Schema A with generated Schema B;
4. fail closed on missing declarations, incompatible shapes, unsupported
   semantics, generator failure, or an indeterminate comparison; and
5. retain the JSON, SARIF, and generated-schema evidence for review.

`.github/workflows/peer-authority-validator.yml` executes the immutable
`ORESoftware/typespec-json-schema-validator` action at merge commit
`8584720715e4e90573535e14b16cb3a24c14ca63`. That revision preserves the
Draft 2020-12 runtime resource graph during differential validation, uses
comparison-only normalization for peer-authority evidence, and fails closed on
stale, ambiguous, duplicate, or contradictory mappings and ignore lists.
Generated Schema B is written under `target/` and must never overwrite the
authored JSON Schema.

## Negative mapping-integrity canary

`mapping-tests/stale.mapping.json` deliberately names absent TypeSpec
declaration `Ores.LocksAndLeases.MissingLeaseGrant` while targeting the real
`LockPlan` declarations in both JSON Schema lanes. The exact-head workflow must:

- return exit code 2 through a `continue-on-error` step;
- retain report status `stopped_for_evaluation` rather than `failed`;
- emit exactly one `mapping-typespec-declaration-missing` finding with a stable
  fingerprint;
- emit no generic `run-failed` or unrelated target-collision finding;
- leave both authored authorities and the mapping fixture byte-identical; and
- retain positive and negative JSON, SARIF, and generated-schema evidence in
  separate directories.

The verifier script is intentionally independent from the validator package. A
negative lane that unexpectedly passes, cannot write its receipt, produces the
wrong rule, or mutates an authored input fails the workflow.

The existing `ores-contracts` gate remains in the main CI workflow because it
also validates this repository's generated Rust, TypeScript, and Dart artifact
configuration. The two gates are complementary: the peer-authority validator
establishes independent declaration/shape parity and mapping integrity, while
`ores-contracts` continues to exercise the existing multi-language generation
contract.

After changing either authority, run the existing local contract check and
inspect the hosted positive and negative peer-authority evidence before merging.
A mergeable pull request, skipped workflow, or job that failed before checkout
is not passing contract evidence.
