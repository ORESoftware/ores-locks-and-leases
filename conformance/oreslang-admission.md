# Oreslang runtime / contract support — draft gate

**State: proposed and blocked.** No Oreslang implementation, runtime proof, contract authority changes or browser support is claimed by this document.

Repository invariant: LockPlan ordering, FNV-1a key vectors, lock error kinds, session-scoped physical connection, lease ambiguity and fencing-token semantics must remain byte/behavior exact. Never confuse transport failure with lock contention.

## Integration contract

1. Human-authored **TypeSpec** and **JSON Schema Draft 2020-12** remain separate peer authorities. A new Oreslang codegen lane only consumes source-current, independently reconciled, reviewed declarations; neither lane is generated from the other and promoted as authority.
2. Pinned [TJSV](https://github.com/ORESoftware/typespec-json-schema-validator) provides peer parity, precise Contract IR identity, valid/invalid instance corpus binding, runtime evidence format and the final admit/stop decision. Persistence projections use [ores-contracts](https://github.com/ORESoftware/ores-contracts) only where applicable.
3. Compile the real implementation and derived declarations with an immutable reviewed [GraalVM Oreslang compiler](https://github.com/ores-truffle-oreslang/oreslang-source.java) revision, using [oreslang-serialization-and-validation](https://github.com/ores-truffle-oreslang/oreslang-serialization-and-validation). Known compiler feature/codec mismatches are blockers; a mock launcher success is insufficient.
4. Execute positive, negative, malformed, boundary and relevant state-machine/replay fixtures identically to other runtimes. Preserve exact wire keys, enum tags, null versus absent semantics, integer bounds, timeouts, policy ordering, redaction and rejected cases.
5. Emit bounded, payload-free per-instance Oreslang evidence bound to exact TJSV Contract IR ID, parity-run ID, corpus digest, code revision and compiler pin. Missing cases, unsupported syntax, stale pins or skipped jobs **fail closed**.
6. Enable Oreslang as a published/runtime target only with its actual implementation, runtime-conformance checks, immutable Zed dependencies, real external consumer and package-content tests. Existing Rust/TS/Go/Dart gates must remain required.
7. **Future only:** Oreslang-to-JavaScript and Oreslang-to-Wasm/browser transpilation require independent emitted-artifact tests in a hermetic real browser; native JVM tests or Rust-produced Wasm cannot certify them.

## Checklist (none claimed complete)

- [ ] Exact authored peer inventory, parity receipts and Contract IR
- [ ] Native Oreslang compiler + codec + conformance fixtures
- [ ] Runtime evidence bound to exact inputs and independent negative tests
- [ ] Cross-language/consumer CI, package artifact integrity, release gate
- [ ] Additional browser target proof after compiler exists

This draft intentionally does not modify existing generated sources or turn on a pass-through runtime target.
