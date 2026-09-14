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
        .expect("system clock before epoch")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "ores-recovery-{name}-{}-{nonce}-{}",
        std::process::id(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    ))
}

#[test]
fn inspect_absent_and_clean_held_states() {
    let path = test_path("inspect");
    let absent = inspect_local_file_lock(&path).expect("inspect absent");
    assert_eq!(absent.state, LocalFileLockInspectionState::Absent);

    let lock = LocalFileLock::try_acquire(&path, "owner-a")
        .expect("acquire")
        .expect("holder");
    let held = inspect_local_file_lock(&path).expect("inspect held");
    assert_eq!(held.state, LocalFileLockInspectionState::Held);
    assert_eq!(held.owner.as_deref(), Some("owner-a"));
    std::mem::forget(lock);
    fs::remove_file(path.join("owner")).expect("cleanup owner");
    fs::remove_dir(path).expect("cleanup lock");
}

#[test]
fn inspect_missing_owner_and_dirty_directory_are_compromised() {
    let path = test_path("compromised");
    let lock = LocalFileLock::try_acquire(&path, "owner-a")
        .expect("acquire")
        .expect("holder");
    fs::remove_file(path.join("owner")).expect("remove owner");
    let missing = inspect_local_file_lock(&path).expect("inspect missing owner");
    assert_eq!(missing.state, LocalFileLockInspectionState::Compromised);
    fs::write(path.join("unexpected"), b"x").expect("write unexpected");
    let dirty = inspect_local_file_lock(&path).expect("inspect dirty");
    assert_eq!(dirty.state, LocalFileLockInspectionState::Compromised);
    std::mem::forget(lock);
    fs::remove_file(path.join("unexpected")).expect("cleanup unexpected");
    fs::remove_dir(path).expect("cleanup lock");
}

#[test]
fn recovery_requires_confirmation_and_expected_owner() {
    let path = test_path("gates");
    let lock = LocalFileLock::try_acquire(&path, "owner-a")
        .expect("acquire")
        .expect("holder");
    std::mem::forget(lock);

    let unconfirmed = recover_local_file_lock(&path, "owner-a", false)
        .expect_err("unconfirmed recovery must fail");
    assert_eq!(unconfirmed.kind, LocalFileLockErrorKind::InvalidInput);

    let mismatch = recover_local_file_lock(&path, "owner-b", true)
        .expect_err("owner mismatch must fail");
    assert_eq!(mismatch.kind, LocalFileLockErrorKind::Compromised);

    assert!(recover_local_file_lock(&path, "owner-a", true).expect("recover clean lock"));
    assert!(!path.exists());
}

#[test]
fn recovery_absent_is_idempotent_noop_and_dirty_fails_closed() {
    let absent = test_path("absent");
    assert!(!recover_local_file_lock(&absent, "owner-a", true).expect("absent recovery"));

    let path = test_path("dirty");
    let lock = LocalFileLock::try_acquire(&path, "owner-a")
        .expect("acquire")
        .expect("holder");
    fs::write(path.join("unexpected"), b"do not delete").expect("write unexpected");
    std::mem::forget(lock);

    let error = recover_local_file_lock(&path, "owner-a", true)
        .expect_err("dirty recovery must fail closed");
    assert_eq!(error.kind, LocalFileLockErrorKind::Compromised);
    assert!(path.join("unexpected").exists());
    fs::remove_file(path.join("unexpected")).expect("cleanup unexpected");
    fs::remove_file(path.join("owner")).expect("cleanup owner");
    fs::remove_dir(path).expect("cleanup lock");
}
