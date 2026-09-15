//! Portable single-host filesystem locks.
//!
//! This module is intentionally separate from the distributed lease/Postgres
//! plan.  Atomic directory creation is the ownership admission primitive; the
//! `owner` file is diagnostics plus an owner-safe release token, never a stale
//! PID authority.  zed-pkg's Rust hot path should prefer its stronger native
//! descriptor/handle lock (`zed-lock`) when available.

use std::error::Error;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
#[cfg(windows)]
use std::os::windows::fs::MetadataExt;

const OWNER_FILE: &str = "owner";
const OWNER_MAX_CODEPOINTS: usize = 512;
const OWNER_MAX_UTF8_BYTES: usize = OWNER_MAX_CODEPOINTS * 4;
#[cfg(windows)]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;

/// Why the portable local filesystem lock operation failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalFileLockErrorKind {
    /// Another holder already owns the lock and no waiting was requested.
    Contention,
    /// The finite wait budget elapsed before ownership was obtained.
    Timeout,
    /// The lock's owner token changed or its directory was unexpectedly dirty.
    Compromised,
    /// The filesystem rejected an operation for another reason.
    Io,
    /// The caller supplied invalid options or an empty owner token.
    InvalidInput,
}

/// Structured error for the dependency-free local filesystem backend.
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

/// Waiting policy for [`LocalFileLock::acquire`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalFileLockOptions {
    /// When false, acquisition is one immediate attempt.
    pub wait: bool,
    /// Maximum time spent waiting when `wait` is true.
    pub wait_timeout: Duration,
    /// Delay between portable lockfile attempts.
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

/// A held portable filesystem lock.
///
/// The lock is released on drop on a best-effort basis.  Call [`Self::release`]
/// when release failure must be observed.
#[derive(Debug)]
pub struct LocalFileLock {
    path: PathBuf,
    owner: String,
    released: bool,
}

impl LocalFileLock {
    /// Make one immediate atomic attempt to create `path` as the lock directory.
    ///
    /// `owner` must be a non-empty token unique to this logical acquisition.
    /// `Ok(None)` means ordinary contention.
    pub fn try_acquire(
        path: impl AsRef<Path>,
        owner: impl Into<String>,
    ) -> Result<Option<Self>, LocalFileLockError> {
        let path = path.as_ref();
        let owner = owner.into();
        validate_owner(path, &owner)?;

        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)
                    .map_err(|error| LocalFileLockError::io(path, "create lock parent", error))?;
                validate_real_directory(path, parent, "lock parent")?;
            }
        }

        match create_lock_directory(path) {
            Ok(()) => {
                validate_private_lock_directory(path)?;
                let owner_path = path.join(OWNER_FILE);
                let mut owner_options = OpenOptions::new();
                owner_options.write(true).create_new(true);
                #[cfg(unix)]
                owner_options.mode(0o600);
                let owner_file = owner_options.open(&owner_path);
                let mut owner_file = match owner_file {
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
                            format!("create local lock owner token failed: {error}"),
                        ));
                    }
                };
                if let Err(error) = owner_file.write_all(owner.as_bytes()) {
                    drop(owner_file);
                    let _ = fs::remove_file(&owner_path);
                    let _ = fs::remove_dir(path);
                    return Err(LocalFileLockError::io(
                        path,
                        "write local lock owner token",
                        error,
                    ));
                }
                Ok(Some(Self {
                    path: path.to_path_buf(),
                    owner,
                    released: false,
                }))
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                match fs::symlink_metadata(path) {
                    Ok(metadata) if metadata.is_dir() && !metadata_is_alias(&metadata) => Ok(None),
                    Ok(_) => Err(LocalFileLockError::new(
                        LocalFileLockErrorKind::Compromised,
                        path,
                        "lock path already exists but is not an unaliased directory",
                    )),
                    Err(inspect_error) => Err(LocalFileLockError::io(
                        path,
                        "inspect contended local lock path",
                        inspect_error,
                    )),
                }
            }
            Err(error) => Err(LocalFileLockError::io(
                path,
                "atomically create local lock directory",
                error,
            )),
        }
    }

    /// Acquire a local filesystem lock, optionally waiting up to the configured
    /// budget.  This portable backend retries `mkdir`; zed-pkg's native Rust
    /// lock should continue to use one kernel-backed blocking request instead.
    pub fn acquire(
        path: impl AsRef<Path>,
        owner: impl Into<String>,
        options: LocalFileLockOptions,
    ) -> Result<Self, LocalFileLockError> {
        let path = path.as_ref().to_path_buf();
        let owner = owner.into();
        validate_options(&path, &options)?;
        validate_owner(&path, &owner)?;

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

    /// Path used as the atomic lock-directory rendezvous point.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Owner token written inside the lock directory.
    pub fn owner(&self) -> &str {
        &self.owner
    }

    /// Release the lock after verifying the persisted owner token.
    pub fn release(&mut self) -> Result<(), LocalFileLockError> {
        self.release_inner()
    }

    fn release_inner(&mut self) -> Result<(), LocalFileLockError> {
        if self.released {
            return Ok(());
        }

        validate_real_directory(&self.path, &self.path, "lock directory")?;
        validate_private_lock_directory(&self.path)?;
        let owner_path = self.path.join(OWNER_FILE);
        let observed = read_bounded_owner(&self.path, &owner_path)?;
        if observed != self.owner {
            return Err(LocalFileLockError::new(
                LocalFileLockErrorKind::Compromised,
                &self.path,
                "owner token changed; refusing to remove a lock that may belong to another acquisition",
            ));
        }

        fs::remove_file(&owner_path).map_err(|error| {
            LocalFileLockError::io(&self.path, "remove local lock owner token", error)
        })?;
        fs::remove_dir(&self.path).map_err(|error| {
            let kind = if error.kind() == io::ErrorKind::DirectoryNotEmpty {
                LocalFileLockErrorKind::Compromised
            } else {
                LocalFileLockErrorKind::Io
            };
            LocalFileLockError::new(
                kind,
                &self.path,
                format!("remove local lock directory failed: {error}"),
            )
        })?;
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

/// Return whether a portable local lock directory currently exists.
///
/// This is diagnostics only.  A caller must still use `try_acquire`/`acquire`
/// to obtain ownership.
pub fn local_file_lock_exists(path: impl AsRef<Path>) -> Result<bool, LocalFileLockError> {
    let path = path.as_ref();
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

fn validate_owner(path: &Path, owner: &str) -> Result<(), LocalFileLockError> {
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

fn create_lock_directory(path: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(false);
    #[cfg(unix)]
    builder.mode(0o700);
    builder.create(path)
}

fn validate_private_lock_directory(path: &Path) -> Result<(), LocalFileLockError> {
    #[cfg(unix)]
    {
        let metadata = fs::symlink_metadata(path).map_err(|error| {
            LocalFileLockError::io(path, "inspect lock directory permissions", error)
        })?;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(LocalFileLockError::new(
                LocalFileLockErrorKind::Compromised,
                path,
                "lock directory permissions widened beyond the private POSIX contract",
            ));
        }
    }
    Ok(())
}

fn read_bounded_owner(lock_path: &Path, owner_path: &Path) -> Result<String, LocalFileLockError> {
    let path_metadata = match fs::symlink_metadata(owner_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err(LocalFileLockError::new(
                LocalFileLockErrorKind::Compromised,
                lock_path,
                "owner token is missing; refusing to trust altered lock state",
            ));
        }
        Err(error) => {
            return Err(LocalFileLockError::io(
                lock_path,
                "inspect local lock owner token",
                error,
            ));
        }
    };
    if !path_metadata.is_file() || metadata_is_alias(&path_metadata) {
        return Err(LocalFileLockError::new(
            LocalFileLockErrorKind::Compromised,
            lock_path,
            "owner token is not an unaliased regular file",
        ));
    }
    validate_single_link(lock_path, &path_metadata)?;
    if path_metadata.len() > OWNER_MAX_UTF8_BYTES as u64 {
        return Err(LocalFileLockError::new(
            LocalFileLockErrorKind::Compromised,
            lock_path,
            format!(
                "owner token exceeds the portable {OWNER_MAX_UTF8_BYTES}-byte UTF-8 storage bound"
            ),
        ));
    }

    let mut owner_file = File::open(owner_path)
        .map_err(|error| LocalFileLockError::io(lock_path, "open local lock owner token", error))?;
    let opened_metadata = owner_file
        .metadata()
        .map_err(|error| LocalFileLockError::io(lock_path, "inspect opened owner token", error))?;
    if !opened_metadata.is_file() {
        return Err(LocalFileLockError::new(
            LocalFileLockErrorKind::Compromised,
            lock_path,
            "opened owner token is not a regular file",
        ));
    }
    validate_single_link(lock_path, &opened_metadata)?;
    if !same_file_identity(&path_metadata, &opened_metadata) {
        return Err(LocalFileLockError::new(
            LocalFileLockErrorKind::Compromised,
            lock_path,
            "owner token identity changed while opening; refusing raced path-to-handle state",
        ));
    }
    if opened_metadata.len() > OWNER_MAX_UTF8_BYTES as u64 {
        return Err(LocalFileLockError::new(
            LocalFileLockErrorKind::Compromised,
            lock_path,
            format!(
                "owner token exceeds the portable {OWNER_MAX_UTF8_BYTES}-byte UTF-8 storage bound"
            ),
        ));
    }

    let mut owner_bytes = Vec::with_capacity(OWNER_MAX_UTF8_BYTES + 1);
    std::io::Read::by_ref(&mut owner_file)
        .take((OWNER_MAX_UTF8_BYTES + 1) as u64)
        .read_to_end(&mut owner_bytes)
        .map_err(|error| LocalFileLockError::io(lock_path, "read local lock owner token", error))?;
    if owner_bytes.len() > OWNER_MAX_UTF8_BYTES {
        return Err(LocalFileLockError::new(
            LocalFileLockErrorKind::Compromised,
            lock_path,
            format!(
                "owner token exceeds the portable {OWNER_MAX_UTF8_BYTES}-byte UTF-8 storage bound"
            ),
        ));
    }
    let owner = String::from_utf8(owner_bytes).map_err(|_| {
        LocalFileLockError::new(
            LocalFileLockErrorKind::Compromised,
            lock_path,
            "owner token is not valid UTF-8",
        )
    })?;
    if owner.is_empty() || owner.chars().count() > OWNER_MAX_CODEPOINTS {
        return Err(LocalFileLockError::new(
            LocalFileLockErrorKind::Compromised,
            lock_path,
            "owner token violates the portable owner contract",
        ));
    }
    Ok(owner)
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
        Ok(metadata) if metadata.is_file() && !metadata_is_alias(&metadata) => Ok(()),
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

#[cfg(unix)]
fn validate_single_link(
    lock_path: &Path,
    metadata: &fs::Metadata,
) -> Result<(), LocalFileLockError> {
    if metadata.nlink() != 1 {
        return Err(LocalFileLockError::new(
            LocalFileLockErrorKind::Compromised,
            lock_path,
            "owner token has multiple hard links; refusing aliased ownership state",
        ));
    }
    Ok(())
}

#[cfg(not(unix))]
fn validate_single_link(
    _lock_path: &Path,
    _metadata: &fs::Metadata,
) -> Result<(), LocalFileLockError> {
    Ok(())
}

#[cfg(unix)]
fn same_file_identity(path_metadata: &fs::Metadata, opened_metadata: &fs::Metadata) -> bool {
    path_metadata.dev() == opened_metadata.dev() && path_metadata.ino() == opened_metadata.ino()
}

#[cfg(not(unix))]
fn same_file_identity(_path_metadata: &fs::Metadata, _opened_metadata: &fs::Metadata) -> bool {
    true
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
        let error =
            LocalFileLock::try_acquire(&path, "").expect_err("empty owner must be rejected");
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
    fn owner_marker_is_private_on_posix() {
        let path = test_path("private-owner");
        let mut lock = LocalFileLock::try_acquire(&path, "owner-a")
            .expect("acquire")
            .expect("holder");
        let mode = fs::metadata(path.join(OWNER_FILE))
            .expect("owner metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o077, 0, "owner marker must be private");
        lock.release().expect("release private owner lock");
    }

    #[cfg(unix)]
    #[test]
    fn rendezvous_directory_is_private_on_posix() {
        let path = test_path("private-rendezvous");
        let mut lock = LocalFileLock::try_acquire(&path, "owner-a")
            .expect("acquire")
            .expect("holder");
        let mode = fs::metadata(&path)
            .expect("lock directory metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o077, 0, "lock rendezvous must be private");
        lock.release().expect("release private rendezvous lock");
    }

    #[cfg(unix)]
    #[test]
    fn hard_linked_owner_marker_fails_closed() {
        let path = test_path("hard-link-owner");
        let alias = test_path("hard-link-alias");
        let mut lock = LocalFileLock::try_acquire(&path, "owner-a")
            .expect("acquire")
            .expect("holder");
        fs::hard_link(path.join(OWNER_FILE), &alias).expect("create hard-link alias");
        let error = lock
            .release()
            .expect_err("hard-linked owner must fail closed");
        assert_eq!(error.kind, LocalFileLockErrorKind::Compromised);
        fs::remove_file(alias).expect("remove hard-link alias");
        fs::remove_file(path.join(OWNER_FILE)).expect("cleanup owner");
        fs::remove_dir(&path).expect("cleanup lock directory");
        lock.released = true;
    }

    #[test]
    fn persisted_oversize_owner_fails_closed_on_release() {
        let path = test_path("oversize-persisted-owner");
        let mut lock = LocalFileLock::try_acquire(&path, "owner-a")
            .expect("acquire")
            .expect("holder");
        fs::write(path.join(OWNER_FILE), vec![b'a'; OWNER_MAX_UTF8_BYTES + 1])
            .expect("replace owner with oversize marker");
        let error = lock.release().expect_err("oversize owner must fail closed");
        assert_eq!(error.kind, LocalFileLockErrorKind::Compromised);
        fs::remove_file(path.join(OWNER_FILE)).expect("cleanup owner");
        fs::remove_dir(&path).expect("cleanup lock directory");
        lock.released = true;
    }

    #[test]
    fn persisted_invalid_utf8_owner_fails_closed_on_release() {
        let path = test_path("invalid-utf8-persisted-owner");
        let mut lock = LocalFileLock::try_acquire(&path, "owner-a")
            .expect("acquire")
            .expect("holder");
        fs::write(path.join(OWNER_FILE), [0xff]).expect("replace owner with invalid UTF-8");
        let error = lock
            .release()
            .expect_err("invalid UTF-8 owner must fail closed");
        assert_eq!(error.kind, LocalFileLockErrorKind::Compromised);
        fs::remove_file(path.join(OWNER_FILE)).expect("cleanup owner");
        fs::remove_dir(&path).expect("cleanup lock directory");
        lock.released = true;
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
