# Local filesystem lock hardening checklist

This checklist tracks follow-up hardening for the portable single-host backend.

- [x] Shared runtime-neutral conformance contract.
- [x] Negative vectors for empty owner, zero-timeout contention, and no-wait contention.
- [x] Cross-platform CI validates the conformance corpus before every runtime suite.
- [x] Missing owner marker release fails closed in Rust.
- [x] Missing owner marker release fails closed in TypeScript/Node.js.
- [x] Missing owner marker release fails closed in Go.
- [x] Missing owner marker release fails closed in Gleam.
- [x] Existing regular-file-at-lock-path is `compromised` rather than contention in Rust.
- [x] Existing regular-file-at-lock-path is `compromised` rather than contention in TypeScript/Node.js.
- [x] Existing regular-file-at-lock-path is `compromised` rather than contention in Go.
- [x] Existing regular-file-at-lock-path is `compromised` rather than contention in Gleam.
- [x] Unicode/nested lock paths are covered in Rust.
- [x] Unicode/nested lock paths are covered in TypeScript/Node.js.
- [x] Unicode/nested lock paths are covered in Go.
- [x] Unicode/nested lock paths are covered in Gleam.
- [x] Zero-timeout behavior is covered in all four runtimes.
- [x] Cross-platform workflow watches conformance files and the corpus validator.
- [x] zed-pkg integration guidance points to native `zed-lock` first.
- [x] Crash/stale-lock recovery tradeoffs are documented explicitly.
- [ ] Add an optional scoped `with_local_file_lock` convenience helper only after defining identical work-vs-cleanup error precedence across runtimes.
- [ ] Add explicit, operator-driven stale-lock inspection/recovery tooling without automatic PID/mtime stealing.
- [ ] Add symlink/reparse-point adversarial tests for the portable parent/root path, especially on Windows.
