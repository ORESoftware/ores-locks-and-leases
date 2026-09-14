//! Structured scoped execution for the portable local filesystem backend.

use crate::local_file::{LocalFileLock, LocalFileLockError, LocalFileLockOptions};
use std::path::Path;

/// Cross-runtime structured outcomes for [`with_local_file_lock`].
#[derive(Debug)]
pub enum ScopedLocalFileLockError<E> {
    /// Acquisition failed, or work succeeded and release failed.
    Lock(LocalFileLockError),
    /// Work failed and release succeeded.
    Work(E),
    /// Work failed and release also failed; neither failure is discarded.
    WorkAndRelease {
        work: E,
        release: LocalFileLockError,
    },
}

/// Acquire, run one structured callback, and release exactly once.
///
/// This helper normalizes callback `Result` values only. A Rust panic is not
/// converted into a structured work error; normal unwinding drops the held
/// lock and the original panic retains precedence.
pub fn with_local_file_lock<T, E, F>(
    path: impl AsRef<Path>,
    owner: impl Into<String>,
    options: LocalFileLockOptions,
    work: F,
) -> Result<T, ScopedLocalFileLockError<E>>
where
    F: FnOnce(&LocalFileLock) -> Result<T, E>,
{
    let mut lock =
        LocalFileLock::acquire(path, owner, options).map_err(ScopedLocalFileLockError::Lock)?;

    let work_result = work(&lock);
    let release_result = lock.release();

    match (work_result, release_result) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(work), Ok(())) => Err(ScopedLocalFileLockError::Work(work)),
        (Ok(_), Err(release)) => Err(ScopedLocalFileLockError::Lock(release)),
        (Err(work), Err(release)) => {
            Err(ScopedLocalFileLockError::WorkAndRelease { work, release })
        }
    }
}
