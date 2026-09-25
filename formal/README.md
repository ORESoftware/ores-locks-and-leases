# Formal methods

This directory contains the repository's executable safety models and proof-oriented
checks for lock, lease, renewal, fencing, and guarded-commit behavior. The formal
artifacts are independent oracles: they must not import production implementations
in a way that turns the model into a restatement of the code being checked.

The governance rules for when these models are mandatory live in
[`governance/CHANGE_CONTROL.md`](../governance/CHANGE_CONTROL.md). The detailed
review procedure and current proof/refinement obligations live in
[`PROCEDURE.md`](PROCEDURE.md).

## Maintained artifacts

| Artifact | Role |
| --- | --- |
| `model.mjs` | finite exhaustive lease/fencing model with deterministic trace replay |
| `maintained-model.mjs` | finite model for maintained Fiducia + PostgreSQL commit admission |
| `fencing-model/` | Rust bounded state model plus Kani proof harnesses over production-facing fencing behavior |
| `fm.toml` | model identity, bounds, claim, and review metadata |
| `coverage.toml` | formal-coverage inventory tying modeled obligations to runtime and persistence evidence |
| `PROCEDURE.md` | normative properties, refinement obligations, bounds, and nonclaims |

The primary safety boundary is conservative: uncertainty about ownership, renewal,
cleanup, token identity, or transport must not be converted into a successful or
uncontended result.

## CI evidence

The repository already runs multiple formal lanes:

- `.github/workflows/formal-model.yml` exhaustively checks the dependency-free
  lease/fencing model and deterministic replay adapter.
- `.github/workflows/formal-state-machines.yml` validates the formal evidence
  inventory, runs the Rust bounded model, checks maintained-transaction admission,
  and uses Kani to prove the fencing classifier over the complete `u64` domain.
- `.github/workflows/formal-leases-model.yml` and the renewal/adversarial workflows
  provide additional model- and implementation-level evidence for lease behavior.

A workflow that does not execute its relevant proof steps is not passing evidence.
See [`governance/RELEASE_GATES.md`](../governance/RELEASE_GATES.md).

## Local checks

Representative local checks are:

```sh
node formal/model.mjs
node formal/maintained-model.mjs --receipt target/formal-maintained/receipt.json
cargo test --locked --manifest-path formal/fencing-model/Cargo.toml
sh conformance/check.sh
sh scripts/check-tjsv-contracts.sh all
```

The formal proof boundary is intentionally paired with native runtime, conformance,
contract-parity, and persistence tests. A bounded model proof does not by itself
prove provider liveness, real-time clock accuracy, network availability, external
side-effect rollback, or correctness outside the declared state bounds.

## Change rule

Any semantic change to acquisition, renewal, release, fencing-token behavior,
maintained commit admission, cleanup precedence, or datastore guarded writes must
first identify the affected safety invariant. The change must then update the
formal model and refinement evidence when the invariant changes, plus the shared
conformance corpus, peer contract authorities, runtime slices, and persistence
adapters wherever their observable behavior changes.

Do not weaken an invariant merely to make a model or implementation pass. A changed
invariant requires explicit governance review and corresponding evidence across the
affected authorities.
