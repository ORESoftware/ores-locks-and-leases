#![cfg(unix)]

use ores_locks_and_leases::{
    LocalFileLock, LocalFileLockErrorKind, LocalFileLockInspectionState, inspect_local_file_lock,
    recover_local_file_lock,
};
use std::fs;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn test_path(name: &str) -> std::path::PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "ores-hardlink-{name}-{}-{nonce}-{}",
        std::process::id(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    ))
}

#[test]
fn release_fails_closed_while_owner_marker_is_hardlinked() {
    let path = test_path("release");
    let alias = test_path("release-owner-alias");
    let mut lock = LocalFileLock::try_acquire(&path, "owner-a")
        .expect("acquire")
        .expect("holder");

    fs::hard_link(path.join("owner"), &alias).expect("create owner hard link");
    let release = lock
        .release()
        .expect_err("multiply linked owner must block destructive release");
    assert_eq!(release.kind, LocalFileLockErrorKind::Compromised);
    assert!(path.exists(), "failed release must preserve rendezvous");
    assert!(
        path.join("owner").exists(),
        "failed release must preserve owner marker"
    );
    assert!(
        alias.exists(),
        "failed release must preserve external alias"
    );

    fs::remove_file(&alias).expect("remove external alias");
    lock.release().expect("release after alias repair");
    assert!(!path.exists());
}

#[test]
fn inspection_and_recovery_fail_closed_while_owner_marker_is_hardlinked() {
    let path = test_path("recovery");
    let alias = test_path("owner-alias");
    let lock = LocalFileLock::try_acquire(&path, "owner-a")
        .expect("acquire")
        .expect("holder");
    std::mem::forget(lock);

    fs::hard_link(path.join("owner"), &alias).expect("create owner hard link");

    let inspection = inspect_local_file_lock(&path).expect("inspect multiply linked owner");
    assert_eq!(inspection.state, LocalFileLockInspectionState::Compromised);
    assert!(inspection.owner.is_none());
    assert!(
        inspection
            .message
            .as_deref()
            .is_some_and(|message| message.contains("multiple") || message.contains("linked"))
    );

    let recovery = recover_local_file_lock(&path, "owner-a", true)
        .expect_err("multiply linked owner must block recovery");
    assert_eq!(recovery.kind, LocalFileLockErrorKind::Compromised);
    assert!(path.exists(), "failed recovery must preserve rendezvous");
    assert!(alias.exists(), "failed recovery must preserve alias");

    fs::remove_file(&alias).expect("remove external alias");
    let repaired = inspect_local_file_lock(&path).expect("inspect repaired owner");
    assert_eq!(repaired.state, LocalFileLockInspectionState::Held);
    assert_eq!(repaired.owner.as_deref(), Some("owner-a"));
    assert!(recover_local_file_lock(&path, "owner-a", true).expect("recover repaired owner"));
    assert!(!path.exists());
}
