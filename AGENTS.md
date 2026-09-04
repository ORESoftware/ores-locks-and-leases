# ores-locks-and-leases — agent notes

This is a shared fleet crate on the `ores-transport` / `ores-proximity`
precedent: every `*-lib-core` consumes it through zed-pkg. A change here
changes every org, so:

* **The plan is the contract.** `plan(layers, scope, wait)` in each slice must
  match `conformance/cases/lock-plan.json` step for step. Fiducia is always
  the outermost layer; the Postgres advisory lock is inside it; `work` is
  innermost. Do not add a layer or reorder one without changing the corpus
  first and every slice with it.
* **Key derivation is pinned.** `conformance/cases/advisory-key.json` holds
  the FNV-1a 64 vectors. A different hash in one slice means two runtimes
  lock different integers for the same key — silently. Regenerate vectors
  with the Python snippet in `conformance/README.md`, never by hand.
* **Error kinds and step names are a published vocabulary** (`LockErrorKind`,
  `LockStep` in `contracts/`). Renaming one breaks every consumer's
  `match`/`switch`.
* **`transport` is not `contention`.** A failed call to the lease authority
  leaves ownership unknown. Never map it to "not held" — that is the
  two-leader bug.
* **Session scope needs one physical connection.** Every slice enforces it
  with a type or a checked-out handle; do not "simplify" that into a pooled
  call.
* **The Rust core stays dependency-free.** `key`, `plan`, `error`, `lease`
  compile with `rustc lib.rs` alone; SeaORM and the fiducia client are
  optional features. Keep it that way so `*-pub-lib-core` packages can use
  the key/plan logic on clients.
* **Contracts are dual-authored.** `contracts/typespec/main.tsp` and
  `contracts/json-schema/contract.schema.json` are peers; run
  `npx ores-contracts check --config contracts/contracts.config.json` after
  touching either. Neither is generated from the other.
* Toolchains: Rust 1.85+, Go 1.22+, Node 18+, Dart 3.3+, Gleam 1.6+.
  `sh scripts/test-all.sh` runs what is installed.

<!-- BEGIN ores-agents-pointer: managed by ORESoftware/my-ai; edit there, not here -->

## Canonical agent instructions

Before doing anything else in this repository, also read:

    .ores/agents/AGENTS.md

That path is a symlink to `~/codes/oresoftware/my-ai/AGENTS.md`, whose canonical copy is
<https://github.com/ORESoftware/my-ai/blob/main/AGENTS.md>.

It exists at a fixed path *inside* the repository because some agents cannot walk up past
the repository root, so machine-wide instructions one or more directories above are
invisible to them. This pointer plus that path make the same file reachable from a working
directory anywhere in the tree.

The symlink is deliberately **not committed**: it names an absolute path that is only valid
on a machine with `~/codes/oresoftware/my-ai` checked out, so committing it would produce a
broken link for everyone else and for CI. `.ores/` is git-ignored for that reason. If
`.ores/agents/AGENTS.md` is missing on your machine, create it with:

    mkdir -p .ores/agents
    ln -sfn "$HOME/codes/oresoftware/my-ai/AGENTS.md" .ores/agents/AGENTS.md

or run `~/codes/oresoftware/my-ai/scripts/link-repo-agents.sh` once to do it for every git
repository under `~/codes`, and `--check` to verify them.

A missing `.ores/agents/AGENTS.md` is a setup gap on the reader's machine, never a reason to
skip the canonical instructions: fetch them from the URL above instead.

<!-- END ores-agents-pointer -->
