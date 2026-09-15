# Local-file public API parity audit (v9)

The four maintained runtimes expose equivalent **capabilities**, while preserving idiomatic language syntax and type visibility.

| Capability | Rust | Go | TypeScript | Gleam |
| --- | --- | --- | --- | --- |
| Immediate acquire | `LocalFileLock::try_acquire` | `TryAcquireLocalFileLock` | `try_acquire_local_file_lock` | `try_acquire` |
| Finite-wait acquire | `LocalFileLock::acquire` | `AcquireLocalFileLock` | `acquire_local_file_lock` | `acquire` |
| Explicit release | `LocalFileLock::release` | `(*LocalFileLock).Release` | `LocalFileLock.release` | `release` |
| Boolean diagnostic | `local_file_lock_exists` | `LocalFileLockExists` | `local_file_lock_exists` | `exists` |
| Structured inspection | recovery module | recovery module | `inspect_local_file_lock` | recovery module |
| Explicit recovery | recovery module | recovery module | `recover_local_file_lock` | recovery module |
| Owner generation | maintained helper/caller CSPRNG | `GeneratedLocalFileLockOwner` | `generated_local_file_lock_owner` | maintained helper/caller CSPRNG |

Intentional differences are not parity failures:

- Rust owns a best-effort `Drop` convenience; observable portable cleanup is still explicit `release`.
- Gleam uses an opaque lock type rather than exposing construction.
- Go follows exported PascalCase naming and pointer receiver conventions.
- TypeScript uses JavaScript promises and snake_case package exports.

The parity invariant is behavioral: callers can attempt, wait, explicitly release, inspect, and explicitly recover with exact owner identity and structured failures in every maintained runtime. Language-specific constructors and destructors are implementation details rather than additional ownership authorities.
