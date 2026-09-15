import gleam/string
import gleeunit/should
import ores_locks_and_leases/local_file
import ores_locks_and_leases/local_file_recovery
import simplifile

fn clean(root: String) -> Nil {
  let _ = simplifile.delete_all([root])
  Nil
}

pub fn local_file_acquisition_and_recovery_share_owner_admission_test() {
  let root = "./.tmp-local-file-owner-validation-v8/shared-admission"
  clean(root)

  let assert Error(acquire_empty) =
    local_file.try_acquire(root, "empty-acquire.lock", "")
  acquire_empty.kind |> should.equal(local_file.InvalidInput)

  let assert Error(recover_empty) =
    local_file_recovery.recover(root, "empty-recover.lock", "", True)
  recover_empty.kind |> should.equal(local_file.InvalidInput)

  let oversized = string.repeat("😀", 513)
  let assert Error(acquire_oversized) =
    local_file.try_acquire(root, "oversized-acquire.lock", oversized)
  acquire_oversized.kind |> should.equal(local_file.InvalidInput)

  let assert Error(recover_oversized) =
    local_file_recovery.recover(root, "oversized-recover.lock", oversized, True)
  recover_oversized.kind |> should.equal(local_file.InvalidInput)

  let exact_bound = string.repeat("😀", 512)
  let assert Ok(Some(lock)) =
    local_file.try_acquire(root, "exact-bound.lock", exact_bound)
  local_file.release(lock) |> should.equal(Ok(Nil))
  local_file_recovery.recover(root, "absent-exact-bound.lock", exact_bound, True)
  |> should.equal(Ok(False))

  clean(root)
}
