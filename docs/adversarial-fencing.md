# Adversarial fencing verification

This repository treats a Fiducia lease grant as necessary but not sufficient
for a protected write. Every stateful destination must compare and advance the
fencing watermark atomically with the business mutation. The adversarial suite
proves the same decision relation in the five runtime slices and in the two
shipped persistence adapters.

## Recovered work

The historical recovery inventory contained an overlapping implementation
thread for pull requests 13 and 14. Live GitHub state resolved that ambiguity:
pull request 13 was merged, pull request 14 was closed without merge, and the
subsequent cleanup and formal-model pull requests 15, 18, and 19 were merged.
The remaining executable item was issue 16: deterministic adversarial property
tests across runtimes and datastores.

## Deterministic corpus

`scripts/generate-fence-adversarial.mjs` owns the generated
`conformance/cases/fence-decision.json` corpus. The generated `pr` profile records its seed and contains:

- exact unsigned-64 boundaries, including `2^53 +/- 1`, `2^63 +/- 1`, and
  `2^64 - 1`;
- deterministic newer, stale, exact-replay, and token-reuse decisions;
- canonical-token rejection vectors including signs, leading zeroes,
  exponent/decimal forms, non-ASCII digits, control characters, and overflow;
- exact and over-limit UTF-8 byte fixtures for every bounded field;
- wrong runtime types for untrusted JavaScript, Go JSON, and Dart JSON inputs;
- identity mismatch cases; and
- a long stateful sequence with the expected watermark and protected value
  after every operation.

The generator supports a larger `scheduled` profile. A second deterministic `--check` run refuses any mismatch with the first generated output, and every generation emits a machine-readable receipt with the seed, profile, counts, digest, exact workflow head, and final status. Generated corpora live under `target/` and are retained as CI evidence rather than becoming a third editable contract authority.

All five language test suites consume the generated decision corpus. Go and
Dart additionally expose strict, bounded untrusted-JSON decoders. They reject
numeric tokens, coercion, unknown fields, duplicate top-level fields, invalid
UTF-8 where the runtime exposes bytes, trailing JSON, null optionals, and
oversized request bodies before a datastore call.

## Stateful datastore proof

`scripts/test-adversarial-datastores.mjs` applies the same generated stateful
sequence to PostgreSQL and Redis:

- PostgreSQL evaluates the entire sequence inside a transaction, applies the
  protected mutation only when `should_apply` is true, and checks the stored
  value after every operation before rolling the test transaction back.
- Redis loads `persistence/redis/fenced-write.lua`, uses two keys in one cluster
  hash slot, checks the four-field decision receipt, and reads the protected
  value after every operation.

The test never puts the PostgreSQL connection string on the `psql` command
line; the existing environment boundary is passed through libpq's
`PGDATABASE` variable.

Separate persistence tests cover concurrent first writers, larger writer
storms, transaction rollback, key aliasing, hash-slot mismatch, orphan state,
missing state, partial or extra watermark fields, malformed stored tokens and
digests, and wrong Redis data types.

## Fail-closed Redis recovery

A newer token is not authority to reconstruct an ambiguous Redis pair. Before
any mutation, the Lua script now requires:

- distinct watermark and state keys with the same non-empty hash tag;
- a hash watermark with exactly the five published fields;
- a canonical unsigned-64 decimal token;
- valid operation, payload digest, holder, and lease metadata; and
- an existing string state value whenever the watermark exists.

An orphan state, missing state, partial/extra hash, or wrong Redis type returns
a stable `ORES_FENCE` error and leaves both keys untouched. Operators must
repair corruption from an authoritative datastore or replay log rather than
letting an arbitrary newer writer guess the missing state.

## CI admission

The normal pull-request matrix still runs Rust, Go, TypeScript, Dart, Gleam, contracts, generated consumers, PostgreSQL, Redis, and RustSec. The dedicated `adversarial-fencing` workflow also:

1. checks out the exact requested revision;
2. generates and deterministically rechecks a seeded corpus under `target/`;
3. projects that disposable corpus onto the existing test path inside the CI checkout;
4. runs every runtime and both datastore adapters for pull requests and main; and
5. uses the larger profile on scheduled or manual runs, retaining both corpus and store receipts.

A green badge without the generated receipts is not adversarial execution
evidence. Any unexplained mismatch remains `stopped_for_evaluation` or
`failed`; publication and automatic merge must remain blocked.
