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

## Source-current browser/JS/Wasm alignment (audit baseline 2026-10-11)

- Java/GraalVM reference compiler: `ores-truffle-oreslang/oreslang-source.java@a69035665047b4007ef3058cb4bd59aca8a8b8d1` (verified `main` audit snapshot, not a floating compatibility claim).
- Wasm infrastructure: `oreslang-wasm@0691ddcb5e66d5c54a73ed5da4e26e554098b980`; browser loader: `oreslang-browser@3944cc8b10c4fd688e3bec9f533090454d810a22`.
- Target admission and test tools: `oreslang-target-profiles@c0975d7b286eeaa4cc7aab3b0745224130d74a8f`, `oreslang-platform-conformance@b6c5a112a509a8d56479cc802b4c6d72e05fbebf`.
- These are **separate backends/tools**, not proof of complete source-to-JavaScript transpilation or complete Oreslang source-to-Wasm support. The Wasm runtime/loader and native compiler bridge are partial; execute each real compiler backend and browser host before admission. A Rust-Wasm adapter passing does not certify Oreslang-Wasm.
- Maintain source-language semantics and behavior across Java/GraalVM and the JS/Wasm targets: typed public ABI, consistent event/error outcomes, owned/borrowed value lifetimes, cancellation, scheduler fairness, byte-exact serialization, resource bounds, and explicit host capability grants. Use the same immutable positive/negative fixtures and contract receipts, and label unsupported operations as hard failures.
- Neither a browser-target profile nor a WIT/JS stub establishes frontend support. Every release must re-verify the then-current pinned compiler SHA and exact compiled guest artifact hash; never infer it from moving `main`.

Browser/client lane: allow deterministic lock-key composition, FNV-1a routing vectors, lease metadata parsing, and fencing-token validation only. Network lock acquisition, Postgres advisory locks, authoritative fencing-token minting, and physical connection/session ownership must remain explicit server-side host ports. Browser JS Numbers must not silently round unsigned 64-bit tokens: use lossless decimal text or BigInt at the boundary.
