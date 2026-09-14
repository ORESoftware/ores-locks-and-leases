# Local filesystem lock conformance

`cases/local-file-lock.json` is the shared, runtime-neutral contract for the portable single-host filesystem backend.

Every maintained Rust, TypeScript/Node.js, Go, and Gleam implementation must agree on:

- atomic directory creation as the admission primitive;
- a non-empty caller-supplied owner token of at most **512 Unicode code points**;
- `owner` as the owner-token filename;
- owner-marker inspection reads are bounded to **2048 bytes** before UTF-8 decoding, because 512 Unicode scalar values require at most 2048 UTF-8 bytes; invalid UTF-8 or a larger persisted marker is `compromised`;
- private owner-token contents on POSIX: the marker must expose no group/other permission bits, while mode bits remain hardening rather than an ownership primitive;
- 30 second default wait timeout and 50 millisecond retry interval;
- retry intervals are non-negative; `0` is valid only when `wait=false`, while waiting requires a positive retry interval;
- TypeScript millisecond options must also be JavaScript safe integers so TypeSpec `int64` values cannot silently round at the runtime boundary;
- `contention`, `timeout`, `compromised`, `io`, and `invalid_input` error kinds;
- owner-token verification before release;
- persisted empty, invalid-UTF-8, over-byte-bound, or over-code-point owner state is `compromised`, while caller-supplied over-bound owner input is `invalid_input`;
- refusal to recursively delete a dirty lock directory;
- no automatic PID-, hostname-, or mtime-based stale-lock breaking.

String bounds are counted as Unicode code points/scalars rather than UTF-8 bytes or JavaScript UTF-16 code units. This keeps runtime admission aligned with the independently authored TypeSpec and JSON Schema string constraints. The 2048-byte owner-marker storage bound is a defensive persistence/read bound derived from the 512-code-point public contract; it is not a second schema authority.

This portable protocol assumes a **local filesystem whose same-directory `mkdir` operation is atomic for competing processes on one host**. It must not be advertised as a correctness authority on NFS/SMB/FUSE/network filesystems or other mounts whose directory-creation, cache-coherency, identity, or durability semantics are weaker or atypical. Consumers that need multi-host/shared-storage coordination must use a fenced distributed authority instead.

Path alias checking intentionally protects the lock rendezvous, its immediate parent, and the owner marker where each runtime can inspect those identities safely. It does not claim to prove the identity of every ancestor above the immediate parent. Deployments should therefore place the lock root under a trusted local directory such as the application's private home/state directory rather than beneath attacker-controlled or remotely remapped ancestors.

`LocalFileLockPath`'s authored `maxLength: 4096` is a **wire/serialization admission bound**, not a promise that every operating system accepts a path of that length. Native path limits remain platform- and filesystem-specific and may be lower; an OS path rejection is an `io` failure. Runtimes must not truncate, normalize, or rewrite a path merely to fit the schema bound.

The corpus is intentionally about portable semantics, not zed-pkg's stronger native Rust locking path. `zed-lock` remains preferable when a descriptor/handle-backed operating-system lock is available because process exit releases ownership automatically.
