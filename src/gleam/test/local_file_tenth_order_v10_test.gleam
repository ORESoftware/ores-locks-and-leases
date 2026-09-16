import gleam/option.{Some}
import gleeunit/should
import ores_locks_and_leases/local_file
import simplifile

fn clean(root: String) -> Nil {
  let _ = simplifile.delete_all([root])
  Nil
}

pub fn finite_wait_uses_timeout_path_test() {
  let root = "./.tmp-local-file-v10/wait"
  clean(root)
  let assert Ok(Some(holder)) =
    local_file.try_acquire(root, "install.lock", "holder")

  let options =
    local_file.LocalFileLockOptions(
      wait: True,
      wait_timeout_ms: 20,
      retry_interval_ms: 5,
    )
  let assert Error(error) =
    local_file.acquire(root, "install.lock", "waiter", options)
  error.kind |> should.equal(local_file.Timeout)

  local_file.release(holder) |> should.equal(Ok(Nil))
  clean(root)
}

pub fn destructive_partial_release_returns_terminal_state_test() {
  let root = "./.tmp-local-file-v10/partial"
  clean(root)
  let assert Ok(Some(lock)) =
    local_file.try_acquire(root, "install.lock", "owner-a")
  let path = local_file.local_file_lock_path(lock)
  let assert Ok(Nil) =
    simplifile.write(to: path <> "/unexpected", contents: "dirty")

  let assert local_file.ReleaseFailedPartial(error) =
    local_file.release_with_state(lock)
  error.kind |> should.equal(local_file.Compromised)
  simplifile.exists(path <> "/owner", False) |> should.equal(Ok(False))
  simplifile.exists(path <> "/unexpected", False) |> should.equal(Ok(True))
  clean(root)
}
