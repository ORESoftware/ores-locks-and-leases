# Local filesystem lock path identity

A filesystem node that merely resolves to a directory is not automatically a
safe lock rendezvous. The portable backend must distinguish an ordinary real
directory from aliases that can redirect ownership checks.

`conformance/cases/local-file-path-identity.json` pins these fail-closed rules:

- a regular file at the rendezvous path is `compromised`;
- a symlink/reparse-point at the rendezvous path is `compromised`;
- a symlink/reparse-point used as the immediate lock parent is `compromised`;
- a symbolic-link owner marker is `compromised` and must never be followed;
- name-based helpers reject `/`, `\\`, `.`, and `..`; and
- release/recovery never recursively deletes a directory to paper over
  ambiguous identity.

Acquisition classifies an existing lock root before attempting recursive
directory creation. That ordering is part of the contract: a pre-existing
symlink, junction, or other alias must be reported as `compromised`, not passed
to a convenience `mkdir -p` equivalent where a runtime could follow the alias
or downgrade the result to a generic I/O error. A root that is genuinely absent
may be created, but its identity is checked again before the lock rendezvous is
created beneath it.

The immediate-parent rule is intentionally narrow. It protects the lock root
that the caller selected without trying to impose a universal canonicalization
policy on every ancestor of an absolute path (for example, operating systems
that intentionally expose `/var` or another top-level path through a platform
alias).

On Windows, reparse points/junctions are treated as the same ambiguity class as
symbolic links. On case-insensitive filesystems, differently-cased spellings of
the same path must contend on the same underlying rendezvous rather than create
independent logical locks.
