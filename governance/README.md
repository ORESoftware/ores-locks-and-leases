# Governance

This directory defines how changes to `ores-locks-and-leases` are admitted. It does
not replace the technical authorities elsewhere in the repository; it explains how
they fit together and which evidence is required before a change is considered safe.

## Authority model

| Area | Authority |
| --- | --- |
| `formal/` | safety properties, bounded exhaustive models, proof harnesses, and refinement obligations |
| `conformance/` | executable cross-runtime decision vectors and provider behavior that implementations must agree on |
| `contracts/` | independently authored TypeSpec and JSON Schema peer authorities plus admitted projections |
| runtime/persistence code | concrete implementation and atomic datastore enforcement |
| `governance/` | change classification, review requirements, and release/admission rules |

No single area is sufficient by itself. Contract parity cannot prove fencing
atomicity; a formal abstraction cannot prove that every runtime refines it; native
tests cannot redefine a published contract; and conformance examples cannot replace
a safety invariant.

## Governing principles

1. **Safety evidence is exact-head evidence.** A result from another commit, a
   synthetic merge commit, a skipped relevant lane, or a workflow that executed no
   proof/test steps does not admit the pull request head.
2. **Unknown ownership fails closed.** Transport ambiguity, lease loss, token drift,
   or failed cleanup must not be converted into contention-free success.
3. **Cross-runtime behavior changes are atomic changes.** Update the shared corpus
   first or in the same pull request, then every affected runtime and datastore
   adapter.
4. **TypeSpec and JSON Schema remain peer authorities.** Neither is generated from
   or allowed to overwrite the other; TJSV proves parity and emits disposable
   comparison evidence.
5. **Fencing is enforced where state is mutated.** Client-side checks are useful
   evidence but are not a substitute for an atomic protected-datastore decision.
6. **Formal bounds and nonclaims remain explicit.** Increasing a bound is allowed;
   deleting a counterexample or weakening an invariant to make a check pass is not.
7. **Breaking vocabulary changes are deliberate.** Published error kinds, step
   names, token representation, and contract declarations require coordinated
   migration rather than silent renaming.

The practical mapping from change type to required evidence is in
[`CHANGE_CONTROL.md`](CHANGE_CONTROL.md). The merge/release gate inventory is in
[`RELEASE_GATES.md`](RELEASE_GATES.md).

Tracked by #108.
