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
fn inspect_empty_directory_is_explicit_incomplete_crash_state() {
    let path = test_path("incomplete");
    fs::create_dir(&path).expect("seed mkdir-before-owner crash window");
    let inspection = inspect_local_file_lock(&path).expect("inspect incomplete");
    assert_eq!(inspection.state, LocalFileLockInspectionState::Incomplete);
    assert!(inspection.owner.is_none());

    let recovery = recover_local_file_lock(&path, "owner-a", true)
        .expect_err("ownerless crash state must never stale-steal");
    assert_eq!(recovery.kind, LocalFileLockErrorKind::Compromised);
    assert!(path.exists());
    fs::remove_dir(path).expect("cleanup incomplete lock");
}

#[test]
fn owner_removed_before_rmdir_is_the_same_incomplete_crash_state() {
    let path = test_path("release-crash");
    let lock = LocalFileLock::try_acquire(&path, "owner-a")
        .expect("acquire")
        .expect("holder");
    std::mem::forget(lock);
    fs::remove_file(path.join("owner")).expect("simulate release crash after owner deletion");

    let inspection = inspect_local_file_lock(&path).expect("inspect release crash");
    assert_eq!(inspection.state, LocalFileLockInspectionState::Incomplete);
    let recovery = recover_local_file_lock(&path, "owner-a", true)
        .expect_err("ownerless release crash must not be auto-recovered");
    assert_eq!(recovery.kind, LocalFileLockErrorKind::Compromised);
    assert!(path.exists());
    fs::remove_dir(path).expect("cleanup release crash");
}

#[test]
fn inspect_dirty_directory_is_compromised() {
    let path = test_path("compromised");
    let lock = LocalFileLock::try_acquire(&path, "owner-a")
        .expect("acquire")
        .expect("holder");
    fs::remove_file(path.join("owner")).expect("remove owner");
    fs::write(path.join("unexpected"), b"x").expect("write unexpected");
    let dirty = inspect_local_file_lock(&path).expect("inspect dirty");
    assert_eq!(dirty.state, LocalFileLockInspectionState::Compromised);
    std::mem::forget(lock);
    fs::remove_file(path.join("unexpected")).expect("cleanup unexpected");
    fs::remove_dir(path).expect("cleanup lock");
}

#[test]
fn inspect_oversized_persisted_owner_is_compromised() {
    let path = test_path("oversized-persisted-owner");
    let lock = LocalFileLock::try_acquire(&path, "owner-a")
        .expect("acquire")
        .expect("holder");
    fs::write(path.join("owner"), "😀".repeat(513)).expect("replace owner");
    let inspection = inspect_local_file_lock(&path).expect("inspect oversized owner");
    assert_eq!(inspection.state, LocalFileLockInspectionState::Compromised);
    std::mem::forget(lock);
    fs::remove_file(path.join("owner")).expect("cleanup owner");
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

    let mismatch =
        recover_local_file_lock(&path, "owner-b", true).expect_err("owner mismatch must fail");
    assert_eq!(mismatch.kind, LocalFileLockErrorKind::Compromised);

    assert!(recover_local_file_lock(&path, "owner-a", true).expect("recover clean lock"));
    assert!(!path.exists());
}

#[test]
fn recovery_rejects_oversized_expected_owner() {
    let path = test_path("oversized-expected-owner");
    let error = recover_local_file_lock(&path, &"😀".repeat(513), true)
        .expect_err("oversized expected owner must fail admission");
    assert_eq!(error.kind, LocalFileLockErrorKind::InvalidInput);
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
