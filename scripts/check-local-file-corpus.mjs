import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function load(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

const contract = await load("conformance/cases/local-file-lock.json");
const invalid = await load("conformance/cases/local-file-lock-invalid.json");
const scoped = await load("conformance/cases/local-file-scoped.json");
const recovery = await load("conformance/cases/local-file-recovery.json");
const identity = await load("conformance/cases/local-file-path-identity.json");

assert.equal(contract.schema, "ores.locks.local-file.v1");
assert.deepEqual(contract.defaults, {
  wait: true,
  wait_timeout_ms: 30_000,
  retry_interval_ms: 50,
});
assert.deepEqual(contract.bounds, {
  owner_max_codepoints: 512,
  owner_max_utf8_bytes: 2048,
  persisted_owner_requires_valid_utf8: true,
  inspection_entry_probe_limit: 2,
  retry_interval_ms_min: 0,
  zero_retry_interval_allowed_when_wait_false: true,
  owner_file_private_on_posix: true,
});
assert.deepEqual(
  contract.valid_edge_cases.map(({ name }) => name),
  ["zero-retry-no-wait", "owner-at-max"],
);
assert.equal(contract.valid_edge_cases[0].retry_interval_ms, 0);
assert.equal(contract.valid_edge_cases[1].owner_codepoints, 512);
assert.equal(contract.owner_file, "owner");
assert.deepEqual(contract.error_kinds, [
  "contention",
  "timeout",
  "compromised",
  "io",
  "invalid_input",
]);
assert.deepEqual(contract.invariants, {
  admission: "atomic_mkdir",
  release_requires_matching_owner: true,
  release_requires_empty_lock_directory_after_owner_removal: true,
  automatic_pid_or_mtime_stale_breaking: false,
  recursive_delete_on_release: false,
});

assert.equal(invalid.schema, "ores.locks.local-file.invalid.v1");
assert.deepEqual(
  invalid.cases.map(({ name, expect_error }) => [name, expect_error]),
  [
    ["empty-owner", "invalid_input"],
    ["oversized-owner", "invalid_input"],
    ["negative-retry-no-wait", "invalid_input"],
    ["zero-timeout-under-contention", "timeout"],
    ["no-wait-under-contention", "contention"],
  ],
);
assert.equal(invalid.cases.find(({ name }) => name === "oversized-owner").owner_codepoints, 513);
assert.equal(invalid.cases.find(({ name }) => name === "negative-retry-no-wait").retry_interval_ms, -1);

assert.equal(scoped.schema, "ores.locks.local-file.scoped.v1");
assert.equal(scoped.contract, "with_local_file_lock");
assert.deepEqual(scoped.structured_outcomes, [
  "success",
  "lock_error",
  "work_error",
  "work_and_release_error",
]);
assert.deepEqual(scoped.precedence, {
  acquire_failure: "lock_error",
  work_failure_release_success: "work_error",
  work_success_release_failure: "lock_error",
  work_failure_release_failure: "work_and_release_error",
});
assert.equal(scoped.fatal_behavior.normalized, false);
assert.equal(scoped.cases.length, 5);
assert.deepEqual(scoped.cases.at(-1).must_preserve, ["work_error", "release_error"]);

assert.equal(recovery.schema, "ores.locks.local-file.recovery.v1");
assert.deepEqual(recovery.inspection_states, ["absent", "held", "compromised"]);
assert.equal(recovery.inspection.claims_ownership, false);
assert.equal(recovery.inspection.follows_rendezvous_symlink, false);
assert.deepEqual(recovery.inspection.expected_entries_when_held, ["owner"]);
assert.equal(recovery.recovery.automatic, false);
assert.equal(recovery.recovery.requires_explicit_confirmation, true);
assert.equal(recovery.recovery.requires_expected_owner, true);
assert.equal(recovery.recovery.recursive_delete, false);
assert.equal(recovery.cases.length, 9);

assert.equal(identity.schema, "ores.locks.local-file.path-identity.v1");
assert.deepEqual(identity.rules, {
  rendezvous_symlink: "compromised",
  rendezvous_non_directory: "compromised",
  owner_symlink: "compromised",
  immediate_parent_symlink_or_reparse_point: "compromised",
  recursive_delete: false,
  name_based_helpers_reject_dot: true,
  name_based_helpers_reject_dot_dot: true,
  name_based_helpers_reject_path_separators: true,
});
assert.equal(identity.cases.length, 9);

console.log("local filesystem lock conformance corpus is structurally valid");
