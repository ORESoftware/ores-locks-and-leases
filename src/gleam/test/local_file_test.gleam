import gleam/option.{None, Some}
import gleam/string
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

pub fn local_file_lock_zero_timeout_test() {
  let root = "./.tmp-local-file-locks/zero-timeout"
  clean(root)

  let assert Ok(Some(first)) =
    local_file.try_acquire(root, "install.lock", "owner-a")
  let options =
    local_file.LocalFileLockOptions(
      wait: True,
      wait_timeout_ms: 0,
      retry_interval_ms: 50,
    )
  let assert Error(error) =
    local_file.acquire(root, "install.lock", "owner-b", options)
  error.kind |> should.equal(local_file.Timeout)
  local_file.release(first) |> should.equal(Ok(Nil))
  clean(root)
}

pub fn local_file_lock_empty_owner_is_invalid_test() {
  let root = "./.tmp-local-file-locks/empty-owner"
  clean(root)

  let assert Error(error) = local_file.try_acquire(root, "install.lock", "")
  error.kind |> should.equal(local_file.InvalidInput)
  clean(root)
}

pub fn local_file_lock_owner_at_max_codepoints_is_valid_test() {
  let root = "./.tmp-local-file-locks/max-owner"
  clean(root)
  let owner = string.repeat("😀", 512)
  let assert Ok(Some(lock)) =
    local_file.try_acquire(root, "install.lock", owner)
  local_file.release(lock) |> should.equal(Ok(Nil))
  clean(root)
}

pub fn local_file_lock_oversized_owner_is_invalid_test() {
  let root = "./.tmp-local-file-locks/oversized-owner"
  clean(root)
  let owner = string.repeat("😀", 513)
  let assert Error(error) = local_file.try_acquire(root, "install.lock", owner)
  error.kind |> should.equal(local_file.InvalidInput)
  clean(root)
}

pub fn local_file_lock_negative_retry_is_invalid_without_waiting_test() {
  let root = "./.tmp-local-file-locks/negative-retry"
  clean(root)
  let options =
    local_file.LocalFileLockOptions(
      wait: False,
      wait_timeout_ms: 30_000,
      retry_interval_ms: -1,
    )
  let assert Error(error) =
    local_file.acquire(root, "install.lock", "owner-a", options)
  error.kind |> should.equal(local_file.InvalidInput)
  clean(root)
}

pub fn local_file_lock_zero_retry_is_valid_without_waiting_test() {
  let root = "./.tmp-local-file-locks/zero-retry-no-wait"
  clean(root)
  let options =
    local_file.LocalFileLockOptions(
      wait: False,
      wait_timeout_ms: 30_000,
      retry_interval_ms: 0,
    )
  let assert Ok(lock) =
    local_file.acquire(root, "install.lock", "owner-a", options)
  local_file.release(lock) |> should.equal(Ok(Nil))
  clean(root)
}

pub fn local_file_lock_directory_and_owner_are_private_on_posix_test() {
  let root = "./.tmp-local-file-locks/private-owner"
  clean(root)
  let assert Ok(Some(lock)) =
    local_file.try_acquire(root, "install.lock", "owner-a")
  let lock_path = local_file.local_file_lock_path(lock)
  case owner_private_mode_status(lock_path) {
    0 -> Nil
    3 -> Nil
    other -> other |> should.equal(0)
  }
  let owner_path = lock_path <> "/owner"
  case owner_private_mode_status(owner_path) {
    0 -> Nil
    3 -> Nil
    other -> other |> should.equal(0)
  }
  local_file.release(lock) |> should.equal(Ok(Nil))
  clean(root)
}

pub fn local_file_lock_existing_regular_file_is_compromised_test() {
  let root = "./.tmp-local-file-locks/existing-file"
  clean(root)
  let assert Ok(Nil) = simplifile.create_directory_all(root)
  let assert Ok(Nil) =
    simplifile.write(to: root <> "/install.lock", contents: "not a directory")

  let assert Error(error) =
    local_file.try_acquire(root, "install.lock", "owner-a")
  error.kind |> should.equal(local_file.Compromised)
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

pub fn local_file_lock_missing_owner_fails_closed_test() {
  let root = "./.tmp-local-file-locks/missing-owner"
  clean(root)

  let assert Ok(Some(lock)) =
    local_file.try_acquire(root, "install.lock", "owner-a")
  let path = local_file.local_file_lock_path(lock)
  let assert Ok(Nil) = simplifile.delete_file(at: path <> "/owner")
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

pub fn local_file_lock_nested_unicode_path_test() {
  let root = "./.tmp-local-file-locks/unicode-锁/nested"
  clean("./.tmp-local-file-locks/unicode-锁")

  let assert Ok(Some(lock)) =
    local_file.try_acquire(root, "paquete-ñ.lock", "owner-λ")
  local_file.local_file_lock_owner(lock) |> should.equal("owner-λ")
  local_file.release(lock) |> should.equal(Ok(Nil))
  local_file.exists(root, "paquete-ñ.lock") |> should.equal(Ok(False))
  clean("./.tmp-local-file-locks/unicode-锁")
}

@external(erlang, "ores_locks_and_leases_local_file_ffi", "owner_private_mode_status")
fn owner_private_mode_status(path: String) -> Int
