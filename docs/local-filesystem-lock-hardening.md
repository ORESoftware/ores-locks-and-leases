# Local filesystem lock hardening checklist

This checklist tracks follow-up hardening for the portable single-host backend.

- [x] Shared runtime-neutral conformance contract.
- [x] Negative vectors for empty owner, zero-timeout contention, and no-wait contention.
- [ ] Rust consumes the conformance contract.
- [ ] TypeScript consumes the conformance contract.
- [ ] Go consumes the conformance contract.
- [ ] Gleam consumes the conformance contract.
- [ ] Missing owner marker release fails closed in every runtime.
- [ ] Existing-file-at-lock-path is classified consistently.
- [ ] Unicode lock paths pass on Linux, macOS, and Windows.
- [ ] Nested parent creation is covered in every runtime.
- [ ] Zero-timeout behavior is covered in every runtime.
- [ ] Convenience scoped-lock helper exists in every runtime.
- [ ] Cross-platform workflow watches conformance files.
- [ ] zed-pkg integration guidance points to native `zed-lock` first.
- [ ] Crash/stale-lock recovery tradeoffs are documented explicitly.
