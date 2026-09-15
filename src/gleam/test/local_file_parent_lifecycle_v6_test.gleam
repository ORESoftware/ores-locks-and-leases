import gleam/option.{Some}
import gleeunit/should
import ores_locks_and_leases/local_file
import simplifile

pub fn release_preserves_auto_created_parent_and_removes_only_rendezvous_test() {
  let root = "./.tmp-local-file-parent-lifecycle-v6"
  let parent = root <> "/auto-created-parent"
  let _ = simplifile.delete_all([root])

  simplifile.exists(parent, True) |> should.equal(Ok(False))
  let assert Ok(Some(lock)) =
    local_file.try_acquire(parent, "install.lock", "owner-a")
  simplifile.exists(parent, True) |> should.equal(Ok(True))
  local_file.release(lock) |> should.equal(Ok(Nil))

  simplifile.exists(parent, True) |> should.equal(Ok(True))
  simplifile.exists(parent <> "/install.lock", True) |> should.equal(Ok(False))
  let _ = simplifile.delete_all([root])
  Nil
}
