//! Portable single-host filesystem locks.
//!
//! This module is intentionally separate from the distributed lease/Postgres
//! plan.  Atomic directory creation is the ownership admission primitive; the
//! `owner` file is diagnostics plus an owner-safe release token, never a stale
//! PID authority.  zed-pkg's Rust hot path should prefer its stronger native
//! descriptor/handle lock (`zed-lock`) when available.

use std::error::Error;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

const OWNER_FILE: &str = "owner";

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
            }
        }

        match fs::create_dir(path) {
            Ok(()) => {
                let owner_path = path.join(OWNER_FILE);
                if let Err(error) = fs::write(&owner_path, owner.as_bytes()) {
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
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(None),
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

        let owner_path = self.path.join(OWNER_FILE);
        let observed = fs::read(&owner_path)
            .map_err(|error| LocalFileLockError::io(&self.path, "read local lock owner token", error))?;
        if observed != self.owner.as_bytes() {
            return Err(LocalFileLockError::new(
                LocalFileLockErrorKind::Compromised,
                &self.path,
                "owner token changed; refusing to remove a lock that may belong to another acquisition",
            ));
        }

        fs::remove_file(&owner_path)
            .map_err(|error| LocalFileLockError::io(&self.path, "remove local lock owner token", error))?;
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
    match fs::metadata(path) {
        Ok(metadata) => Ok(metadata.is_dir()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(LocalFileLockError::io(path, "inspect local lock path", error)),
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
        assert!(LocalFileLock::try_acquire(&path, "owner-b")
            .expect("contended attempt")
            .is_none());
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
}
