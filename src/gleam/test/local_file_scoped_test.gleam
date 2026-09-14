import gleam/option.{Some}
import gleeunit/should
import ores_locks_and_leases/local_file
import ores_locks_and_leases/local_file_scoped
import simplifile

fn clean(root: String) -> Nil {
  let _ = simplifile.delete_all([root])
  Nil
}

pub fn scoped_acquire_failure_does_not_run_work_test() {
  let root = "./.tmp-local-file-scoped/acquire-failure"
  clean(root)
  let assert Ok(Some(first)) =
    local_file.try_acquire(root, "install.lock", "owner-a")
  let options =
    local_file.LocalFileLockOptions(
      wait: False,
      wait_timeout_ms: 30_000,
      retry_interval_ms: 50,
    )

  let assert Error(local_file_scoped.Lock(error)) =
    local_file_scoped.with_local_file_lock(
      root,
      "install.lock",
      "owner-b",
      options,
      fn(_) { Ok(1) },
    )
  error.kind |> should.equal(local_file.Contention)
  local_file.release(first) |> should.equal(Ok(Nil))
  clean(root)
}

pub fn scoped_work_failure_survives_release_test() {
  let root = "./.tmp-local-file-scoped/work-error"
  clean(root)
  let assert Error(local_file_scoped.Work("work-failed")) =
    local_file_scoped.with_local_file_lock(
      root,
      "install.lock",
      "owner-a",
      local_file.default_local_file_lock_options(),
      fn(_) { Error("work-failed") },
    )
  local_file.exists(root, "install.lock") |> should.equal(Ok(False))
  clean(root)
}

pub fn scoped_release_failure_after_success_is_lock_error_test() {
  let root = "./.tmp-local-file-scoped/release-error"
  clean(root)
  let assert Error(local_file_scoped.Lock(error)) =
    local_file_scoped.with_local_file_lock(
      root,
      "install.lock",
      "owner-a",
      local_file.default_local_file_lock_options(),
      fn(lock) {
        let path = local_file.local_file_lock_path(lock)
        let assert Ok(Nil) =
          simplifile.write(to: path <> "/owner", contents: "owner-b")
        Ok(42)
      },
    )
  error.kind |> should.equal(local_file.Compromised)
  clean(root)
}

pub fn scoped_preserves_work_and_release_failures_test() {
  let root = "./.tmp-local-file-scoped/both-errors"
  clean(root)
  let assert Error(local_file_scoped.WorkAndRelease("work-failed", release)) =
    local_file_scoped.with_local_file_lock(
      root,
      "install.lock",
      "owner-a",
      local_file.default_local_file_lock_options(),
      fn(lock) {
        let path = local_file.local_file_lock_path(lock)
        let assert Ok(Nil) =
          simplifile.write(to: path <> "/owner", contents: "owner-b")
        Error("work-failed")
      },
    )
  release.kind |> should.equal(local_file.Compromised)
  clean(root)
}
