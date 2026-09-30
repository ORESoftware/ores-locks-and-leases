# client-safe lease/fencing semantics

Driver: `ORESoftware/ores-locks-and-leases#123`

This document captures one bounded review contract for the driver issue. It is intentionally independent of the remaining implementation work.

## Invariants

- Successful acquisition returns a holder/lease identity plus monotonic fencing token, never a bare boolean.
- Renew/release operations prove the current holder/generation and reject superseded holders.
- Busy/contended results may expose only bounded retry metadata.
- Backends that cannot provide a required semantic guarantee return an explicit unsupported-capability result.

## Verification

- Verify against the exact PR head with normal repository gates.
- Add negative tests before expanding authority or accepting new input classes.
- Keep cross-runtime/public semantics aligned with their canonical authority.
- Treat skipped/zero-step CI as missing evidence.

## Non-goals

This slice does not add credentials, weaken isolation, or declare full fleet rollout complete.
