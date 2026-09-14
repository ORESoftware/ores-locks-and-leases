use ores_locks_and_leases::{
    LocalFileLock, LocalFileLockErrorKind, LocalFileLockOptions, with_local_file_lock,
};
use std::fs;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn test_path(name: &str) -> std::path::PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before epoch")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "ores-semantic-v5-{name}-{}-{nonce}-{}",
        std::process::id(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    ))
}

#[test]
fn same_owner_reacquisition_is_contention_not_reentrancy() {
    let path = test_path("same-owner");
    let mut first = LocalFileLock::try_acquire(&path, "owner-a")
        .expect("first acquire")
        .expect("first holder");
    let second = LocalFileLock::try_acquire(&path, "owner-a").expect("same-owner attempt");
    assert!(second.is_none(), "same owner must not imply recursive ownership");
    first.release().expect("release first holder");
}

#[test]
fn owner_identity_is_exact_unicode_not_normalized() {
    let path = test_path("unicode-owner");
    let mut lock = LocalFileLock::try_acquire(&path, "owner-é")
        .expect("acquire")
        .expect("holder");
    fs::write(path.join("owner"), "owner-e\u{301}").expect("replace owner marker");
    let error = lock.release().expect_err("normalization-equivalent owner must not authenticate");
    assert_eq!(error.kind, LocalFileLockErrorKind::Compromised);
    let _ = fs::remove_file(path.join("owner"));
    let _ = fs::remove_dir(&path);
}

#[test]
fn scoped_panic_keeps_panic_precedence_and_best_effort_releases() {
    let path = test_path("panic-release");
    let result = catch_unwind(AssertUnwindSafe(|| {
        let _ = with_local_file_lock(
            &path,
            "owner-a",
            LocalFileLockOptions::default(),
            |_| -> Result<(), &'static str> { panic!("work-boom") },
        );
    }));
    assert!(result.is_err(), "panic must propagate rather than become a structured work error");
    assert!(
        !path.exists(),
        "Rust unwinding must drop the held lock and make a best-effort release"
    );
}
