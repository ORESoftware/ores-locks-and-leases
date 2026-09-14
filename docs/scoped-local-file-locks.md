# Scoped local filesystem lock semantics

`with_local_file_lock` is the structured convenience layer around the portable
single-host lock backend. Its semantics are shared across Rust, TypeScript,
Go, and Gleam and are pinned by
`conformance/cases/local-file-scoped.json`.

## Ordered phases

1. acquire the local lock;
2. execute the caller's structured work callback exactly once;
3. attempt release exactly once after a successful acquisition; and
4. preserve both work and release failures when both occur.

Work is never invoked when acquisition fails.

## Error precedence

The helper distinguishes four structured outcomes:

- `success`: work and release both succeeded;
- `lock_error`: acquisition failed, or work succeeded and release failed;
- `work_error`: work failed and release succeeded; and
- `work_and_release_error`: work failed and release also failed. Both failures
  must remain inspectable; cleanup ambiguity must never erase the work failure
  and the work failure must never hide a compromised release.

This is deliberately different from a naive `finally`/`defer` wrapper that can
silently replace one error with another.

## Fatal panics and runtime aborts

The helper only normalizes structured callback results/errors. A Rust panic,
Go panic, BEAM process crash, or comparable fatal runtime condition is not
converted into a normal work error. Normal runtime unwinding/finalization may
attempt cleanup, but the original fatal condition keeps precedence. Callers
that need deterministic cross-runtime error transport must return a structured
work error instead of using a fatal condition for expected control flow.

## Local only

This helper does not mint fencing tokens and does not make a local filesystem
lock safe across hosts. If the protected mutation also needs distributed
authority, acquire the distributed/fenced authority first, then the local lock,
then perform the mutation.
