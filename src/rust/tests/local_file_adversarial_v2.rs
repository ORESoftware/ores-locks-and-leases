use ores_locks_and_leases::{
    LocalFileLock, LocalFileLockInspectionState, LocalFileLockOptions, inspect_local_file_lock,
};
use std::fs;
use std::path::PathBuf;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn test_path(name: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before epoch")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "ores-locks-local-v2-{name}-{}-{nonce}",
        std::process::id()
    ))
}

#[test]
fn waiter_acquires_after_release_within_remaining_budget() {
    let path = test_path("handoff");
    let mut first = LocalFileLock::try_acquire(&path, "owner-a")
        .expect("first acquire")
        .expect("first holder");
    let release_thread = thread::spawn(move || {
        thread::sleep(Duration::from_millis(25));
        first.release().expect("first release");
    });

    let mut second = LocalFileLock::acquire(
        &path,
        "owner-b",
        LocalFileLockOptions {
            wait: true,
            wait_timeout: Duration::from_millis(500),
            retry_interval: Duration::from_millis(5),
        },
    )
    .expect("waiter acquire");
    assert_eq!(second.owner(), "owner-b");
    second.release().expect("second release");
    release_thread.join().expect("release thread");
}

#[test]
fn inspection_bounds_persisted_owner_read() {
    let path = test_path("oversize-owner");
    fs::create_dir(&path).expect("create lock dir");
    fs::write(path.join("owner"), vec![b'a'; 2049]).expect("write oversized owner");

    let inspection = inspect_local_file_lock(&path).expect("inspect");
    assert_eq!(inspection.state, LocalFileLockInspectionState::Compromised);
    assert!(
        inspection
            .message
            .as_deref()
            .unwrap_or_default()
            .contains("2048-byte")
    );
    fs::remove_dir_all(&path).expect("cleanup");
}

#[test]
fn inspection_classifies_invalid_utf8_as_compromised() {
    let path = test_path("invalid-utf8");
    fs::create_dir(&path).expect("create lock dir");
    fs::write(path.join("owner"), [0xff]).expect("write invalid utf8");

    let inspection = inspect_local_file_lock(&path).expect("inspect");
    assert_eq!(inspection.state, LocalFileLockInspectionState::Compromised);
    assert!(
        inspection
            .message
            .as_deref()
            .unwrap_or_default()
            .contains("valid UTF-8")
    );
    fs::remove_dir_all(&path).expect("cleanup");
}
