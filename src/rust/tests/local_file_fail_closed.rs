use ores_locks_and_leases::{LocalFileLock, LocalFileLockErrorKind};
use std::fs;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn test_path() -> std::path::PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before epoch")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "ores-locks-dirty-{}-{nonce}-{}",
        std::process::id(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    ))
}

#[test]
fn local_file_unexpected_entry_fails_closed() {
    let path = test_path();
    let mut lock = LocalFileLock::try_acquire(&path, "owner-a")
        .expect("acquire")
        .expect("holder");
    let unexpected = path.join("unexpected");
    fs::write(&unexpected, b"do not delete").expect("write unexpected entry");

    let error = lock.release().expect_err("dirty lock must fail closed");
    assert_eq!(error.kind, LocalFileLockErrorKind::Compromised);
    assert!(unexpected.exists(), "unexpected entry must not be deleted");

    fs::remove_file(unexpected).expect("cleanup unexpected entry");
    fs::remove_dir(path).expect("cleanup lock directory");
    std::mem::forget(lock);
}
