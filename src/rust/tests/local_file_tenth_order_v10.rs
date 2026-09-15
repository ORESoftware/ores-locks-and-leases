use ores_locks_and_leases::{LocalFileLock, LocalFileLockErrorKind, LocalFileLockOptions};
use std::fs;
use std::time::{Duration, Instant};

fn test_path(name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "ores-local-v10-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ))
}

#[test]
fn destructive_partial_release_retains_original_error() {
    let path = test_path("partial");
    let mut lock = LocalFileLock::try_acquire(&path, "owner-a")
        .expect("acquire")
        .expect("holder");
    fs::write(path.join("unexpected"), b"dirty").expect("seed dirty entry");

    let first = lock.release().expect_err("partial release must fail");
    let second = lock.release().expect_err("later release must retain failure");
    assert_eq!(first, second);

    fs::remove_file(path.join("unexpected")).expect("cleanup dirty entry");
    fs::remove_dir(&path).expect("cleanup partial directory");
}

#[test]
fn finite_wait_budget_is_end_to_end() {
    let path = test_path("timeout");
    let _holder = LocalFileLock::try_acquire(&path, "holder")
        .expect("acquire holder")
        .expect("holder");

    let started = Instant::now();
    let error = LocalFileLock::acquire(
        &path,
        "waiter",
        LocalFileLockOptions {
            wait: true,
            wait_timeout: Duration::from_millis(30),
            retry_interval: Duration::from_millis(5),
        },
    )
    .expect_err("waiter must time out");
    let elapsed = started.elapsed();
    assert_eq!(error.kind, LocalFileLockErrorKind::Timeout);
    assert!(elapsed >= Duration::from_millis(20), "returned too early: {elapsed:?}");
    assert!(elapsed < Duration::from_secs(2), "budget ran unbounded: {elapsed:?}");
}
