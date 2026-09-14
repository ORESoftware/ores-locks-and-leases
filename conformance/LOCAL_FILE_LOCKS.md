# Local filesystem lock conformance

`cases/local-file-lock.json` is the shared, runtime-neutral contract for the portable single-host filesystem backend.

Every maintained Rust, TypeScript/Node.js, Go, and Gleam implementation must agree on:

- atomic directory creation as the admission primitive;
- a non-empty caller-supplied owner token;
- `owner` as the owner-token filename;
- 30 second default wait timeout and 50 millisecond retry interval;
- `contention`, `timeout`, `compromised`, `io`, and `invalid_input` error kinds;
- owner-token verification before release;
- refusal to recursively delete a dirty lock directory;
- no automatic PID-, hostname-, or mtime-based stale-lock breaking.

The corpus is intentionally about portable semantics, not zed-pkg's stronger native Rust locking path. `zed-lock` remains preferable when a descriptor/handle-backed operating-system lock is available because process exit releases ownership automatically.
