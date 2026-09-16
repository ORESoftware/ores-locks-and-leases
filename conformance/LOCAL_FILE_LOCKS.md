# Local filesystem lock conformance

`cases/local-file-lock.json` is the shared, runtime-neutral contract for the portable single-host filesystem backend.

Every maintained Rust, TypeScript/Node.js, Go, and Gleam implementation must agree on:

- atomic directory creation as the admission primitive;
- a non-empty caller-supplied owner token of at most **512 Unicode code points**;
- `owner` as the canonical, published owner-token filename;
- owner publication is reader-safe: acquisition writes a private provisional `owner.pending`, completes the write and available flush/close barrier, then atomically renames it to `owner`; a lone `owner.pending` is `incomplete` and is never ownership authority;
- owner-marker inspection reads are bounded to **2048 bytes** before UTF-8 decoding, because 512 Unicode scalar values require at most 2048 UTF-8 bytes; invalid UTF-8 or a larger persisted marker is `compromised`;
- private owner-token contents on POSIX: the marker must expose no group/other permission bits, while mode bits remain hardening rather than an ownership primitive;
- 30 second default wait timeout and 50 millisecond retry interval;
- finite wait timeout is **end-to-end**: time spent in filesystem attempts consumes the same monotonic budget as retry sleeps;
- retry intervals are non-negative; `0` is valid only when `wait=false`, while waiting requires a positive retry interval;
- TypeScript millisecond options must also be JavaScript safe integers so TypeSpec `int64` values cannot silently round at the runtime boundary;
- `contention`, `timeout`, `compromised`, `io`, and `invalid_input` error kinds;
- owner-token verification before release;
- persisted empty, invalid-UTF-8, over-byte-bound, or over-code-point owner state is `compromised`, while caller-supplied over-bound owner input is `invalid_input`;
- refusal to recursively delete a dirty lock directory;
- no automatic PID-, hostname-, or mtime-based stale-lock breaking.

String bounds are counted as Unicode code points/scalars rather than UTF-8 bytes or JavaScript UTF-16 code units. This keeps runtime admission aligned with the independently authored TypeSpec and JSON Schema string constraints. The 2048-byte owner-marker storage bound is a defensive persistence/read bound derived from the 512-code-point public contract; it is not a second schema authority.

This portable protocol assumes a **local filesystem whose same-directory `mkdir` and same-directory rename operations are atomic for competing processes on one host**. It must not be advertised as a correctness authority on NFS/SMB/FUSE/network filesystems or other mounts whose directory-creation, rename, cache-coherency, identity, or durability semantics are weaker or atypical. Consumers that need multi-host/shared-storage coordination must use a fenced distributed authority instead.

Path alias checking intentionally protects the lock rendezvous, its immediate parent, and the owner marker where each runtime can inspect those identities safely. It does not claim to prove the identity of every ancestor above the immediate parent. Deployments should therefore place the lock root under a trusted local directory such as the application's private home/state directory rather than beneath attacker-controlled or remotely remapped ancestors.

`LocalFileLockPath`'s authored `maxLength: 4096` is a **wire/serialization admission bound**, not a promise that every operating system accepts a path of that length. Native path limits remain platform- and filesystem-specific and may be lower; an OS path rejection is an `io` failure. Runtimes must not truncate, Unicode-normalize, case-fold, or otherwise rewrite an admitted path merely to fit the schema bound.

## Publication and inspection state

The lock directory itself is the admission authority. Owner publication is a second, diagnostic/authentication transition after the winning `mkdir`:

1. create the private lock directory atomically;
2. create private `owner.pending` exclusively;
3. write the complete owner token and perform the runtime's available sync/close publication barrier;
4. atomically rename `owner.pending` to canonical `owner`;
5. only then return a held lock capability.

Read-only inspection therefore has four coarse states: `absent`, `held`, `incomplete`, and `compromised`. `held` requires exactly one canonical `owner` marker with a valid complete owner value. An empty directory, a lone `owner.pending`, or owner disappearance during a live acquire/release transition is `incomplete`, never `held`. Dirty directories, aliasing, invalid owner representation, widened permissions where enforced, or other structural violations are `compromised`.

The machine-readable inspection reason vocabulary is shared across runtime surfaces and the two independent authored authorities: `owner_marker_missing`, `path_not_directory`, `dirty_directory`, `owner_not_regular_file`, `owner_too_large`, `owner_invalid_utf8`, `owner_identity_changed`, `permissions_widened`, and `owner_contract_violation`. Human messages may add detail, but callers that automate diagnostics should key off the reason code rather than parse prose.

## Release lifecycle

Release has a non-destructive verification phase followed by destructive cleanup. A verification/preflight failure leaves the handle logically `held`: for example, discovering an unexpected extra directory entry must not remove the owner marker. Once the canonical owner marker has been removed, however, failure to remove the lock directory is a **terminal partial release**. Retrying that same logical holder as if it were still fully held would be misleading because its release authentication marker is already gone.

Rust, Go, and TypeScript retain the original terminal cleanup error in their mutable holder state and return it on subsequent release attempts. Gleam's holder is immutable, so `release_with_state` returns `ReleaseFailedPartial(original_error)` explicitly; callers must discard that handle after observing the terminal partial outcome. The compatibility `release` function still returns the underlying error.

## Windows path admission

Win32 accepts or normalizes several path spellings that can collapse distinct strings onto one filesystem identity. To avoid ambiguous rendezvous names, Windows implementations reject these spellings as `invalid_input` before filesystem mutation:

- verbatim/device/NT namespace prefixes such as `\\?\\`, `\\.\\`, and `\??\`;
- reserved device components `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, and `LPT1`–`LPT9`, including ordinary extensions such as `NUL.txt`;
- path components ending in `.` or space;
- alternate-data-stream syntax (`:`) except for the ordinary drive designator such as `C:`.

These restrictions are Windows-only. The same literal characters retain normal filesystem meaning on POSIX where otherwise admitted. Drive-letter and ordinary UNC paths remain usable subject to the component rules above. The Windows process matrix exercises this policy through Rust, Go, Node.js, and Gleam probes rather than relying only on unit tests.

## Reentrancy and owner identity

Owner equality is release authentication only; it never creates recursive/reentrant ownership. Reacquiring one held rendezvous with the same owner token is ordinary contention. Owner comparison is exact runtime string/UTF-8 identity and is never NFC/NFD normalized, case-folded, trimmed, or otherwise rewritten. Normalization-equivalent but byte-distinct owner values therefore do not authenticate one another.

## Scoped callbacks and fatal control flow

Scoped helpers guarantee release after ordinary callback success/failure according to each runtime's structured error model. Fatal control flow is intentionally runtime-specific rather than pretending every language has one common exception model:

- **Rust:** a panic is not normalized into `ScopedLocalFileLockError`; normal stack unwinding drops the held `LocalFileLock`, whose `Drop` path performs best-effort release. Abort builds/process aborts cannot run cleanup.
- **Go:** a panic is not normalized into a scoped work error; `defer` performs best-effort release while the original panic keeps precedence.
- **TypeScript/Node.js:** synchronous throws and rejected promises from the callback are captured as the scoped `work` failure, release is attempted exactly once, and the work failure is preserved. Process termination/abort cannot be guaranteed to run cleanup.
- **Gleam/BEAM:** the structured helper contract covers `Result`-returned work failures. Arbitrary BEAM process exits/exceptions are outside the portable structured contract; callers requiring stronger cleanup guarantees must supervise the process and reacquire/recover explicitly rather than assuming an unwind hook.

These guarantees are deliberately **best effort**, not durability or distributed fencing. They do not weaken the rule against heuristic stale stealing after a process dies mid-transition.

The corpus is intentionally about portable semantics, not zed-pkg's stronger native Rust locking path. `zed-lock` remains preferable when a descriptor/handle-backed operating-system lock is available because process exit releases ownership automatically.
