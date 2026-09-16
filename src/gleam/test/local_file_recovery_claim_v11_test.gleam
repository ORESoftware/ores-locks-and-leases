import gleam/option.{None, Some}
import gleeunit/should
import ores_locks_and_leases/local_file
import ores_locks_and_leases/local_file_recovery
import simplifile

fn clean(root: String) -> Nil {
  let _ = simplifile.delete_all([root])
  Nil
}

pub fn recovery_claim_marker_is_incomplete_test() {
  let root = "./.tmp-local-file-recovery-v11/recovering-state"
  clean(root)
  let path = root <> "/install.lock"
  let assert Ok(Nil) = simplifile.create_directory_all(path)
  let assert Ok(Nil) =
    simplifile.write(to: path <> "/owner.recovering", contents: "owner-a")

  let assert Ok(local_file_recovery.LocalFileLockInspection(
    local_file_recovery.Incomplete,
    None,
    Some(local_file_recovery.OwnerMarkerMissing),
    _,
  )) = local_file_recovery.inspect(root, "install.lock")
  clean(root)
}

pub fn exact_owner_recovery_has_one_destructive_success_test() {
  let root = "./.tmp-local-file-recovery-v11/one-winner"
  clean(root)
  let assert Ok(Some(_lock)) =
    local_file.try_acquire(root, "install.lock", "owner-a")

  local_file_recovery.recover(root, "install.lock", "owner-a", True)
  |> should.equal(Ok(True))
  local_file_recovery.recover(root, "install.lock", "owner-a", True)
  |> should.equal(Ok(False))
  clean(root)
}
