import gleam/option.{None, Some}
import gleam/string
import gleeunit/should
import ores_locks_and_leases/local_file
import ores_locks_and_leases/local_file_recovery
import simplifile

fn clean(root: String) -> Nil {
  let _ = simplifile.delete_all([root])
  Nil
}

pub fn inspect_absent_and_held_local_lock_test() {
  let root = "./.tmp-local-file-recovery/inspect"
  clean(root)
  let assert Ok(local_file_recovery.LocalFileLockInspection(
    local_file_recovery.Absent,
    None,
    None,
    None,
  )) = local_file_recovery.inspect(root, "install.lock")

  let assert Ok(Some(_lock)) =
    local_file.try_acquire(root, "install.lock", "owner-a")
  let assert Ok(local_file_recovery.LocalFileLockInspection(
    local_file_recovery.Held,
    Some("owner-a"),
    None,
    None,
  )) = local_file_recovery.inspect(root, "install.lock")
  local_file_recovery.recover(root, "install.lock", "owner-a", True)
  |> should.equal(Ok(True))
  clean(root)
}

pub fn inspect_empty_directory_is_incomplete_crash_state_test() {
  let root = "./.tmp-local-file-recovery/incomplete"
  clean(root)
  let path = root <> "/install.lock"
  let assert Ok(Nil) = simplifile.create_directory_all(path)
  let assert Ok(local_file_recovery.LocalFileLockInspection(
    local_file_recovery.Incomplete,
    None,
    Some(local_file_recovery.OwnerMarkerMissing),
    _,
  )) = local_file_recovery.inspect(root, "install.lock")
  local_file_recovery.inspection_reason_string(
    local_file_recovery.OwnerMarkerMissing,
  )
  |> should.equal("owner_marker_missing")
  let assert Error(error) =
    local_file_recovery.recover(root, "install.lock", "owner-a", True)
  error.kind |> should.equal(local_file.Compromised)
  simplifile.exists(path, True) |> should.equal(Ok(True))
  clean(root)
}

pub fn owner_removed_before_rmdir_is_incomplete_crash_state_test() {
  let root = "./.tmp-local-file-recovery/release-crash"
  clean(root)
  let assert Ok(Some(lock)) =
    local_file.try_acquire(root, "install.lock", "owner-a")
  let path = local_file.local_file_lock_path(lock)
  let assert Ok(Nil) = simplifile.delete_file(at: path <> "/owner")
  let assert Ok(local_file_recovery.LocalFileLockInspection(
    local_file_recovery.Incomplete,
    None,
    Some(local_file_recovery.OwnerMarkerMissing),
    _,
  )) = local_file_recovery.inspect(root, "install.lock")
  let assert Error(error) =
    local_file_recovery.recover(root, "install.lock", "owner-a", True)
  error.kind |> should.equal(local_file.Compromised)
  simplifile.exists(path, True) |> should.equal(Ok(True))
  clean(root)
}

pub fn inspect_dirty_directory_is_compromised_test() {
  let root = "./.tmp-local-file-recovery/compromised"
  clean(root)
  let assert Ok(Some(lock)) =
    local_file.try_acquire(root, "install.lock", "owner-a")
  let path = local_file.local_file_lock_path(lock)
  let assert Ok(Nil) = simplifile.delete_file(at: path <> "/owner")
  let assert Ok(Nil) =
    simplifile.write(to: path <> "/unexpected", contents: "x")
  let assert Ok(local_file_recovery.LocalFileLockInspection(
    local_file_recovery.Compromised,
    _,
    Some(local_file_recovery.DirtyDirectory),
    _,
  )) = local_file_recovery.inspect(root, "install.lock")
  local_file_recovery.inspection_reason_string(
    local_file_recovery.DirtyDirectory,
  )
  |> should.equal("dirty_directory")
  clean(root)
}

pub fn inspect_oversized_persisted_owner_is_compromised_test() {
  let root = "./.tmp-local-file-recovery/oversized-persisted-owner"
  clean(root)
  let assert Ok(Some(lock)) =
    local_file.try_acquire(root, "install.lock", "owner-a")
  let path = local_file.local_file_lock_path(lock)
  let assert Ok(Nil) =
    simplifile.write(to: path <> "/owner", contents: string.repeat("😀", 513))
  let assert Ok(local_file_recovery.LocalFileLockInspection(
    local_file_recovery.Compromised,
    _,
    Some(local_file_recovery.OwnerContractViolation),
    _,
  )) = local_file_recovery.inspect(root, "install.lock")
  clean(root)
}

pub fn recovery_requires_confirmation_and_exact_owner_test() {
  let root = "./.tmp-local-file-recovery/gates"
  clean(root)
  let assert Ok(Some(_lock)) =
    local_file.try_acquire(root, "install.lock", "owner-a")

  let assert Error(unconfirmed) =
    local_file_recovery.recover(root, "install.lock", "owner-a", False)
  unconfirmed.kind |> should.equal(local_file.InvalidInput)

  let assert Error(mismatch) =
    local_file_recovery.recover(root, "install.lock", "owner-b", True)
  mismatch.kind |> should.equal(local_file.Compromised)

  local_file_recovery.recover(root, "install.lock", "owner-a", True)
  |> should.equal(Ok(True))
  local_file_recovery.inspect(root, "install.lock")
  |> should.equal(
    Ok(local_file_recovery.LocalFileLockInspection(
      local_file_recovery.Absent,
      None,
      None,
      None,
    )),
  )
  clean(root)
}

pub fn recovery_rejects_oversized_expected_owner_test() {
  let root = "./.tmp-local-file-recovery/oversized-expected-owner"
  clean(root)
  let assert Error(error) =
    local_file_recovery.recover(
      root,
      "absent.lock",
      string.repeat("😀", 513),
      True,
    )
  error.kind |> should.equal(local_file.InvalidInput)
  clean(root)
}

pub fn recovery_absent_noop_and_dirty_fails_closed_test() {
  let root = "./.tmp-local-file-recovery/dirty"
  clean(root)
  local_file_recovery.recover(root, "absent.lock", "owner-a", True)
  |> should.equal(Ok(False))

  let assert Ok(Some(lock)) =
    local_file.try_acquire(root, "install.lock", "owner-a")
  let path = local_file.local_file_lock_path(lock)
  let assert Ok(Nil) =
    simplifile.write(to: path <> "/unexpected", contents: "do not delete")
  let assert Error(error) =
    local_file_recovery.recover(root, "install.lock", "owner-a", True)
  error.kind |> should.equal(local_file.Compromised)
  simplifile.exists(path <> "/unexpected", False) |> should.equal(Ok(True))
  clean(root)
}
