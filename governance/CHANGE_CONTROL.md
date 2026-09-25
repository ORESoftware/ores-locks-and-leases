# Change control

Use this matrix before implementation and again during review. A cell marked
**required when affected** means the pull request must either update that authority
or state why the change provably leaves it unchanged.

| Change class | Formal models | Conformance corpus | Contracts | Runtime slices | Persistence / provider adapters |
| --- | --- | --- | --- | --- | --- |
| lease acquisition / renewal / release semantics | required | required | required when observable shape/vocabulary changes | required | required when authority or datastore behavior changes |
| fencing decision or token semantics | required | required | required | required | required |
| maintained transaction / commit admission | required | required | required when public options/errors change | required | required |
| local filesystem lock semantics | required when a modeled invariant changes | required | required for published local contract changes | required in supported runtimes | not applicable unless a provider boundary changes |
| contract-only shape or vocabulary | required when semantics change | required when behavior changes | required in both peer authorities | required when bindings/behavior change | required when datastore API changes |
| provider integration / service profile | required when ownership or fencing semantics change | required | required when provider-facing contract changes | required where provider is exposed | required |
| refactor with no observable semantic change | must remain green | must remain green | must remain green | required in touched runtimes | required in touched adapters |
| documentation only | no model change | no corpus change | no contract change | no runtime change | no adapter change |

## Semantic-change procedure

A semantic change starts from the invariant, not from an implementation patch.

1. State the old and new invariant or externally observable rule.
2. Add or update a counterexample/witness, bounded model transition, Kani harness,
   or explicit refinement obligation where the safety boundary changes.
3. Add shared conformance vectors that distinguish the old behavior from the new
   behavior when the decision is cross-runtime.
4. Update both authored contract authorities when a published structure,
   enumeration, validation constraint, or vocabulary changes.
5. Update every affected runtime and datastore/provider adapter.
6. Run the exact-head gates in `RELEASE_GATES.md` and retain the required receipts
   or artifacts.

A change is incomplete if one runtime accepts a decision another rejects, if one
peer contract accepts data the other rejects, or if a protected datastore can admit
a stale token that the model claims is rejected.

## Breaking changes

Breaking changes to lock-plan steps, error kinds, fencing decisions, token
representation, key derivation, lease identity, or cleanup precedence require an
explicit migration plan. Compatibility aliases may be temporary, but the
conformance corpus and contracts must make the transition unambiguous.

Do not silently reuse an existing enum value or error kind for new semantics.
Ambiguity at an API boundary is a safety defect because callers may retry an
operation whose ownership state is unknown.

## Exceptions

There is no documentation-only bypass for a semantic safety change. Emergency
changes may reduce scope, but they still need the evidence required for the behavior
they alter. If a required gate cannot execute because infrastructure is unavailable,
record the infrastructure block and keep the change unadmitted rather than treating
missing evidence as success.
