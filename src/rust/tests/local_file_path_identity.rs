use ores_locks_and_leases::{LocalFileLock, LocalFileLockErrorKind};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn test_root(name: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before epoch")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "ores-path-identity-{name}-{}-{nonce}-{}",
        std::process::id(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    ))
}

#[cfg(unix)]
fn symlink_dir(target: &Path, link: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(unix)]
fn symlink_file(target: &Path, link: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn symlink_dir(target: &Path, link: &Path) -> io::Result<()> {
    std::os::windows::fs::symlink_dir(target, link)
}

#[cfg(windows)]
fn symlink_file(target: &Path, link: &Path) -> io::Result<()> {
    std::os::windows::fs::symlink_file(target, link)
}

fn skip_if_symlink_unavailable(result: io::Result<()>) -> bool {
    match result {
        Ok(()) => false,
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::PermissionDenied | io::ErrorKind::Unsupported
            ) =>
        {
            eprintln!("symlink unavailable on this runner: {error}");
            true
        }
        Err(error) => panic!("create symlink: {error}"),
    }
}

#[test]
fn rendezvous_symlink_is_compromised() {
    let root = test_root("rendezvous-symlink");
    fs::create_dir_all(&root).expect("create root");
    let target = root.join("target");
    let link = root.join("install.lock");
    fs::create_dir(&target).expect("create target");
    if skip_if_symlink_unavailable(symlink_dir(&target, &link)) {
        fs::remove_dir_all(root).expect("cleanup root");
        return;
    }

    let error = LocalFileLock::try_acquire(&link, "owner-a")
        .expect_err("rendezvous symlink must fail closed");
    assert_eq!(error.kind, LocalFileLockErrorKind::Compromised);
    fs::remove_file(&link)
        .or_else(|_| fs::remove_dir(&link))
        .expect("remove symlink");
    fs::remove_dir_all(root).expect("cleanup root");
}

#[test]
fn immediate_parent_symlink_is_compromised() {
    let root = test_root("parent-symlink");
    fs::create_dir_all(&root).expect("create root");
    let target_parent = root.join("real-parent");
    let alias_parent = root.join("alias-parent");
    fs::create_dir(&target_parent).expect("create target parent");
    if skip_if_symlink_unavailable(symlink_dir(&target_parent, &alias_parent)) {
        fs::remove_dir_all(root).expect("cleanup root");
        return;
    }

    let path = alias_parent.join("install.lock");
    let error = LocalFileLock::try_acquire(&path, "owner-a")
        .expect_err("aliased immediate parent must fail closed");
    assert_eq!(error.kind, LocalFileLockErrorKind::Compromised);
    fs::remove_file(&alias_parent)
        .or_else(|_| fs::remove_dir(&alias_parent))
        .expect("remove parent symlink");
    fs::remove_dir_all(root).expect("cleanup root");
}

#[test]
fn owner_symlink_is_compromised_on_release() {
    let root = test_root("owner-symlink");
    let path = root.join("install.lock");
    let target_owner = root.join("external-owner");
    fs::create_dir_all(&root).expect("create root");
    let mut lock = LocalFileLock::try_acquire(&path, "owner-a")
        .expect("acquire")
        .expect("holder");
    fs::remove_file(path.join("owner")).expect("remove real owner");
    fs::write(&target_owner, b"owner-a").expect("write external owner");
    if skip_if_symlink_unavailable(symlink_file(&target_owner, &path.join("owner"))) {
        fs::write(path.join("owner"), b"owner-a").expect("restore owner");
        lock.release().expect("release restored lock");
        fs::remove_file(target_owner).expect("cleanup external owner");
        fs::remove_dir_all(root).expect("cleanup root");
        return;
    }

    let error = lock.release().expect_err("owner symlink must fail closed");
    assert_eq!(error.kind, LocalFileLockErrorKind::Compromised);
    fs::remove_file(path.join("owner")).expect("remove owner symlink");
    fs::remove_dir(&path).expect("cleanup lock");
    fs::remove_file(target_owner).expect("cleanup target owner");
    std::mem::forget(lock);
    fs::remove_dir_all(root).expect("cleanup root");
}

#[test]
fn case_insensitive_alias_contends_when_filesystem_aliases_case() {
    let root = test_root("case-alias");
    fs::create_dir_all(&root).expect("create root");
    let upper = root.join("Install.lock");
    let lower = root.join("install.lock");
    let mut first = LocalFileLock::try_acquire(&upper, "owner-a")
        .expect("acquire upper")
        .expect("holder");

    if fs::canonicalize(&lower).is_ok() {
        assert!(
            LocalFileLock::try_acquire(&lower, "owner-b")
                .expect("case alias acquire")
                .is_none(),
            "case-insensitive alias must contend on same rendezvous"
        );
    }

    first.release().expect("release upper");
    fs::remove_dir_all(root).expect("cleanup root");
}
