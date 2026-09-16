use ores_locks_and_leases::{
    LocalFileLock, LocalFileLockErrorKind, LocalFileLockInspectionReason,
    LocalFileLockInspectionState, LocalFileLockOptions, inspect_local_file_lock,
};
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
    let second = lock
        .release()
        .expect_err("later release must retain failure");
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
    assert!(
        elapsed >= Duration::from_millis(20),
        "returned too early: {elapsed:?}"
    );
    assert!(
        elapsed < Duration::from_secs(2),
        "budget ran unbounded: {elapsed:?}"
    );
}

#[test]
fn pending_owner_publication_is_incomplete_not_held() {
    let path = test_path("pending");
    fs::create_dir(&path).expect("create rendezvous");
    fs::write(
        path.join("owner.pending"),
        b"syntactically-valid-owner-prefix",
    )
    .expect("seed pending owner");

    let inspection = inspect_local_file_lock(&path).expect("inspect pending publication");
    assert_eq!(inspection.state, LocalFileLockInspectionState::Incomplete);
    assert_eq!(
        inspection.reason,
        Some(LocalFileLockInspectionReason::OwnerMarkerMissing)
    );
    assert_eq!(
        LocalFileLockInspectionReason::OwnerMarkerMissing.as_str(),
        "owner_marker_missing"
    );

    fs::remove_file(path.join("owner.pending")).expect("cleanup pending owner");
    fs::remove_dir(path).expect("cleanup rendezvous");
}
