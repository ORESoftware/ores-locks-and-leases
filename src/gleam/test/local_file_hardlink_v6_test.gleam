import gleeunit/should
import ores_locks_and_leases/local_file
import ores_locks_and_leases/local_file_recovery
import simplifile

pub fn hard_linked_owner_fails_closed_when_runtime_exposes_link_count_test() {
  let root = "./.tmp-local-file-hardlink-v6"
  let _ = simplifile.delete_all([root])
  let assert Ok(Some(lock)) =
    local_file.try_acquire(root, "install.lock", "owner-hardlink")
  let path = local_file.local_file_lock_path(lock)
  let owner_path = path <> "/owner"
  let alias_path = root <> "/owner-hardlink-alias"

  case make_hardlink_status(owner_path, alias_path) {
    0 -> {
      let assert Ok(local_file_recovery.LocalFileLockInspection(
        local_file_recovery.Compromised,
        _,
        _,
      )) = local_file_recovery.inspect(root, "install.lock")
      let assert Error(release_error) = local_file.release(lock)
      release_error.kind |> should.equal(local_file.Compromised)
      let assert Ok(Nil) = simplifile.delete_file(at: alias_path)
      local_file.release(lock) |> should.equal(Ok(Nil))
    }
    1 -> local_file.release(lock) |> should.equal(Ok(Nil))
    _ -> panic as "hard-link probe failed unexpectedly"
  }

  let _ = simplifile.delete_all([root])
  Nil
}

@external(erlang, "ores_locks_and_leases_local_file_ffi", "make_hardlink_status")
fn make_hardlink_status(existing: String, link: String) -> Int
