use ores_locks_and_leases::{
    LocalFileLock, LocalFileLockErrorKind, LocalFileLockOptions, ScopedLocalFileLockError,
    with_local_file_lock,
};
use std::fs;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn test_path(name: &str) -> std::path::PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before epoch")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "ores-scoped-{name}-{}-{nonce}-{}",
        std::process::id(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    ))
}

#[test]
fn acquire_failure_does_not_run_work() {
    let path = test_path("acquire-failure");
    let mut first = LocalFileLock::try_acquire(&path, "owner-a")
        .expect("seed acquire")
        .expect("seed holder");
    let calls = AtomicUsize::new(0);

    let error = with_local_file_lock(
        &path,
        "owner-b",
        LocalFileLockOptions {
            wait: false,
            ..LocalFileLockOptions::default()
        },
        |_| -> Result<(), &'static str> {
            calls.fetch_add(1, Ordering::Relaxed);
            Ok(())
        },
    )
    .expect_err("contended acquire must fail");

    assert_eq!(calls.load(Ordering::Relaxed), 0);
    match error {
        ScopedLocalFileLockError::Lock(error) => {
            assert_eq!(error.kind, LocalFileLockErrorKind::Contention)
        }
        _ => panic!("unexpected scoped error"),
    }
    first.release().expect("cleanup seed holder");
}

#[test]
fn work_failure_survives_successful_release() {
    let path = test_path("work-error");
    let error = with_local_file_lock(
        &path,
        "owner-a",
        LocalFileLockOptions::default(),
        |_| Err::<(), _>("work-failed"),
    )
    .expect_err("work must fail");

    match error {
        ScopedLocalFileLockError::Work(work) => assert_eq!(work, "work-failed"),
        _ => panic!("unexpected scoped error"),
    }
    assert!(!path.exists(), "successful release must remove lock directory");
}

#[test]
fn release_failure_after_successful_work_is_lock_error() {
    let path = test_path("release-error");
    let error = with_local_file_lock(
        &path,
        "owner-a",
        LocalFileLockOptions::default(),
        |lock| {
            fs::write(lock.path().join("owner"), b"owner-b").expect("mutate owner marker");
            Ok::<_, &'static str>(())
        },
    )
    .expect_err("release must fail closed");

    match error {
        ScopedLocalFileLockError::Lock(error) => {
            assert_eq!(error.kind, LocalFileLockErrorKind::Compromised)
        }
        _ => panic!("unexpected scoped error"),
    }
    fs::remove_file(path.join("owner")).expect("cleanup owner marker");
    fs::remove_dir(path).expect("cleanup lock directory");
}

#[test]
fn work_and_release_failures_are_both_preserved() {
    let path = test_path("both-errors");
    let error = with_local_file_lock(
        &path,
        "owner-a",
        LocalFileLockOptions::default(),
        |lock| {
            fs::write(lock.path().join("owner"), b"owner-b").expect("mutate owner marker");
            Err::<(), _>("work-failed")
        },
    )
    .expect_err("both failures must be reported");

    match error {
        ScopedLocalFileLockError::WorkAndRelease { work, release } => {
            assert_eq!(work, "work-failed");
            assert_eq!(release.kind, LocalFileLockErrorKind::Compromised);
        }
        _ => panic!("unexpected scoped error"),
    }
    fs::remove_file(path.join("owner")).expect("cleanup owner marker");
    fs::remove_dir(path).expect("cleanup lock directory");
}
