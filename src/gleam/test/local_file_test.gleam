import gleam/option.{None, Some}
import gleeunit/should
import ores_locks_and_leases/local_file
import simplifile

fn clean(root: String) -> Nil {
  let _ = simplifile.delete_all([root])
  Nil
}

pub fn local_file_lock_contention_release_and_reacquire_test() {
  let root = "./.tmp-local-file-locks/contention"
  clean(root)

  let assert Ok(Some(first)) =
    local_file.try_acquire(root, "install.lock", "owner-a")
  let assert Ok(None) = local_file.try_acquire(root, "install.lock", "owner-b")
  local_file.release(first) |> should.equal(Ok(Nil))

  let assert Ok(Some(second)) =
    local_file.try_acquire(root, "install.lock", "owner-b")
  local_file.release(second) |> should.equal(Ok(Nil))
  local_file.exists(root, "install.lock") |> should.equal(Ok(False))
  clean(root)
}

pub fn local_file_lock_no_wait_reports_contention_test() {
  let root = "./.tmp-local-file-locks/no-wait"
  clean(root)

  let assert Ok(Some(first)) =
    local_file.try_acquire(root, "install.lock", "owner-a")
  let options =
    local_file.LocalFileLockOptions(
      wait: False,
      wait_timeout_ms: 30_000,
      retry_interval_ms: 50,
    )
  let assert Error(error) =
    local_file.acquire(root, "install.lock", "owner-b", options)
  error.kind |> should.equal(local_file.Contention)
  local_file.release(first) |> should.equal(Ok(Nil))
  clean(root)
}

pub fn local_file_lock_timeout_test() {
  let root = "./.tmp-local-file-locks/timeout"
  clean(root)

  let assert Ok(Some(first)) =
    local_file.try_acquire(root, "install.lock", "owner-a")
  let options =
    local_file.LocalFileLockOptions(
      wait: True,
      wait_timeout_ms: 20,
      retry_interval_ms: 5,
    )
  let assert Error(error) =
    local_file.acquire(root, "install.lock", "owner-b", options)
  error.kind |> should.equal(local_file.Timeout)
  local_file.release(first) |> should.equal(Ok(Nil))
  clean(root)
}

pub fn local_file_lock_changed_owner_fails_closed_test() {
  let root = "./.tmp-local-file-locks/compromised"
  clean(root)

  let assert Ok(Some(lock)) =
    local_file.try_acquire(root, "install.lock", "owner-a")
  let path = local_file.local_file_lock_path(lock)
  let assert Ok(Nil) =
    simplifile.write(to: path <> "/owner", contents: "owner-b")
  let assert Error(error) = local_file.release(lock)
  error.kind |> should.equal(local_file.Compromised)
  clean(root)
}

pub fn local_file_lock_unexpected_entry_fails_closed_test() {
  let root = "./.tmp-local-file-locks/dirty-directory"
  clean(root)

  let assert Ok(Some(lock)) =
    local_file.try_acquire(root, "install.lock", "owner-a")
  let path = local_file.local_file_lock_path(lock)
  let assert Ok(Nil) =
    simplifile.write(to: path <> "/unexpected", contents: "do not delete")
  let assert Error(error) = local_file.release(lock)
  error.kind |> should.equal(local_file.Compromised)
  simplifile.exists(path <> "/unexpected", False) |> should.equal(Ok(True))
  clean(root)
}
