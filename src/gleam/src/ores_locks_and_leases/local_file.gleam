//// Portable single-host filesystem locks for the Erlang-target Gleam slice.
////
//// Atomic directory creation is the ownership admission primitive. The
//// `owner` file is diagnostics plus an owner-safe release token; it is not a
//// PID-file authority and this backend never guesses that an old-looking lock
//// is stale.

import gleam/dynamic.{type Dynamic}
import gleam/erlang/process
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import simplifile

const owner_file = "owner"
const owner_max_codepoints = 512

/// Why a portable local filesystem lock operation failed.
pub type LocalFileLockErrorKind {
  Contention
  Timeout
  Compromised
  Io
  InvalidInput
}

/// Structured portable-local failure.
pub type LocalFileLockError {
  LocalFileLockError(
    kind: LocalFileLockErrorKind,
    path: String,
    message: String,
  )
}

/// Waiting policy for `acquire`.
pub type LocalFileLockOptions {
  LocalFileLockOptions(wait: Bool, wait_timeout_ms: Int, retry_interval_ms: Int)
}

/// Cross-runtime convenience defaults: 30s wait budget, 50ms retry interval.
pub fn default_local_file_lock_options() -> LocalFileLockOptions {
  LocalFileLockOptions(
    wait: True,
    wait_timeout_ms: 30_000,
    retry_interval_ms: 50,
  )
}

/// A held portable filesystem lock.
pub opaque type LocalFileLock {
  LocalFileLock(path: String, owner: String)
}

pub fn local_file_lock_path(lock: LocalFileLock) -> String {
  lock.path
}

pub fn local_file_lock_owner(lock: LocalFileLock) -> String {
  lock.owner
}

/// Make one immediate atomic attempt under `lock_root`.
///
/// `lock_name` is one path component (for example `install.lock`) and `owner`
/// is a non-empty token unique to the logical acquisition. `Ok(None)` means
/// ordinary contention.
pub fn try_acquire(
  lock_root: String,
  lock_name: String,
  owner: String,
) -> Result(Option(LocalFileLock), LocalFileLockError) {
  use _ <- result.try(validate_inputs(lock_root, lock_name, owner))
  let path = lock_path(lock_root, lock_name)

  case path_kind(lock_root) {
    0 -> create_missing_lock_root(lock_root, path, owner)
    1 -> create_lock_directory(path, owner)
    4 -> Error(io_error(path, "inspect lock root failed"))
    _ ->
      Error(LocalFileLockError(
        Compromised,
        path,
        "lock root is not an unaliased directory",
      ))
  }
}

fn create_missing_lock_root(
  lock_root: String,
  path: String,
  owner: String,
) -> Result(Option(LocalFileLock), LocalFileLockError) {
  case simplifile.create_directory_all(lock_root) {
    Error(error) ->
      Error(io_error(
        path,
        "create lock root failed: " <> simplifile.describe_error(error),
      ))
    Ok(Nil) ->
      case path_kind(lock_root) {
        1 -> create_lock_directory(path, owner)
        4 -> Error(io_error(path, "inspect created lock root failed"))
        _ ->
          Error(LocalFileLockError(
            Compromised,
            path,
            "created lock root is not an unaliased directory",
          ))
      }
  }
}

fn create_lock_directory(
  path: String,
  owner: String,
) -> Result(Option(LocalFileLock), LocalFileLockError) {
  case simplifile.create_directory(path) {
    Error(simplifile.Eexist) ->
      case path_kind(path) {
        1 -> Ok(None)
        4 -> Error(io_error(path, "inspect contended local lock path failed"))
        _ ->
          Error(LocalFileLockError(
            Compromised,
            path,
            "lock path already exists but is not an unaliased directory",
          ))
      }
    Error(error) ->
      Error(io_error(
        path,
        "atomically create local lock directory failed: "
          <> simplifile.describe_error(error),
      ))
    Ok(Nil) -> write_owner_or_unwind(path, owner)
  }
}

/// Acquire with optional finite waiting.
pub fn acquire(
  lock_root: String,
  lock_name: String,
  owner: String,
  options: LocalFileLockOptions,
) -> Result(LocalFileLock, LocalFileLockError) {
  use _ <- result.try(validate_inputs(lock_root, lock_name, owner))
  let path = lock_path(lock_root, lock_name)
  use _ <- result.try(validate_options(path, options))
  acquire_loop(lock_root, lock_name, owner, options, options.wait_timeout_ms)
}

fn acquire_loop(
  lock_root: String,
  lock_name: String,
  owner: String,
  options: LocalFileLockOptions,
  remaining_ms: Int,
) -> Result(LocalFileLock, LocalFileLockError) {
  let path = lock_path(lock_root, lock_name)
  case try_acquire(lock_root, lock_name, owner) {
    Error(error) -> Error(error)
    Ok(Some(lock)) -> Ok(lock)
    Ok(None) if !options.wait ->
      Error(LocalFileLockError(
        Contention,
        path,
        "lock is already held by another owner",
      ))
    Ok(None) if remaining_ms <= 0 ->
      Error(LocalFileLockError(
        Timeout,
        path,
        "timed out waiting for local lock",
      ))
    Ok(None) -> {
      let delay = case options.retry_interval_ms < remaining_ms {
        True -> options.retry_interval_ms
        False -> remaining_ms
      }
      process.sleep(delay)
      acquire_loop(lock_root, lock_name, owner, options, remaining_ms - delay)
    }
  }
}

/// Release after verifying the persisted owner token.
///
/// A release observes structural changes to the lock directory and fails
/// closed rather than treating externally removed state as a successful unlock.
pub fn release(lock: LocalFileLock) -> Result(Nil, LocalFileLockError) {
  let path = lock.path
  let owner_path = path <> "/" <> owner_file
  case path_kind(path), path_kind(owner_path) {
    1, 2 -> release_verified_shape(lock, path, owner_path)
    4, _ -> Error(io_error(path, "inspect lock directory failed"))
    _, 4 -> Error(io_error(path, "inspect owner token failed"))
    _, _ ->
      Error(LocalFileLockError(
        Compromised,
        path,
        "lock directory or owner token has ambiguous path identity",
      ))
  }
}

fn release_verified_shape(
  lock: LocalFileLock,
  path: String,
  owner_path: String,
) -> Result(Nil, LocalFileLockError) {
  case simplifile.read(owner_path) {
    Ok(observed) if observed == lock.owner ->
      remove_owned_lock(path, owner_path)
    Ok(_) ->
      Error(LocalFileLockError(
        Compromised,
        path,
        "owner token changed; refusing to remove a lock that may belong to another acquisition",
      ))
    Error(simplifile.Enoent) ->
      Error(LocalFileLockError(
        Compromised,
        path,
        "owner token is missing; refusing to treat externally altered lock state as a successful release",
      ))
    Error(error) ->
      Error(io_error(
        path,
        "read local lock owner token failed: "
          <> simplifile.describe_error(error),
      ))
  }
}

/// Diagnostics only. Callers must still acquire before treating themselves as
/// the owner.
pub fn exists(
  lock_root: String,
  lock_name: String,
) -> Result(Bool, LocalFileLockError) {
  let path = lock_path(lock_root, lock_name)
  case path_kind(path) {
    0 -> Ok(False)
    1 -> Ok(True)
    4 -> Error(io_error(path, "inspect local lock path failed"))
    _ ->
      Error(LocalFileLockError(
        Compromised,
        path,
        "lock path exists but is not an unaliased directory",
      ))
  }
}

fn write_owner_or_unwind(
  path: String,
  owner: String,
) -> Result(Option(LocalFileLock), LocalFileLockError) {
  let owner_path = path <> "/" <> owner_file
  case write_new_file_status(owner_path, owner) {
    0 -> Ok(Some(LocalFileLock(path: path, owner: owner)))
    1 -> {
      let _ = delete_empty_directory(path)
      Error(LocalFileLockError(
        Compromised,
        path,
        "owner token already exists after winning lock directory creation",
      ))
    }
    _ -> {
      let _ = simplifile.delete_file(at: owner_path)
      let _ = delete_empty_directory(path)
      Error(io_error(path, "write local lock owner token failed"))
    }
  }
}

fn remove_owned_lock(
  path: String,
  owner_path: String,
) -> Result(Nil, LocalFileLockError) {
  case simplifile.delete_file(at: owner_path) {
    Error(error) ->
      Error(io_error(
        path,
        "remove local lock owner token failed: "
          <> simplifile.describe_error(error),
      ))
    Ok(Nil) ->
      case delete_empty_directory(path) {
        Ok(Nil) -> Ok(Nil)
        Error(_) ->
          Error(LocalFileLockError(
            Compromised,
            path,
            "remove local lock directory failed; refusing recursive deletion of an unexpectedly non-empty directory",
          ))
      }
  }
}

fn validate_inputs(
  lock_root: String,
  lock_name: String,
  owner: String,
) -> Result(Nil, LocalFileLockError) {
  let path = lock_path(lock_root, lock_name)
  case
    string.is_empty(lock_root),
    string.is_empty(lock_name),
    lock_name == "."
    || lock_name == ".."
    || string.contains(lock_name, "/")
    || string.contains(lock_name, "\\"),
    string.is_empty(owner),
    unicode_codepoint_count(owner) > owner_max_codepoints
  {
    True, _, _, _, _ ->
      Error(LocalFileLockError(
        InvalidInput,
        path,
        "lock root must not be empty",
      ))
    _, True, _, _, _ ->
      Error(LocalFileLockError(
        InvalidInput,
        path,
        "lock name must not be empty",
      ))
    _, _, True, _, _ ->
      Error(LocalFileLockError(
        InvalidInput,
        path,
        "lock name must be one non-dot path component",
      ))
    _, _, _, True, _ ->
      Error(LocalFileLockError(
        InvalidInput,
        path,
        "owner token must not be empty",
      ))
    _, _, _, _, True ->
      Error(LocalFileLockError(
        InvalidInput,
        path,
        "owner token must not exceed 512 Unicode code points",
      ))
    False, False, False, False, False -> Ok(Nil)
  }
}

fn validate_options(
  path: String,
  options: LocalFileLockOptions,
) -> Result(Nil, LocalFileLockError) {
  case
    options.wait_timeout_ms < 0,
    options.retry_interval_ms < 0,
    options.wait && options.retry_interval_ms == 0
  {
    True, _, _ ->
      Error(LocalFileLockError(
        InvalidInput,
        path,
        "wait timeout must not be negative",
      ))
    _, True, _ ->
      Error(LocalFileLockError(
        InvalidInput,
        path,
        "retry interval must not be negative",
      ))
    _, _, True ->
      Error(LocalFileLockError(
        InvalidInput,
        path,
        "retry interval must be greater than zero when waiting",
      ))
    False, False, False -> Ok(Nil)
  }
}

fn lock_path(lock_root: String, lock_name: String) -> String {
  let root = case
    string.ends_with(lock_root, "/") || string.ends_with(lock_root, "\\")
  {
    True -> string.drop_end(lock_root, 1)
    False -> lock_root
  }
  root <> "/" <> lock_name
}

fn io_error(path: String, message: String) -> LocalFileLockError {
  LocalFileLockError(Io, path, message)
}

@external(erlang, "ores_locks_and_leases_local_file_ffi", "delete_empty_directory")
fn delete_empty_directory(path: String) -> Result(Nil, Dynamic)

@external(erlang, "ores_locks_and_leases_local_file_ffi", "path_kind")
fn path_kind(path: String) -> Int

@external(erlang, "ores_locks_and_leases_local_file_ffi", "write_new_file_status")
fn write_new_file_status(path: String, contents: String) -> Int

@external(erlang, "ores_locks_and_leases_local_file_ffi", "unicode_codepoint_count")
fn unicode_codepoint_count(value: String) -> Int
