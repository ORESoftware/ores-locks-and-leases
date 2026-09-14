//// Structured scoped execution for the portable local filesystem backend.

import ores_locks_and_leases/local_file

/// Cross-runtime structured outcome preserving both work and release failures.
pub type ScopedLocalFileLockError(work_error) {
  Lock(local_file.LocalFileLockError)
  Work(work_error)
  WorkAndRelease(work_error, local_file.LocalFileLockError)
}

/// Acquire, execute one structured callback, then release exactly once.
///
/// This normalizes callback Result values only. A BEAM process crash is not
/// converted into a structured work error.
pub fn with_local_file_lock(
  lock_root: String,
  lock_name: String,
  owner: String,
  options: local_file.LocalFileLockOptions,
  work: fn(local_file.LocalFileLock) -> Result(value, work_error),
) -> Result(value, ScopedLocalFileLockError(work_error)) {
  case local_file.acquire(lock_root, lock_name, owner, options) {
    Error(error) -> Error(Lock(error))
    Ok(lock) -> {
      let work_result = work(lock)
      let release_result = local_file.release(lock)
      case work_result, release_result {
        Ok(value), Ok(Nil) -> Ok(value)
        Error(work_error), Ok(Nil) -> Error(Work(work_error))
        Ok(_), Error(lock_error) -> Error(Lock(lock_error))
        Error(work_error), Error(lock_error) ->
          Error(WorkAndRelease(work_error, lock_error))
      }
    }
  }
}
