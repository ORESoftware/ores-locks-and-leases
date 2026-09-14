# Local-file hardening v2 acceptance matrix

Issue: #58

| ID | Area | Executable acceptance |
|---|---|---|
| H2-01 | release reads | hostile owner marker larger than derived byte ceiling is rejected without an unbounded read |
| H2-02 | directory enumeration | inspection consumes at most two entries before rejecting dirty state |
| H2-03 | JS Unicode scalars | lone high/low surrogate owner input is `invalid_input` |
| H2-04 | derived bound | shared corpus exposes owner max code points and derived UTF-8 bytes and checker verifies the derivation |
| H2-05 | constants | acquire/release/inspection use one runtime-local constant set |
| H2-06 | opened-handle identity | owner handle metadata is checked after open where runtime APIs expose it |
| H2-07 | root permissions | existing-root trust policy is explicit and POSIX probes cover unsafe writable roots |
| H2-08 | Windows ACLs | Windows privacy probe documents/enforces the chosen DACL policy |
| H2-09 | permission widening | post-acquire mode/ACL widening has an explicit fail-closed or documented policy |
| H2-10 | TOCTOU | parent/rendezvous replacement probes exercise path-to-handle race defenses |
| H2-11 | exists API | tri-state inspection is canonical; boolean existence cannot bless malformed state |
| H2-12 | confidentiality | owner tokens do not appear in structured errors or telemetry-safe diagnostics |
| H2-13 | CSPRNG identities | canonical helper emits fresh cryptographically random owner identities |
| H2-14 | durability | fsync/power-loss durability is documented separately from mutual exclusion |
| H2-15 | pressure control | local waits have explicit cancellation and fairness/backoff semantics with tests |

A task is not complete merely because it appears in this matrix. Completion requires the corresponding runtime/conformance test or a platform probe when the capability is platform-specific.