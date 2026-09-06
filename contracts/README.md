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
`ORESoftware/typespec-json-schema-validator` action at commit
`282883afc4645f3303ed746bdb1e1571475724c5`. Generated Schema B is written
under `target/` and must never overwrite the authored JSON Schema.

The existing `ores-contracts` gate remains in the main CI workflow because it
also validates this repository's generated Rust, TypeScript, and Dart artifact
configuration. The two gates are complementary: the peer-authority validator
establishes independent declaration/shape parity, while `ores-contracts`
continues to exercise the existing multi-language generation contract.

After changing either authority, run the existing local contract check and
inspect the hosted peer-authority evidence before merging. A mergeable pull
request, skipped workflow, or job that failed before checkout is not passing
contract evidence.
