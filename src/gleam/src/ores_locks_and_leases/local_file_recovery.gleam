//// Explicit read-only inspection and operator-driven recovery for portable locks.

import gleam/dynamic.{type Dynamic}
import gleam/option.{type Option, None, Some}
import gleam/string
import ores_locks_and_leases/local_file
import simplifile

const owner_file = "owner"

const owner_max_codepoints = 512

pub type LocalFileLockInspectionState {
  Absent
  Held
  Compromised
}

pub type LocalFileLockInspection {
  LocalFileLockInspection(
    state: LocalFileLockInspectionState,
    owner: Option(String),
    message: Option(String),
  )
}

/// Read-only inspection. This never claims ownership or repairs state.
pub fn inspect(
  lock_root: String,
  lock_name: String,
) -> Result(LocalFileLockInspection, local_file.LocalFileLockError) {
  let path = lock_path(lock_root, lock_name)
  case validate_inputs(lock_root, lock_name, path) {
    Error(error) -> Error(error)
    Ok(Nil) -> inspect_path(path)
  }
}

fn inspect_path(
  path: String,
) -> Result(LocalFileLockInspection, local_file.LocalFileLockError) {
  case path_kind(path) {
    0 -> Ok(LocalFileLockInspection(Absent, None, None))
    4 -> Error(io_error(path, "inspect local lock path failed"))
    1 -> inspect_directory(path)
    _ -> Ok(compromised("lock path is not an unaliased directory"))
  }
}

fn inspect_directory(
  path: String,
) -> Result(LocalFileLockInspection, local_file.LocalFileLockError) {
  case directory_shape(path) {
    2 -> Error(io_error(path, "list local lock directory failed"))
    1 -> Ok(compromised("lock directory must contain exactly one owner marker"))
    _ -> inspect_owner(path)
  }
}

fn inspect_owner(
  path: String,
) -> Result(LocalFileLockInspection, local_file.LocalFileLockError) {
  let owner_path = path <> "/" <> owner_file
  case path_kind(owner_path) {
    4 -> Error(io_error(path, "inspect local lock owner token failed"))
    2 ->
      case simplifile.read(owner_path) {
        Ok(owner) -> inspect_owner_value(owner)
        Error(error) ->
          Error(io_error(
            path,
            "read local lock owner token failed: "
              <> simplifile.describe_error(error),
          ))
      }
    0 -> Ok(compromised("owner token is missing"))
    _ -> Ok(compromised("owner token is not an unaliased regular file"))
  }
}

fn inspect_owner_value(
  owner: String,
) -> Result(LocalFileLockInspection, local_file.LocalFileLockError) {
  case
    string.is_empty(owner),
    unicode_codepoint_count(owner) > owner_max_codepoints
  {
    True, _ -> Ok(compromised("owner token is empty"))
    _, True ->
      Ok(compromised(
        "owner token exceeds the portable 512-code-point contract bound",
      ))
    False, False -> Ok(LocalFileLockInspection(Held, Some(owner), None))
  }
}

/// Explicit recovery after the caller independently confirms the former owner
/// is inactive and protected local state is quiescent. `Ok(False)` means absent.
pub fn recover(
  lock_root: String,
  lock_name: String,
  expected_owner: String,
  confirmed_inactive: Bool,
) -> Result(Bool, local_file.LocalFileLockError) {
  let path = lock_path(lock_root, lock_name)
  case validate_inputs(lock_root, lock_name, path) {
    Error(error) -> Error(error)
    Ok(Nil) -> validate_recovery_owner(path, expected_owner, confirmed_inactive)
  }
}

fn validate_recovery_owner(
  path: String,
  expected_owner: String,
  confirmed_inactive: Bool,
) -> Result(Bool, local_file.LocalFileLockError) {
  case
    confirmed_inactive,
    string.is_empty(expected_owner),
    unicode_codepoint_count(expected_owner) > owner_max_codepoints
  {
    False, _, _ ->
      Error(local_file.LocalFileLockError(
        local_file.InvalidInput,
        path,
        "explicit confirmed_inactive=true is required for recovery",
      ))
    True, True, _ ->
      Error(local_file.LocalFileLockError(
        local_file.InvalidInput,
        path,
        "expected owner must not be empty",
      ))
    True, _, True ->
      Error(local_file.LocalFileLockError(
        local_file.InvalidInput,
        path,
        "expected owner must not exceed 512 Unicode code points",
      ))
    True, False, False -> recover_inspected(path, expected_owner)
  }
}

fn recover_inspected(
  path: String,
  expected_owner: String,
) -> Result(Bool, local_file.LocalFileLockError) {
  case inspect_path(path) {
    Error(error) -> Error(error)
    Ok(LocalFileLockInspection(Absent, _, _)) -> Ok(False)
    Ok(LocalFileLockInspection(Compromised, _, message)) ->
      Error(
        local_file.LocalFileLockError(
          local_file.Compromised,
          path,
          case message {
            Some(value) -> value
            None -> "local lock state is compromised"
          },
        ),
      )
    Ok(LocalFileLockInspection(Held, Some(owner), _))
      if owner == expected_owner
    -> recover_after_recheck(path, expected_owner)
    Ok(LocalFileLockInspection(Held, _, _)) ->
      Error(local_file.LocalFileLockError(
        local_file.Compromised,
        path,
        "owner token does not match expected recovery owner",
      ))
  }
}

fn recover_after_recheck(
  path: String,
  expected_owner: String,
) -> Result(Bool, local_file.LocalFileLockError) {
  case inspect_path(path) {
    Ok(LocalFileLockInspection(Held, Some(owner), _))
      if owner == expected_owner
    -> remove_recovered(path)
    Error(error) -> Error(error)
    _ ->
      Error(local_file.LocalFileLockError(
        local_file.Compromised,
        path,
        "local lock changed during recovery; refusing deletion",
      ))
  }
}

fn remove_recovered(
  path: String,
) -> Result(Bool, local_file.LocalFileLockError) {
  let owner_path = path <> "/" <> owner_file
  case simplifile.delete_file(at: owner_path) {
    Error(error) ->
      Error(io_error(
        path,
        "remove recovered owner token failed: "
          <> simplifile.describe_error(error),
      ))
    Ok(Nil) ->
      case delete_empty_directory(path) {
        Ok(Nil) -> Ok(True)
        Error(_) ->
          Error(local_file.LocalFileLockError(
            local_file.Compromised,
            path,
            "remove recovered lock directory failed; refusing recursive deletion",
          ))
      }
  }
}

fn validate_inputs(
  lock_root: String,
  lock_name: String,
  path: String,
) -> Result(Nil, local_file.LocalFileLockError) {
  case
    string.is_empty(lock_root),
    string.is_empty(lock_name),
    lock_name == "."
    || lock_name == ".."
    || string.contains(lock_name, "/")
    || string.contains(lock_name, "\\")
  {
    True, _, _ ->
      Error(local_file.LocalFileLockError(
        local_file.InvalidInput,
        path,
        "lock root must not be empty",
      ))
    _, True, _ ->
      Error(local_file.LocalFileLockError(
        local_file.InvalidInput,
        path,
        "lock name must not be empty",
      ))
    _, _, True ->
      Error(local_file.LocalFileLockError(
        local_file.InvalidInput,
        path,
        "lock name must be one non-dot path component",
      ))
    False, False, False -> Ok(Nil)
  }
}

fn compromised(message: String) -> LocalFileLockInspection {
  LocalFileLockInspection(Compromised, None, Some(message))
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

fn io_error(path: String, message: String) -> local_file.LocalFileLockError {
  local_file.LocalFileLockError(local_file.Io, path, message)
}

@external(erlang, "ores_locks_and_leases_local_file_ffi", "path_kind")
fn path_kind(path: String) -> Int

@external(erlang, "ores_locks_and_leases_local_file_ffi", "directory_shape")
fn directory_shape(path: String) -> Int

@external(erlang, "ores_locks_and_leases_local_file_ffi", "delete_empty_directory")
fn delete_empty_directory(path: String) -> Result(Nil, Dynamic)

@external(erlang, "ores_locks_and_leases_local_file_ffi", "unicode_codepoint_count")
fn unicode_codepoint_count(value: String) -> Int
