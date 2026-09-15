use ores_locks_and_leases::LocalFileLock;
use std::fs;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn root() -> std::path::PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "ores-parent-lifecycle-{}-{nonce}-{}",
        std::process::id(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    ))
}

#[test]
fn release_keeps_auto_created_parent_and_removes_only_rendezvous() {
    let root = root();
    let parent = root.join("auto-created-parent");
    let path = parent.join("install.lock");
    assert!(!parent.exists());

    let mut lock = LocalFileLock::try_acquire(&path, "owner-a")
        .expect("acquire")
        .expect("holder");
    assert!(parent.is_dir());
    lock.release().expect("release");

    assert!(parent.is_dir(), "release must preserve auto-created parent");
    assert_eq!(fs::read_dir(&parent).expect("read parent").count(), 0);
    fs::remove_dir_all(root).expect("cleanup");
}
