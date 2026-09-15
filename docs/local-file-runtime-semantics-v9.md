# Local-file runtime semantics (v9)

This note records the intentionally portable semantics of the dependency-free local filesystem lock backend. TypeSpec and authored JSON Schema remain independent peer authorities for wire-shaped data; this document covers runtime/process behavior that is not naturally expressible as a schema.

## Owner-token lexical policy

Owner tokens are opaque identity strings. Maintained runtimes admit a non-empty valid Unicode scalar string of at most 512 code points and compare it exactly. They do **not** trim, case-fold, NFC/NFD-normalize, interpret bidi/zero-width controls, or assign PID/time meaning to the token. Control characters are therefore data when the calling API/transport can represent them. Process-command probes cannot represent an embedded NUL argv element, but the owner-token policy itself does not add a second normalization layer.

Paths are different: the portable path boundary rejects empty and embedded-NUL paths, because those cannot be handed to host filesystem APIs without ambiguity.

## Relative paths and current working directory

The backend intentionally does not canonicalize or absolutize caller paths. A relative lock path is resolved by the host filesystem relative to the process current working directory at each operation. Therefore a held lock created from a relative path has a **stable-CWD requirement**: callers must not change the process working directory between acquisition, inspection/recovery, and release of that relative lock object.

Applications that cannot guarantee a stable working directory should pass an absolute path. The ninth-order process matrix proves stable-CWD relative acquisition/release and absolute/relative alias contention without adding library-side normalization.

## Filesystem and mount-namespace scope

A local-file lock coordinates only processes that resolve the rendezvous to the same underlying filesystem namespace. It is not a distributed lease and makes no claim across containers, mount namespaces, chroots, remote hosts, or independently mounted copies that merely share the same textual path. Callers needing cross-host or cross-namespace coordination must use Fiducia or another distributed provider.

The library intentionally relies on the host filesystem for `.`/`..`, repeated-separator, case-sensitivity, and Unicode filename identity. It does not invent a second pathname-normalization algorithm.

## Process cloning / fork semantics

Held in-memory lock objects are process-local capabilities. Applications must acquire locks **after** creating worker processes. A raw OS fork/clone of a process that already owns a lock is outside the portable lifecycle contract: the child must not call release/drop cleanup on the inherited object and must not treat the copied owner token as an independently acquired lease.

This matters most for Rust because `LocalFileLock` has best-effort `Drop` cleanup. Forking with a live Rust lock object and then allowing the child copy to drop would duplicate cleanup authority. The supported pattern is fork/spawn first, then acquire independently in the process that will own the critical section.

## Rust `Drop` versus explicit release

Rust intentionally offers best-effort `Drop` cleanup as an ergonomic language-specific safeguard. `Drop` cannot surface cleanup errors, so it is **not** the portable success contract. Call `release()` when the caller must observe whether cleanup succeeded.

Go, TypeScript, and Gleam require explicit release in their maintained APIs. Cross-runtime code must therefore model explicit release as the portable lifecycle primitive; Rust `Drop` is additive convenience, not stronger ownership semantics.

## Recovery and ABA owner reuse

Recovery authenticates the persisted owner identity; it cannot infer whether a caller has improperly reused the exact same token for a later logical acquisition. Generated owner identities must therefore be fresh per acquisition. Operator tooling must never recycle an old owner token as a convenience value.

The ninth-order matrix proves the safe side of this rule: after an old crash-held lock is recovered and the rendezvous is reacquired with a fresh owner, stale recovery authority using the old token fails closed and cannot delete the fresh acquisition.

## Inspection during live transitions

Inspection is read-only and must remain within the closed state model during concurrent clean release: `held`, `incomplete`, or `absent`. A normal live acquire/release transition must not manufacture `compromised` solely because an observer raced an expected deletion boundary. The ninth-order matrix staggers dozens of inspections across every maintained runtime holder's release transition to exercise this rule.

## Public API surface parity

Names follow each language's conventions, but the maintained portable surface is intentionally isomorphic at the capability level:

| Capability | Rust | Go | TypeScript | Gleam |
| --- | --- | --- | --- | --- |
| immediate acquire | `LocalFileLock::try_acquire` | `TryAcquireLocalFileLock` | `try_acquire_local_file_lock` | `try_acquire` |
| finite-wait acquire | `LocalFileLock::acquire` | `AcquireLocalFileLock` | `acquire_local_file_lock` | `acquire` |
| explicit release | `release` | `Release` | `release` | `release` |
| existence diagnostic | `local_file_lock_exists` | `LocalFileLockExists` | `local_file_lock_exists` | `exists` |
| structured inspection | maintained recovery module | maintained recovery module | `inspect_local_file_lock` | maintained recovery module |
| explicit recovery | maintained recovery module | maintained recovery module | `recover_local_file_lock` | maintained recovery module |
| generated owner | Rust helper / caller CSPRNG | `GeneratedLocalFileLockOwner` | `generated_local_file_lock_owner` | caller/runtime helper |

Language-specific constructor visibility, opaque types, method syntax, and best-effort destructors are not required to be textually identical. What must remain portable is acquisition authority, exact owner identity, fail-closed diagnostics/recovery, and explicit observable release.
