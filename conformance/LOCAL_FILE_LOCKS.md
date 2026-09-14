# Local filesystem lock conformance

`cases/local-file-lock.json` is the shared, runtime-neutral contract for the portable single-host filesystem backend.

Every maintained Rust, TypeScript/Node.js, Go, and Gleam implementation must agree on:

- atomic directory creation as the admission primitive;
- a non-empty caller-supplied owner token of at most **512 Unicode code points**;
- `owner` as the owner-token filename;
- private owner-token contents on POSIX: the marker must expose no group/other permission bits, while mode bits remain hardening rather than an ownership primitive;
- 30 second default wait timeout and 50 millisecond retry interval;
- retry intervals are non-negative; `0` is valid only when `wait=false`, while waiting requires a positive retry interval;
- `contention`, `timeout`, `compromised`, `io`, and `invalid_input` error kinds;
- owner-token verification before release;
- persisted empty or over-bound owner state is `compromised`, while caller-supplied over-bound owner input is `invalid_input`;
- refusal to recursively delete a dirty lock directory;
- no automatic PID-, hostname-, or mtime-based stale-lock breaking.

String bounds are counted as Unicode code points/scalars rather than UTF-8 bytes or JavaScript UTF-16 code units. This keeps runtime admission aligned with the independently authored TypeSpec and JSON Schema string constraints.

The corpus is intentionally about portable semantics, not zed-pkg's stronger native Rust locking path. `zed-lock` remains preferable when a descriptor/handle-backed operating-system lock is available because process exit releases ownership automatically.
