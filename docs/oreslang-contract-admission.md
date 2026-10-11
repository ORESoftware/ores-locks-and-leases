# Oreslang runtime participant candidate (draft)

Repository `ORESoftware/ores-locks-and-leases`; existing contracts/governance:
- `contracts/`
- `conformance/`
- `formal/`
- `governance/`
- `src/`

**State:** proposed but **NOT** an admitted Oreslang implementation. This draft
does not register an unimplemented participant or change existing governing
JSON, native package manifests or release matrices.

## Obligations

1. Select independently authored TypeSpec and JSON Schema Draft 2020-12 peer
   authorities, record complete source closure + immutable revisions, and run
   TJSV current-input parity + Contract IR. For persistence-bearing records,
   also run `ORESoftware/ores-contracts check`; no fake persistence projections
   for transport-only contracts.
2. Implement the same native Oreslang public surface and semantics, including
   fencing tokens, lease expiry, renewal, cancellation, fairness and mutually exclusive lock ownership.
3. Compile/run a real GraalVM/JVM Oreslang implementation, with positive and
   negative fixtures for ingress, egress, invalid names/payloads, missing/null
   fields, overflow, retry/failure, cancellation, and concurrency races.
4. Check runtime output against existing implementation languages with bounded
   state-machine/model tests where concurrency permits. Preserve operation
   names, ordering, error envelopes and transport semantics; generated
   declarations alone do not establish behavioral compatibility.
5. Submit TJSV runtime and language-boundary receipts **bound to exact inputs**:
   head SHA, Contract IR identity, fixture input SHA-256 digests, toolchain,
   ingress/egress verdicts and artifact identity. Refuse zero-step CI,
   missing/duplicate adapters and stale conformance evidence.
6. Update *all* participant/governance mirrors, `.zpkg.toml` targets and CI
   simultaneously only when Oreslang runtime adapter + actual tests exist.
   Fail closed until every declared language target is exercised.
7. Maintain separate future `javascript-browser` and `wasm-browser`
   variants with real cross-compiler and sandbox/no-ambient-host-access tests.

Draft exit gate: implementation, compiler test, exact-source schema parity,
positive/negative differential corpus, concurrency semantics and executed CI.

This document is **admission scaffolding**; it deliberately makes no supported
language claim and never modifies human-authored contracts.
