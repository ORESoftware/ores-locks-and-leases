# Local filesystem locks

`ores-locks-and-leases` has two different coordination domains and deliberately
keeps them separate:

1. **local filesystem locks** for one machine / one local filesystem; and
2. **distributed fenced leases** (Fiducia, Cloudflare Durable Objects, Redis)
   for mutable state shared by more than one host.

Do not pay for a network round trip when the resource being protected only
exists on one workstation. In particular, ordinary zed-pkg installs should use
the local path. The current zed-pkg convention is:

```text
$ZED_PKG_HOME/locks/
```

with `ZED_PKG_HOME` defaulting to `$HOME/.zed-pkg`. `zed-cli` already resolves
its `Store::locks_dir()` to `<zed home>/locks`, so this preserves existing
install/cache compatibility rather than silently migrating the whole store. If
zed-pkg later adopts `$HOME/.zpkg` as a shorter alias, that should be handled as
an explicit home-directory migration/alias rather than as part of locking.

A caller may create lock identities such as `install.lock`, `refs.lock`, or
`artifact-<sha256>.lock` below that private directory.

## Two local implementations

For Rust zed-pkg code, the preferred implementation remains `zed-lock`. It uses
descriptor/handle-backed operating-system locks: the kernel releases ownership
when the process exits, Linux/macOS block in a native file-lock request, and
Windows uses `LockFileEx` semantics. That is stronger than a portable lockfile
protocol and must not be replaced merely for API uniformity.

This repository also exposes a **portable directory lock** in Rust,
TypeScript/Node.js, Go, and Gleam. It is intended for polyglot tools that need a
no-network single-host mutex and cannot share one native descriptor-lock API.
The protocol is deliberately tiny:

1. the caller chooses a lock-directory path (or lock root + one-component name
   in Gleam) and a non-empty per-acquisition owner token;
2. acquisition is the atomic creation of that directory;
3. the holder writes the exact owner token to `owner` inside it;
4. contenders either fail immediately or retry until their wait budget expires;
5. release first verifies the owner token, deletes `owner`, then removes the
   now-empty directory.

Directory creation is the ownership admission primitive. The `owner` file is
not a PID-file lock and is never sufficient to acquire ownership; it protects
release from accidentally deleting a lock that no longer belongs to the same
logical acquisition and provides diagnostics.

The design is in the same family as Node lockfile libraries, and uses atomic
`mkdir` rather than `open(O_EXCL)` because directory creation has useful
cross-platform semantics on Windows, Linux, and macOS.

## Structural corruption is not contention

Ordinary contention means the rendezvous path already exists **as a directory**.
A regular file or symlink at the lock path is not another valid holder and is
reported as `compromised`. Likewise, once a holder exists, a changed or missing
`owner` marker is `compromised`; release does not silently accept externally
altered state.

Release only removes the exact owner marker followed by the now-empty lock
directory. If any unexpected entry remains, release reports `compromised` and
refuses recursive deletion. This invariant is tested on Windows, macOS, and
Linux, including nested Unicode paths.

## Fail-closed crash semantics

The portable backend intentionally does **not** automatically break a lock just
because its PID, timestamp, or mtime appears old. Portable stale-lock breaking
has a dangerous check-then-delete race: a slow but live holder can be mistaken
for a dead one, producing two writers. A process crash can therefore leave a
portable lock directory behind and require explicit recovery.

This is why zed-pkg's Rust hot path should keep using the stronger native
`zed-lock` backend: descriptor/handle ownership disappears automatically when
the process exits. If a future portable stale/heartbeat mode is added, it must
be an explicit lease-like mode with owner-token verification and must not be
confused with a fencing token.

Explicit recovery tooling should inspect and report the lock directory rather
than deleting it implicitly during acquisition. Recovery should require an
operator or higher-level policy decision, then remove only the known lock
structure after confirming no valid local holder can still be using it.

## What local locks do not provide

A local filesystem lock is not a distributed lease and does not mint a fencing
token. It must not be used as the sole authority when two machines can write
the same remote database, object, network filesystem, or other shared mutable
state. In that case acquire the appropriate distributed authority (Fiducia,
Cloudflare Durable Objects, Redis, etc.) and enforce its fencing token at the
protected datastore.

Likewise, an outer distributed lease does not replace the local filesystem
lock when multiple processes on the same host mutate the same local files. In
a mixed deployment the safe order is distributed authority first, then local
filesystem ownership, then the mutation.

## Portable API contract

All four requested runtime slices expose the same concepts:

- `try_acquire`: one immediate atomic attempt;
- `acquire`: optional waiting with a finite timeout and retry interval;
- `release`: owner-checked cleanup;
- an opaque/structured held-lock value carrying `path` and `owner`.

Defaults for the convenience acquisition path are a 30 second wait budget and
a 50 ms retry interval. Callers that want no waiting use `try_acquire` (or
`wait = false`). A zero-millisecond wait budget is valid and returns `timeout`
immediately when the lock is already held. Retry sleeping is specific to this
portable lockfile backend; zed-pkg's native Rust backend continues to use
kernel-backed blocking without a polling loop.

The machine-readable authority for these portable semantics is
`conformance/cases/local-file-lock.json`, with negative vectors in
`conformance/cases/local-file-lock-invalid.json`. The dedicated cross-platform
workflow validates those files before running the Rust, Go, TypeScript, and
Gleam suites.

## Security and path assumptions

Keep the lock root private to the current user. zed-pkg should create
`$ZED_PKG_HOME` / `$ZED_PKG_HOME/locks` with user-private permissions where the
platform supports POSIX modes. Do not put these locks in a world-writable
shared directory and do not use this portable protocol as a substitute for the
hardened path/symlink rules in `zed-lock`.
