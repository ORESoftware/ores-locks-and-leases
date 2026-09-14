# Portable local lock inspection and recovery

Portable mkdir-based locks deliberately do **not** use PID age, mtime age, or
host-name heuristics to steal a lock. Those heuristics have a check/delete race
that can create two writers.

`conformance/cases/local-file-recovery.json` defines two separate operations:

- **inspection** is read-only and never claims ownership; and
- **recovery** is an explicit operator action, never an automatic acquisition
  fallback.

## Inspection

A lock is `absent`, `held`, or `compromised`.

A clean held lock is a real directory containing exactly one regular `owner`
file with a non-empty owner token. A missing owner marker, unexpected entry,
non-directory rendezvous node, symbolic-link owner marker, or ambiguous path
identity is compromised state rather than ordinary contention.

Inspection is diagnostic evidence only. Seeing `held` does not prove the owner
process is alive; seeing an old timestamp does not prove it is dead.

## Recovery safety contract

Destructive recovery requires both:

1. an explicit `confirmed_inactive`/equivalent operator intent; and
2. the exact expected owner token observed during inspection.

Before invoking recovery, independently establish that the former owner is no
longer executing protected work and that the local protected state is
quiescent. Recovery must re-check the owner and directory shape immediately
before deletion, remove only the `owner` file, then remove only the now-empty
lock directory. It must never recursively delete unexpected contents.

If the path is already absent, recovery is an idempotent no-op. Owner mismatch,
missing owner, unexpected entries, symlinks/reparse points, or other ambiguous
identity must fail closed as `compromised`.

## Native zed-lock is different

This recovery protocol is only for the portable mkdir backend. zed-pkg's Rust
hot path should continue to prefer `zed-lock`, whose descriptor/handle-backed
OS ownership is released by the kernel when the process exits. Do not layer
portable stale-lock heuristics on top of that stronger native mechanism.
