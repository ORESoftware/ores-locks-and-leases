# Polyglot participant governance

The safety contracts in this repository are cross-runtime contracts. A runtime is
supported only when it is a governed participant in all of the following:

1. a concrete source root under `src/`;
2. a required bidirectional entry in `contracts/language-boundaries.json`;
3. the primary language CI matrix;
4. the exact-head contract/runtime boundary workflow; and
5. the TJSV runtime-admission workflow.

The machine-readable roster lives in
`governance/polyglot-participants.v1.json`. The corresponding checker fails
closed if a runtime directory appears or disappears without a coordinated
governance/contract/CI change.

Erlang files under the Gleam tree are governed BEAM FFI projections of the Gleam
participant rather than a separate public runtime contract.

Generated schemas and receipts remain evidence only; TypeSpec and JSON Schema stay
independently authored peer authorities.
