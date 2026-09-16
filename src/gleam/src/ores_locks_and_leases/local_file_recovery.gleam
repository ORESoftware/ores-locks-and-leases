//// Explicit read-only inspection and operator-driven recovery for portable locks.

import gleam/dynamic.{type Dynamic}
import gleam/option.{type Option, None, Some}
import gleam/string
import ores_locks_and_leases/local_file
import ores_locks_and_leases/local_file_owner_validation as owner_validation
import simplifile

const owner_file = "owner"
const owner_recovering_file = "owner.recovering"

pub type LocalFileLockInspectionState {
  Absent
  Held
  Incomplete
  Compromised
}

/// Stable machine-readable diagnostic reason shared with the authored local
/// TypeSpec and JSON Schema authorities.
pub type LocalFileLockInspectionReason {
  OwnerMarkerMissing
  PathNotDirectory
  DirtyDirectory
  OwnerNotRegularFile
  OwnerTooLarge
  OwnerInvalidUtf8
  OwnerIdentityChanged
  PermissionsWidened
  OwnerContractViolation
}

pub fn inspection_reason_string(
  reason: LocalFileLockInspectionReason,
) -> String {
  case reason {
    OwnerMarkerMissing -> "owner_marker_missing"
    PathNotDirectory -> "path_not_directory"
    DirtyDirectory -> "dirty_directory"
    OwnerNotRegularFile -> "owner_not_regular_file"
    OwnerTooLarge -> "owner_too_large"
    OwnerInvalidUtf8 -> "owner_invalid_utf8"
    OwnerIdentityChanged -> "owner_identity_changed"
    PermissionsWidened -> "permissions_widened"
    OwnerContractViolation -> "owner_contract_violation"
  }
}

pub type LocalFileLockInspection {
  LocalFileLockInspection(
    state: LocalFileLockInspectionState,
    owner: Option(String),
    reason: Option(LocalFileLockInspectionReason),
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
    0 -> Ok(LocalFileLockInspection(Absent, None, None, None))
    4 -> Error(io_error(path, "inspect local lock path failed"))
    1 -> inspect_directory(path)
    _ ->
      Ok(compromised(
        PathNotDirectory,
        "lock path is not an unaliased directory",
      ))
  }
}

fn inspect_directory(
  path: String,
) -> Result(LocalFileLockInspection, local_file.LocalFileLockError) {
  case directory_shape(path) {
    2 -> Error(io_error(path, "list local lock directory failed"))
    3 ->
      Ok(incomplete(
        "lock directory has no published owner authority; acquisition, release, or recovery may be mid-transition",
      ))
    1 ->
      Ok(compromised(
        DirtyDirectory,
        "lock directory must contain exactly one owner marker",
      ))
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
    0 -> Ok(incomplete("owner token disappeared during inspection"))
    _ ->
      Ok(compromised(
        OwnerNotRegularFile,
        "owner token is not an unaliased regular file",
      ))
  }
}

fn inspect_owner_value(
  owner: String,
) -> Result(LocalFileLockInspection, local_file.LocalFileLockError) {
  case owner_validation.validate(owner) {
    owner_validation.OwnerEmpty ->
      Ok(compromised(OwnerContractViolation, "owner token is empty"))
    owner_validation.OwnerOversized ->
      Ok(compromised(
        OwnerContractViolation,
        "owner token exceeds the portable 512-code-point contract bound",
      ))
    owner_validation.OwnerValid ->
      Ok(LocalFileLockInspection(Held, Some(owner), None, None))
  }
}

/// Explicit recovery after the caller independently confirms the former owner
/// is inactive and protected local state is quiescent. `Ok(False)` means absent.
/// Ownerless incomplete crash-window state is never auto-recovered.
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
  case confirmed_inactive, owner_validation.validate(expected_owner) {
    False, _ ->
      Error(local_file.LocalFileLockError(
        local_file.InvalidInput,
        path,
        "explicit confirmed_inactive=true is required for recovery",
      ))
    True, owner_validation.OwnerEmpty ->
      Error(local_file.LocalFileLockError(
        local_file.InvalidInput,
        path,
        "expected owner must not be empty",
      ))
    True, owner_validation.OwnerOversized ->
      Error(local_file.LocalFileLockError(
        local_file.InvalidInput,
        path,
        "expected owner must not exceed 512 Unicode code points",
      ))
    True, owner_validation.OwnerValid -> recover_inspected(path, expected_owner)
  }
}

fn recover_inspected(
  path: String,
  expected_owner: String,
) -> Result(Bool, local_file.LocalFileLockError) {
  case inspect_path(path) {
    Error(error) -> Error(error)
    Ok(LocalFileLockInspection(Absent, _, _, _)) -> Ok(False)
    Ok(LocalFileLockInspection(Incomplete, _, _, _)) ->
      Error(local_file.LocalFileLockError(
        local_file.Compromised,
        path,
        "incomplete lock state has no owner identity; refusing automatic recovery",
      ))
    Ok(LocalFileLockInspection(Compromised, _, _, message)) ->
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
    Ok(LocalFileLockInspection(Held, Some(owner), _, _))
      if owner == expected_owner
    -> recover_after_recheck(path, expected_owner)
    Ok(LocalFileLockInspection(Held, _, _, _)) ->
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
    Ok(LocalFileLockInspection(Held, Some(owner), _, _))
      if owner == expected_owner
    -> claim_and_remove_recovered(path)
    Error(error) -> Error(error)
    _ ->
      Error(local_file.LocalFileLockError(
        local_file.Compromised,
        path,
        "local lock changed during recovery; refusing deletion",
      ))
  }
}

fn claim_and_remove_recovered(
  path: String,
) -> Result(Bool, local_file.LocalFileLockError) {
  let owner_path = path <> "/" <> owner_file
  let recovering_path = path <> "/" <> owner_recovering_file
  case claim_recovery_status(owner_path, recovering_path) {
    0 -> remove_recovered_claim(path, recovering_path)
    1 -> Ok(False)
    2 ->
      Error(local_file.LocalFileLockError(
        local_file.Compromised,
        path,
        "recovery claim already exists; another recovery may own the destructive transition",
      ))
    _ -> Error(io_error(path, "claim local lock recovery failed"))
  }
}

fn remove_recovered_claim(
  path: String,
  recovering_path: String,
) -> Result(Bool, local_file.LocalFileLockError) {
  case simplifile.delete_file(at: recovering_path) {
    Error(error) ->
      Error(io_error(
        path,
        "remove recovered owner claim failed: "
          <> simplifile.describe_error(error),
      ))
    Ok(Nil) ->
      case delete_empty_directory(path) {
        Ok(Nil) -> Ok(True)
        Error(_) ->
          Error(local_file.LocalFileLockError(
            local_file.Compromised,
            path,
            "remove recovered lock directory failed after recovery claim; refusing recursive deletion",
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

fn incomplete(message: String) -> LocalFileLockInspection {
  LocalFileLockInspection(
    Incomplete,
    None,
    Some(OwnerMarkerMissing),
    Some(message),
  )
}

fn compromised(
  reason: LocalFileLockInspectionReason,
  message: String,
) -> LocalFileLockInspection {
  LocalFileLockInspection(Compromised, None, Some(reason), Some(message))
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

@external(erlang, "ores_locks_and_leases_local_file_recovery_ffi", "directory_shape")
fn directory_shape(path: String) -> Int

@external(erlang, "ores_locks_and_leases_local_file_recovery_ffi", "claim_recovery_status")
fn claim_recovery_status(owner_path: String, recovering_path: String) -> Int

@external(erlang, "ores_locks_and_leases_local_file_ffi", "delete_empty_directory")
fn delete_empty_directory(path: String) -> Result(Nil, Dynamic)
