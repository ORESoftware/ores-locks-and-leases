import gleam/option.{None, Some}
import gleam/string
import gleeunit/should
import ores_locks_and_leases/local_file
import simplifile

fn clean(root: String) -> Nil {
  let _ = simplifile.delete_all([root])
  Nil
}

pub fn same_owner_reacquisition_is_contention_not_reentrancy_test() {
  let root = "./.tmp-local-file-semantic-v5/same-owner"
  clean(root)
  let assert Ok(Some(first)) =
    local_file.try_acquire(root, "install.lock", "owner-a")
  local_file.try_acquire(root, "install.lock", "owner-a")
  |> should.equal(Ok(None))
  local_file.release(first) |> should.equal(Ok(Nil))
  clean(root)
}

pub fn owner_identity_is_exact_unicode_not_normalized_test() {
  let root = "./.tmp-local-file-semantic-v5/unicode-owner"
  clean(root)
  let assert Ok(Some(lock)) =
    local_file.try_acquire(root, "install.lock", "owner-é")
  let path = local_file.local_file_lock_path(lock)
  let assert Ok(Nil) =
    simplifile.write(to: path <> "/owner", contents: "owner-e\u{0301}")
  let assert Error(error) = local_file.release(lock)
  error.kind |> should.equal(local_file.Compromised)
  clean(root)
}

pub fn owner_token_is_redacted_from_release_diagnostics_test() {
  let root = "./.tmp-local-file-semantic-v5/owner-redaction"
  let secret = "owner-secret-do-not-log"
  clean(root)
  let assert Ok(Some(lock)) =
    local_file.try_acquire(root, "install.lock", secret)
  let path = local_file.local_file_lock_path(lock)
  let assert Ok(Nil) =
    simplifile.write(to: path <> "/owner", contents: "attacker-owner")
  let assert Error(error) = local_file.release(lock)
  error.kind |> should.equal(local_file.Compromised)
  string.contains(error.message, secret) |> should.equal(False)
  clean(root)
}
