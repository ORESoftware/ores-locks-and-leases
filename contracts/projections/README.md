# Optional additive contract projections

TypeSpec and authored JSON Schema are the two mandatory, independently authored contract authorities in this repository. `ORESoftware/typespec-json-schema-validator` (TJSV) generates JSON Schema from TypeSpec only as comparison evidence, compares the two authorities, emits a digest-bound Contract IR, and verifies consumers against that evidence.

Protobuf, WIT, and Dafny are additive projections. They are optional until a directory for that lane exists. Once present, the lane is fail-closed and must be admitted with `tjsv verify-projection`.

Directory convention:

```text
contracts/projections/<bundle>/<lane>/
  projection-manifest.json
  projection-policy.json
  ... generated/current projection artifacts ...
```

`<bundle>` is one of `main`, `renewal`, or `local`. `<lane>` is one of `protobuf`, `wit`, or `dafny`. The corresponding artifact extension must be present: `.proto`, `.wit`, or `.dfy`.

The projection manifest is evidence, not a third schema authority. It must bind the current projection outputs to the exact current TJSV parity receipt, Contract IR, TypeSpec source, authored JSON Schema, and TypeSpec-generated JSON Schema witness. The trusted projection policy controls which outputs and representation deltas are admissible.

Run the mandatory peer-authority checks first, then the optional lanes:

```sh
sh scripts/check-tjsv-contracts.sh all
sh scripts/check-tjsv-optional-projections.sh
```

An absent optional lane prints `skipped` and succeeds. A lane directory containing an artifact without both `projection-manifest.json` and `projection-policy.json` fails. `.proto`, `.wit`, and `.dfy` contract artifacts outside this tree also fail so additive contracts cannot bypass TJSV admission.
