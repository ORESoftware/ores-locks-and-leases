//! Portable single-host filesystem locks.
//!
//! This module is intentionally separate from the distributed lease/Postgres
//! plan. Atomic directory creation is the ownership admission primitive; the
//! `owner` file is diagnostics plus an owner-safe release token, never a stale
//! PID authority. zed-pkg's Rust hot path should prefer its stronger native
//! descriptor/handle lock (`zed-lock`) when available.

use std::error::Error;
use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
#[cfg(windows)]
use std::os::windows::fs::MetadataExt;

const OWNER_FILE: &str = "owner";
const OWNER_PENDING_FILE: &str = "owner.pending";
const OWNER_MAX_CODEPOINTS: usize = 512;
#[cfg(windows)]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalFileLockErrorKind {
    Contention,
    Timeout,
    Compromised,
    Io,
    InvalidInput,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalFileLockError {
    pub kind: LocalFileLockErrorKind,
    pub path: PathBuf,
    pub message: String,
}

impl LocalFileLockError {
    fn new(kind: LocalFileLockErrorKind, path: &Path, message: impl Into<String>) -> Self {
        Self {
            kind,
            path: path.to_path_buf(),
            message: message.into(),
        }
    }

    fn io(path: &Path, operation: &str, error: io::Error) -> Self {
        Self::new(
            LocalFileLockErrorKind::Io,
            path,
            format!("{operation} failed: {error}"),
        )
    }
}

impl fmt::Display for LocalFileLockError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "local filesystem lock {:?} at `{}`: {}",
            self.kind,
            self.path.display(),
            self.message
        )
    }
}

impl Error for LocalFileLockError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalFileLockOptions {
    pub wait: bool,
    /// End-to-end wait budget. Filesystem-call latency counts against it.
    pub wait_timeout: Duration,
    pub retry_interval: Duration,
}

impl Default for LocalFileLockOptions {
    fn default() -> Self {
        Self {
            wait: true,
            wait_timeout: Duration::from_secs(30),
            retry_interval: Duration::from_millis(50),
        }
    }
}

#[derive(Debug)]
pub struct LocalFileLock {
    path: PathBuf,
    owner: String,
    released: bool,
    release_error: Option<LocalFileLockError>,
}

impl LocalFileLock {
    pub fn try_acquire(
        path: impl AsRef<Path>,
        owner: impl Into<String>,
    ) -> Result<Option<Self>, LocalFileLockError> {
        let path = path.as_ref();
        let owner = owner.into();
        validate_local_file_path(path)?;
        validate_local_file_owner(path, &owner)?;

        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)
                    .map_err(|error| LocalFileLockError::io(path, "create lock parent", error))?;
                validate_real_directory(path, parent, "lock parent")?;
            }
        }

        let mut created = false;
        for transition_attempt in 0..2 {
            match create_lock_directory(path) {
                Ok(()) => {
                    created = true;
                    break;
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    match fs::symlink_metadata(path) {
                        Ok(metadata) if metadata.is_dir() && !metadata_is_alias(&metadata) => {
                            return Ok(None);
                        }
                        Ok(_) => {
                            return Err(LocalFileLockError::new(
                                LocalFileLockErrorKind::Compromised,
                                path,
                                "lock path already exists but is not an unaliased directory",
                            ));
                        }
                        Err(inspect_error)
                            if inspect_error.kind() == io::ErrorKind::NotFound
                                && transition_attempt == 0 =>
                        {
                            continue;
                        }
                        Err(inspect_error) if inspect_error.kind() == io::ErrorKind::NotFound => {
                            return Ok(None);
                        }
                        Err(inspect_error) => {
                            return Err(LocalFileLockError::io(
                                path,
                                "inspect contended local lock path",
                                inspect_error,
                            ));
                        }
                    }
                }
                Err(error) => {
                    return Err(LocalFileLockError::io(
                        path,
                        "atomically create local lock directory",
                        error,
                    ));
                }
            }
        }
        if !created {
            return Ok(None);
        }

        let owner_path = path.join(OWNER_FILE);
        let pending_path = path.join(OWNER_PENDING_FILE);
        let mut owner_options = OpenOptions::new();
        owner_options.write(true).create_new(true);
        #[cfg(unix)]
        owner_options.mode(0o600);
        let mut owner_file = match owner_options.open(&pending_path) {
            Ok(file) => file,
            Err(error) => {
                let _ = fs::remove_dir(path);
                let kind = if error.kind() == io::ErrorKind::AlreadyExists {
                    LocalFileLockErrorKind::Compromised
                } else {
                    LocalFileLockErrorKind::Io
                };
                return Err(LocalFileLockError::new(
                    kind,
                    path,
                    format!("create pending local lock owner token failed: {error}"),
                ));
            }
        };
        if let Err(error) = owner_file.write_all(owner.as_bytes()) {
            drop(owner_file);
            let _ = fs::remove_file(&pending_path);
            let _ = fs::remove_dir(path);
            return Err(LocalFileLockError::io(
                path,
                "write pending local lock owner token",
                error,
            ));
        }
        if let Err(error) = owner_file.sync_data() {
            drop(owner_file);
            let _ = fs::remove_file(&pending_path);
            let _ = fs::remove_dir(path);
            return Err(LocalFileLockError::io(
                path,
                "sync pending local lock owner token",
                error,
            ));
        }
        drop(owner_file);

        match fs::symlink_metadata(&owner_path) {
            Ok(_) => {
                let _ = fs::remove_file(&pending_path);
                let _ = fs::remove_dir(path);
                return Err(LocalFileLockError::new(
                    LocalFileLockErrorKind::Compromised,
                    path,
                    "published owner target already exists before atomic publication",
                ));
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                let _ = fs::remove_file(&pending_path);
                let _ = fs::remove_dir(path);
                return Err(LocalFileLockError::io(
                    path,
                    "inspect owner publication target",
                    error,
                ));
            }
        }
        if let Err(error) = fs::rename(&pending_path, &owner_path) {
            let _ = fs::remove_file(&pending_path);
            let _ = fs::remove_dir(path);
            return Err(LocalFileLockError::io(
                path,
                "atomically publish local lock owner token",
                error,
            ));
        }

        Ok(Some(Self {
            path: path.to_path_buf(),
            owner,
            released: false,
            release_error: None,
        }))
    }

    pub fn acquire(
        path: impl AsRef<Path>,
        owner: impl Into<String>,
        options: LocalFileLockOptions,
    ) -> Result<Self, LocalFileLockError> {
        let path = path.as_ref().to_path_buf();
        let owner = owner.into();
        validate_local_file_path(&path)?;
        validate_options(&path, &options)?;
        validate_local_file_owner(&path, &owner)?;

        let started = Instant::now();
        loop {
            if let Some(lock) = Self::try_acquire(&path, owner.clone())? {
                return Ok(lock);
            }
            if !options.wait {
                return Err(LocalFileLockError::new(
                    LocalFileLockErrorKind::Contention,
                    &path,
                    "lock is already held by another owner",
                ));
            }
            let elapsed = started.elapsed();
            if elapsed >= options.wait_timeout {
                return Err(LocalFileLockError::new(
                    LocalFileLockErrorKind::Timeout,
                    &path,
                    format!(
                        "timed out after {} ms waiting for local lock",
                        options.wait_timeout.as_millis()
                    ),
                ));
            }
            let remaining = options.wait_timeout.saturating_sub(elapsed);
            thread::sleep(options.retry_interval.min(remaining));
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn owner(&self) -> &str {
        &self.owner
    }

    pub fn release(&mut self) -> Result<(), LocalFileLockError> {
        self.release_inner()
    }

    fn release_inner(&mut self) -> Result<(), LocalFileLockError> {
        if self.released {
            return Ok(());
        }
        if let Some(error) = &self.release_error {
            return Err(error.clone());
        }

        validate_real_directory(&self.path, &self.path, "lock directory")?;
        let owner_path = self.path.join(OWNER_FILE);
        validate_regular_file(&self.path, &owner_path, "owner token")?;
        let observed = match fs::read(&owner_path) {
            Ok(observed) => observed,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Err(LocalFileLockError::new(
                    LocalFileLockErrorKind::Compromised,
                    &self.path,
                    "owner token is missing; refusing to treat externally altered lock state as a successful release",
                ));
            }
            Err(error) => {
                return Err(LocalFileLockError::io(
                    &self.path,
                    "read local lock owner token",
                    error,
                ));
            }
        };
        if observed != self.owner.as_bytes() {
            return Err(LocalFileLockError::new(
                LocalFileLockErrorKind::Compromised,
                &self.path,
                "owner token changed; refusing to remove a lock that may belong to another acquisition",
            ));
        }

        validate_regular_file(&self.path, &owner_path, "owner token")?;
        fs::remove_file(&owner_path).map_err(|error| {
            LocalFileLockError::io(&self.path, "remove local lock owner token", error)
        })?;
        if let Err(error) = fs::remove_dir(&self.path) {
            let kind = if error.kind() == io::ErrorKind::DirectoryNotEmpty {
                LocalFileLockErrorKind::Compromised
            } else {
                LocalFileLockErrorKind::Io
            };
            let wrapped = LocalFileLockError::new(
                kind,
                &self.path,
                format!("remove local lock directory failed: {error}"),
            );
            self.release_error = Some(wrapped.clone());
            return Err(wrapped);
        }
        self.released = true;
        Ok(())
    }
}

impl Drop for LocalFileLock {
    fn drop(&mut self) {
        if !self.released {
            let _ = self.release_inner();
        }
    }
}

pub fn local_file_lock_exists(path: impl AsRef<Path>) -> Result<bool, LocalFileLockError> {
    let path = path.as_ref();
    validate_local_file_path(path)?;
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata_is_alias(&metadata) => Ok(true),
        Ok(_) => Err(LocalFileLockError::new(
            LocalFileLockErrorKind::Compromised,
            path,
            "lock path exists but is not an unaliased directory",
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(LocalFileLockError::io(
            path,
            "inspect local lock path",
            error,
        )),
    }
}

pub(crate) fn validate_local_file_path(path: &Path) -> Result<(), LocalFileLockError> {
    if path.as_os_str().is_empty() {
        return Err(LocalFileLockError::new(
            LocalFileLockErrorKind::InvalidInput,
            path,
            "local lock path must not be empty",
        ));
    }
    let text = path.to_str().ok_or_else(|| {
        LocalFileLockError::new(
            LocalFileLockErrorKind::InvalidInput,
            path,
            "local lock path must be valid Unicode scalar data",
        )
    })?;
    if text.contains('\0') {
        return Err(LocalFileLockError::new(
            LocalFileLockErrorKind::InvalidInput,
            path,
            "local lock path must not contain NUL",
        ));
    }
    #[cfg(windows)]
    if !windows_local_file_lock_path_admitted(text) {
        return Err(LocalFileLockError::new(
            LocalFileLockErrorKind::InvalidInput,
            path,
            "Windows local lock paths must avoid device namespaces, reserved device names, trailing dot/space components, and alternate-data-stream syntax",
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn windows_local_file_lock_path_admitted(text: &str) -> bool {
    let normalized = text.replace('\\', "/");
    let lower = normalized.to_ascii_lowercase();
    if lower.starts_with("//?/") || lower.starts_with("//./") || lower.starts_with("/??/") {
        return false;
    }

    let mut first = true;
    for component in normalized.split('/') {
        if component.is_empty() {
            continue;
        }
        if component == "." || component == ".." {
            continue;
        }
        let bytes = component.as_bytes();
        if first
            && bytes.len() == 2
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
        {
            first = false;
            continue;
        }
        first = false;
        if component.ends_with('.') || component.ends_with(' ') || component.contains(':') {
            return false;
        }
        let base = component.split('.').next().unwrap_or_default().trim();
        if windows_reserved_device_base(base) {
            return false;
        }
    }
    true
}

#[cfg(windows)]
fn windows_reserved_device_base(base: &str) -> bool {
    matches!(
        base.to_ascii_uppercase().as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

fn create_lock_directory(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        let mut builder = fs::DirBuilder::new();
        builder.mode(0o700);
        builder.create(path)
    }
    #[cfg(not(unix))]
    {
        fs::create_dir(path)
    }
}

pub(crate) fn validate_local_file_owner(path: &Path, owner: &str) -> Result<(), LocalFileLockError> {
    if owner.is_empty() {
        return Err(LocalFileLockError::new(
            LocalFileLockErrorKind::InvalidInput,
            path,
            "owner token must not be empty",
        ));
    }
    if owner.chars().count() > OWNER_MAX_CODEPOINTS {
        return Err(LocalFileLockError::new(
            LocalFileLockErrorKind::InvalidInput,
            path,
            "owner token must not exceed 512 Unicode code points",
        ));
    }
    Ok(())
}

fn validate_options(path: &Path, options: &LocalFileLockOptions) -> Result<(), LocalFileLockError> {
    if options.wait && options.retry_interval.is_zero() {
        return Err(LocalFileLockError::new(
            LocalFileLockErrorKind::InvalidInput,
            path,
            "retry interval must be greater than zero when waiting",
        ));
    }
    Ok(())
}

fn validate_real_directory(
    lock_path: &Path,
    path: &Path,
    label: &str,
) -> Result<(), LocalFileLockError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata_is_alias(&metadata) => Ok(()),
        Ok(_) => Err(LocalFileLockError::new(
            LocalFileLockErrorKind::Compromised,
            lock_path,
            format!("{label} is not an unaliased directory"),
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Err(LocalFileLockError::new(
            LocalFileLockErrorKind::Compromised,
            lock_path,
            format!("{label} is missing"),
        )),
        Err(error) => Err(LocalFileLockError::io(
            lock_path,
            &format!("inspect {label}"),
            error,
        )),
    }
}

fn validate_regular_file(
    lock_path: &Path,
    path: &Path,
    label: &str,
) -> Result<(), LocalFileLockError> {
    match fs::symlink_metadata(path) {
        Ok(metadata)
            if metadata.is_file()
                && !metadata_is_alias(&metadata)
                && !metadata_has_multiple_links(&metadata) =>
        {
            Ok(())
        }
        Ok(metadata) if metadata.is_file() && metadata_has_multiple_links(&metadata) => {
            Err(LocalFileLockError::new(
                LocalFileLockErrorKind::Compromised,
                lock_path,
                format!("{label} has multiple filesystem links"),
            ))
        }
        Ok(_) => Err(LocalFileLockError::new(
            LocalFileLockErrorKind::Compromised,
            lock_path,
            format!("{label} is not an unaliased regular file"),
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Err(LocalFileLockError::new(
            LocalFileLockErrorKind::Compromised,
            lock_path,
            format!("{label} is missing"),
        )),
        Err(error) => Err(LocalFileLockError::io(
            lock_path,
            &format!("inspect {label}"),
            error,
        )),
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_ID: AtomicU64 = AtomicU64::new(1);

    fn test_path(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "ores-locks-local-{name}-{}-{nonce}-{}",
            std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn contention_then_release_then_reacquire() {
        let path = test_path("contention");
        let mut first = LocalFileLock::try_acquire(&path, "owner-a")
            .expect("first acquire")
            .expect("first holder");
        assert!(
            LocalFileLock::try_acquire(&path, "owner-b")
                .expect("contended attempt")
                .is_none()
        );
        first.release().expect("release first holder");
        let mut second = LocalFileLock::try_acquire(&path, "owner-b")
            .expect("second acquire")
            .expect("second holder");
        second.release().expect("release second holder");
        assert!(!local_file_lock_exists(&path).expect("lock existence"));
    }

    #[test]
    fn no_wait_reports_contention() {
        let path = test_path("no-wait");
        let _first = LocalFileLock::try_acquire(&path, "owner-a")
            .expect("first acquire")
            .expect("first holder");
        let error = LocalFileLock::acquire(
            &path,
            "owner-b",
            LocalFileLockOptions {
                wait: false,
                ..LocalFileLockOptions::default()
            },
        )
        .expect_err("second holder must contend");
        assert_eq!(error.kind, LocalFileLockErrorKind::Contention);
    }

    #[test]
    fn finite_wait_times_out() {
        let path = test_path("timeout");
        let _first = LocalFileLock::try_acquire(&path, "owner-a")
            .expect("first acquire")
            .expect("first holder");
        let error = LocalFileLock::acquire(
            &path,
            "owner-b",
            LocalFileLockOptions {
                wait: true,
                wait_timeout: Duration::from_millis(20),
                retry_interval: Duration::from_millis(5),
            },
        )
        .expect_err("second holder must time out");
        assert_eq!(error.kind, LocalFileLockErrorKind::Timeout);
    }

    #[test]
    fn zero_timeout_under_contention_times_out_immediately() {
        let path = test_path("zero-timeout");
        let _first = LocalFileLock::try_acquire(&path, "owner-a")
            .expect("first acquire")
            .expect("first holder");
        let error = LocalFileLock::acquire(
            &path,
            "owner-b",
            LocalFileLockOptions {
                wait: true,
                wait_timeout: Duration::ZERO,
                retry_interval: Duration::from_millis(50),
            },
        )
        .expect_err("zero wait budget must time out under contention");
        assert_eq!(error.kind, LocalFileLockErrorKind::Timeout);
    }

    #[test]
    fn empty_owner_is_invalid_input() {
        let path = test_path("empty-owner");
        let error = LocalFileLock::try_acquire(&path, "")
            .expect_err("empty owner must be rejected");
        assert_eq!(error.kind, LocalFileLockErrorKind::InvalidInput);
    }

    #[test]
    fn owner_at_max_codepoints_is_valid() {
        let path = test_path("max-owner");
        let owner = "😀".repeat(512);
        let mut lock = LocalFileLock::try_acquire(&path, owner)
            .expect("512-code-point owner must be valid")
            .expect("holder");
        lock.release().expect("release max owner lock");
    }

    #[test]
    fn oversized_owner_is_invalid_input() {
        let path = test_path("oversized-owner");
        let error = LocalFileLock::try_acquire(&path, "😀".repeat(513))
            .expect_err("513-code-point owner must be rejected");
        assert_eq!(error.kind, LocalFileLockErrorKind::InvalidInput);
    }

    #[cfg(unix)]
    #[test]
    fn lock_directory_and_owner_marker_are_private_on_posix() {
        use std::os::unix::fs::PermissionsExt;
        let path = test_path("private-lock");
        let mut lock = LocalFileLock::try_acquire(&path, "owner-a")
            .expect("acquire")
            .expect("holder");
        let directory_mode = fs::metadata(&path)
            .expect("lock directory metadata")
            .permissions()
            .mode();
        assert_eq!(directory_mode & 0o077, 0, "lock directory must be private");
        let owner_mode = fs::metadata(path.join(OWNER_FILE))
            .expect("owner metadata")
            .permissions()
            .mode();
        assert_eq!(owner_mode & 0o077, 0, "owner marker must be private");
        lock.release().expect("release private owner lock");
    }

    #[test]
    fn existing_regular_file_is_compromised_not_contention() {
        let path = test_path("existing-file");
        fs::write(&path, b"not a lock directory").expect("seed regular file");
        let error = LocalFileLock::try_acquire(&path, "owner-a")
            .expect_err("regular file must not be treated as normal contention");
        assert_eq!(error.kind, LocalFileLockErrorKind::Compromised);
        fs::remove_file(path).expect("cleanup regular file");
    }

    #[test]
    fn changed_owner_token_fails_closed() {
        let path = test_path("compromised");
        let mut lock = LocalFileLock::try_acquire(&path, "owner-a")
            .expect("acquire")
            .expect("holder");
        fs::write(path.join(OWNER_FILE), b"owner-b").expect("replace owner token");
        let error = lock.release().expect_err("release must fail closed");
        assert_eq!(error.kind, LocalFileLockErrorKind::Compromised);
        fs::remove_file(path.join(OWNER_FILE)).expect("cleanup owner");
        fs::remove_dir(path).expect("cleanup lock");
        lock.released = true;
    }

    #[test]
    fn missing_owner_token_fails_closed() {
        let path = test_path("missing-owner");
        let mut lock = LocalFileLock::try_acquire(&path, "owner-a")
            .expect("acquire")
            .expect("holder");
        fs::remove_file(path.join(OWNER_FILE)).expect("remove owner marker");
        let error = lock.release().expect_err("missing owner must fail closed");
        assert_eq!(error.kind, LocalFileLockErrorKind::Compromised);
        fs::remove_dir(&path).expect("cleanup lock directory");
        lock.released = true;
    }

    #[test]
    fn unicode_nested_path_round_trips() {
        let path = test_path("unicode").join("锁").join("paquete-ñ.lock");
        let mut lock = LocalFileLock::try_acquire(&path, "owner-λ")
            .expect("unicode acquire")
            .expect("unicode holder");
        assert_eq!(lock.owner(), "owner-λ");
        lock.release().expect("unicode release");
        assert!(!local_file_lock_exists(&path).expect("lock existence"));
    }
}
