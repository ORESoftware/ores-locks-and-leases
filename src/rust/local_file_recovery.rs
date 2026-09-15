//! Explicit inspection and operator-driven recovery for portable local locks.

use crate::local_file::{
    LocalFileLockError, LocalFileLockErrorKind, validate_local_file_owner, validate_local_file_path,
};
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::Path;

#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
#[cfg(windows)]
use std::os::windows::fs::MetadataExt;

const OWNER_FILE: &str = "owner";
const OWNER_MAX_CODEPOINTS: usize = 512;
const OWNER_MAX_UTF8_BYTES: usize = 2048;
#[cfg(windows)]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalFileLockInspectionState {
    Absent,
    Held,
    /// The rendezvous directory exists but contains no owner marker.
    ///
    /// This is the observable crash window either after atomic `mkdir` and
    /// before owner publication, or after owner removal and before `rmdir`.
    /// It is never treated as stale authority and is never auto-recovered.
    Incomplete,
    Compromised,
}

/// Stable machine-readable diagnostic reason aligned with the independent
/// TypeSpec and authored JSON Schema local-file authorities.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalFileLockInspectionReason {
    OwnerMarkerMissing,
    PathNotDirectory,
    DirtyDirectory,
    OwnerNotRegularFile,
    OwnerTooLarge,
    OwnerInvalidUtf8,
    OwnerIdentityChanged,
    PermissionsWidened,
    OwnerContractViolation,
}

impl LocalFileLockInspectionReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::OwnerMarkerMissing => "owner_marker_missing",
            Self::PathNotDirectory => "path_not_directory",
            Self::DirtyDirectory => "dirty_directory",
            Self::OwnerNotRegularFile => "owner_not_regular_file",
            Self::OwnerTooLarge => "owner_too_large",
            Self::OwnerInvalidUtf8 => "owner_invalid_utf8",
            Self::OwnerIdentityChanged => "owner_identity_changed",
            Self::PermissionsWidened => "permissions_widened",
            Self::OwnerContractViolation => "owner_contract_violation",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalFileLockInspection {
    pub state: LocalFileLockInspectionState,
    pub owner: Option<String>,
    pub reason: Option<LocalFileLockInspectionReason>,
    pub message: Option<String>,
}

/// Inspect portable lock state without claiming ownership or mutating it.
pub fn inspect_local_file_lock(
    path: impl AsRef<Path>,
) -> Result<LocalFileLockInspection, LocalFileLockError> {
    let path = path.as_ref();
    validate_local_file_path(path)?;
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(LocalFileLockInspection {
                state: LocalFileLockInspectionState::Absent,
                owner: None,
                reason: None,
                message: None,
            });
        }
        Err(error) => return Err(io_error(path, "inspect local lock path", error)),
    };
    if !metadata.is_dir() || metadata_is_alias(&metadata) {
        return Ok(compromised(
            LocalFileLockInspectionReason::PathNotDirectory,
            "lock path is not an unaliased directory",
        ));
    }

    let entries = fs::read_dir(path)
        .map_err(|error| io_error(path, "list local lock directory", error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| io_error(path, "read local lock directory entry", error))?;
    if entries.is_empty() {
        return Ok(incomplete(
            "lock directory has no owner marker; acquisition or release may have crashed mid-transition",
        ));
    }
    if entries.len() != 1 || entries[0].file_name() != OWNER_FILE {
        return Ok(compromised(
            LocalFileLockInspectionReason::DirtyDirectory,
            "lock directory must contain exactly one owner marker",
        ));
    }

    let owner_path = path.join(OWNER_FILE);
    let owner_metadata = match fs::symlink_metadata(&owner_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(incomplete("owner token disappeared during inspection"));
        }
        Err(error) => return Err(io_error(path, "inspect local lock owner token", error)),
    };
    if !owner_metadata.is_file() || metadata_is_alias(&owner_metadata) {
        return Ok(compromised(
            LocalFileLockInspectionReason::OwnerNotRegularFile,
            "owner token is not an unaliased regular file",
        ));
    }
    if metadata_has_multiple_links(&owner_metadata) {
        return Ok(compromised(
            LocalFileLockInspectionReason::OwnerIdentityChanged,
            "owner token has multiple filesystem links; refusing aliased ownership state",
        ));
    }
    if owner_metadata.len() > OWNER_MAX_UTF8_BYTES as u64 {
        return Ok(compromised(
            LocalFileLockInspectionReason::OwnerTooLarge,
            "owner token exceeds the portable 2048-byte UTF-8 storage bound",
        ));
    }

    let mut owner_file = match File::open(&owner_path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(incomplete("owner token disappeared during inspection"));
        }
        Err(error) => return Err(io_error(path, "open local lock owner token", error)),
    };
    let opened_metadata = owner_file
        .metadata()
        .map_err(|error| io_error(path, "reinspect opened local lock owner token", error))?;
    if !opened_metadata.is_file() || metadata_is_alias(&opened_metadata) {
        return Ok(compromised(
            LocalFileLockInspectionReason::OwnerNotRegularFile,
            "opened owner token is not an unaliased regular file",
        ));
    }
    if metadata_has_multiple_links(&opened_metadata) {
        return Ok(compromised(
            LocalFileLockInspectionReason::OwnerIdentityChanged,
            "opened owner token became multiply linked while inspecting",
        ));
    }

    let mut owner_bytes = Vec::with_capacity(OWNER_MAX_UTF8_BYTES + 1);
    owner_file
        .by_ref()
        .take((OWNER_MAX_UTF8_BYTES + 1) as u64)
        .read_to_end(&mut owner_bytes)
        .map_err(|error| io_error(path, "read local lock owner token", error))?;
    if owner_bytes.len() > OWNER_MAX_UTF8_BYTES {
        return Ok(compromised(
            LocalFileLockInspectionReason::OwnerTooLarge,
            "owner token exceeds the portable 2048-byte UTF-8 storage bound",
        ));
    }
    let owner = match String::from_utf8(owner_bytes) {
        Ok(owner) => owner,
        Err(_) => {
            return Ok(compromised(
                LocalFileLockInspectionReason::OwnerInvalidUtf8,
                "owner token is not valid UTF-8",
            ));
        }
    };
    if owner.is_empty() {
        return Ok(compromised(
            LocalFileLockInspectionReason::OwnerContractViolation,
            "owner token is empty",
        ));
    }
    if owner.chars().count() > OWNER_MAX_CODEPOINTS {
        return Ok(compromised(
            LocalFileLockInspectionReason::OwnerContractViolation,
            "owner token exceeds the portable 512-code-point contract bound",
        ));
    }

    Ok(LocalFileLockInspection {
        state: LocalFileLockInspectionState::Held,
        owner: Some(owner),
        reason: None,
        message: None,
    })
}

/// Explicitly recover one clean portable lock after an operator independently
/// confirms that its previous owner is inactive and protected state is quiescent.
///
/// Returns `Ok(false)` when the lock is already absent. Incomplete crash-window
/// state is intentionally not removed because no owner identity remains to
/// authenticate; callers must resolve it out of band rather than stale-steal.
pub fn recover_local_file_lock(
    path: impl AsRef<Path>,
    expected_owner: &str,
    confirmed_inactive: bool,
) -> Result<bool, LocalFileLockError> {
    let path = path.as_ref();
    validate_local_file_path(path)?;
    if !confirmed_inactive {
        return Err(error(
            LocalFileLockErrorKind::InvalidInput,
            path,
            "explicit confirmed_inactive=true is required for recovery",
        ));
    }
    validate_local_file_owner(path, expected_owner)?;

    let inspection = inspect_local_file_lock(path)?;
    match inspection.state {
        LocalFileLockInspectionState::Absent => return Ok(false),
        LocalFileLockInspectionState::Incomplete => {
            return Err(error(
                LocalFileLockErrorKind::Compromised,
                path,
                "incomplete lock state has no owner identity; refusing automatic recovery",
            ));
        }
        LocalFileLockInspectionState::Compromised => {
            return Err(error(
                LocalFileLockErrorKind::Compromised,
                path,
                inspection
                    .message
                    .unwrap_or_else(|| "local lock state is compromised".to_owned()),
            ));
        }
        LocalFileLockInspectionState::Held => {}
    }
    if inspection.owner.as_deref() != Some(expected_owner) {
        return Err(error(
            LocalFileLockErrorKind::Compromised,
            path,
            "owner token does not match expected recovery owner",
        ));
    }

    // Re-inspect immediately before destructive action so recovery never relies
    // on an earlier snapshot after the operator confirmation step.
    let final_inspection = inspect_local_file_lock(path)?;
    if final_inspection.state != LocalFileLockInspectionState::Held
        || final_inspection.owner.as_deref() != Some(expected_owner)
    {
        return Err(error(
            LocalFileLockErrorKind::Compromised,
            path,
            "local lock changed during recovery; refusing deletion",
        ));
    }

    let owner_path = path.join(OWNER_FILE);
    fs::remove_file(&owner_path)
        .map_err(|error| io_error(path, "remove recovered owner token", error))?;
    fs::remove_dir(path).map_err(|remove_error| {
        let kind = match fs::read_dir(path) {
            Ok(mut entries) => {
                if entries.next().is_some() {
                    LocalFileLockErrorKind::Compromised
                } else {
                    LocalFileLockErrorKind::Io
                }
            }
            Err(_) => LocalFileLockErrorKind::Io,
        };
        error(
            kind,
            path,
            format!("remove recovered lock directory failed: {remove_error}"),
        )
    })?;
    Ok(true)
}

fn incomplete(message: &str) -> LocalFileLockInspection {
    LocalFileLockInspection {
        state: LocalFileLockInspectionState::Incomplete,
        owner: None,
        reason: Some(LocalFileLockInspectionReason::OwnerMarkerMissing),
        message: Some(message.to_owned()),
    }
}

fn compromised(
    reason: LocalFileLockInspectionReason,
    message: &str,
) -> LocalFileLockInspection {
    LocalFileLockInspection {
        state: LocalFileLockInspectionState::Compromised,
        owner: None,
        reason: Some(reason),
        message: Some(message.to_owned()),
    }
}

fn error(
    kind: LocalFileLockErrorKind,
    path: &Path,
    message: impl Into<String>,
) -> LocalFileLockError {
    LocalFileLockError {
        kind,
        path: path.to_path_buf(),
        message: message.into(),
    }
}

fn io_error(path: &Path, operation: &str, source: io::Error) -> LocalFileLockError {
    error(
        LocalFileLockErrorKind::Io,
        path,
        format!("{operation} failed: {source}"),
    )
}

fn metadata_is_alias(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        return metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn metadata_has_multiple_links(metadata: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        metadata.nlink() != 1
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        false
    }
}
