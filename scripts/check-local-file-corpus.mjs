import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const contract = JSON.parse(
  await readFile("conformance/cases/local-file-lock.json", "utf8"),
);
const invalid = JSON.parse(
  await readFile("conformance/cases/local-file-lock-invalid.json", "utf8"),
);

assert.equal(contract.schema, "ores.locks.local-file.v1");
assert.deepEqual(contract.defaults, {
  wait: true,
  wait_timeout_ms: 30_000,
  retry_interval_ms: 50,
});
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
    ["zero-timeout-under-contention", "timeout"],
    ["no-wait-under-contention", "contention"],
  ],
);

console.log("local filesystem lock conformance corpus is structurally valid");
