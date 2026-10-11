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

pub fn recovery_claim_with_owner_is_incomplete_and_not_destructive_test() {
  let root = "./.tmp-local-file-recovery-v11/claimed-held"
  clean(root)
  let path = root <> "/install.lock"
  let assert Ok(Some(_lock)) =
    local_file.try_acquire(root, "install.lock", "owner-a")
  let assert Ok(Nil) =
    simplifile.write(to: path <> "/owner.recovering", contents: "")

  let assert Ok(local_file_recovery.LocalFileLockInspection(
    local_file_recovery.Incomplete,
    None,
    Some(local_file_recovery.OwnerMarkerMissing),
    _,
  )) = local_file_recovery.inspect(root, "install.lock")
  let result = local_file_recovery.recover(root, "install.lock", "owner-a", True)
  let assert Error(_) = result
  let assert Ok(_) = simplifile.read(path <> "/owner")
  clean(root)
}
