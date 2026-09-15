use ores_locks_and_leases::{
    inspect_local_file_lock, local_file_lock_exists, recover_local_file_lock, LocalFileLock,
    LocalFileLockErrorKind,
};
use std::path::{Path, PathBuf};

fn assert_invalid<T>(result: Result<T, ores_locks_and_leases::LocalFileLockError>) {
    let error = result.expect_err("portable-invalid path must be rejected");
    assert_eq!(error.kind, LocalFileLockErrorKind::InvalidInput);
}

fn assert_all_path_entry_points_reject(path: &Path) {
    assert_invalid(LocalFileLock::try_acquire(path, "owner-a"));
    assert_invalid(local_file_lock_exists(path));
    assert_invalid(inspect_local_file_lock(path));
    assert_invalid(recover_local_file_lock(path, "owner-a", true));
}

#[test]
fn local_file_empty_path_is_invalid_across_entry_points() {
    assert_all_path_entry_points_reject(Path::new(""));
}

#[test]
fn local_file_embedded_nul_path_is_invalid_across_entry_points() {
    let path = PathBuf::from("bad\0path.lock");
    assert_all_path_entry_points_reject(&path);
}

#[cfg(unix)]
#[test]
fn local_file_non_unicode_path_is_invalid_across_entry_points() {
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;

    let path = PathBuf::from(OsString::from_vec(vec![
        b'o', b'r', b'e', b's', b'-', 0xff, b'.', b'l', b'o', b'c', b'k',
    ]));
    assert_all_path_entry_points_reject(&path);
}
