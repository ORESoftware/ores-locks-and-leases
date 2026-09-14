# Local-file hardening v2 execution plan

Tracks #58. This file records the second-order hardening work discovered after the bounded-read and crash-window pass so implementation and executable evidence stay tied together.

The fifteen work items are grouped into four independently testable slices:

1. **Persisted-state admission:** bound release reads, bound directory enumeration, reject non-scalar JavaScript owner strings, machine-readable derived byte limits, and centralize local-lock constants.
2. **Filesystem identity and permissions:** revalidate opened owner handles, define existing-root permission policy, evaluate Windows ACL parity, detect permission widening, and harden path-to-handle TOCTOU windows.
3. **API and confidentiality:** retire ambiguous boolean existence checks in favor of tri-state inspection, prove owner tokens are not rendered in errors/telemetry, and provide canonical CSPRNG owner-token helpers.
4. **Operational semantics:** separate crash durability/fsync policy from mutual exclusion and define cancellation/backoff/fairness behavior under contention.

Each slice must add executable evidence before it is marked complete. TypeSpec and authored JSON Schema remain independent peer authorities; TJSV provides admission evidence only. Optional Protobuf/WIT/Dafny projections stay additive.