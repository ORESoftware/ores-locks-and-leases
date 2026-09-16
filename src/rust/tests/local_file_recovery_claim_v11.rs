use ores_locks_and_leases::{
    LocalFileLock, LocalFileLockInspectionState, inspect_local_file_lock, recover_local_file_lock,
};
use std::fs;
use std::sync::Arc;
use std::thread;

fn test_path(name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "ores-local-v11-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ))
}

#[test]
fn local_file_recovery_claim_is_incomplete() {
    let path = test_path("recovering-state");
    fs::create_dir(&path).expect("create rendezvous");
    fs::write(path.join("owner.recovering"), b"owner-a").expect("seed recovery claim");

    let inspection = inspect_local_file_lock(&path).expect("inspect recovery claim");
    assert_eq!(inspection.state, LocalFileLockInspectionState::Incomplete);
    assert_eq!(inspection.owner, None);

    fs::remove_file(path.join("owner.recovering")).expect("cleanup claim");
    fs::remove_dir(path).expect("cleanup rendezvous");
}

#[test]
fn local_file_lock_concurrent_exact_owner_recovery_has_one_winner() {
    let path = test_path("parallel-recovery");
    let owner = "parallel-rust-owner";
    let lock = LocalFileLock::try_acquire(&path, owner)
        .expect("acquire")
        .expect("holder");
    std::mem::forget(lock);

    let path = Arc::new(path);
    let mut workers = Vec::new();
    for _ in 0..32 {
        let path = Arc::clone(&path);
        workers.push(thread::spawn(move || {
            recover_local_file_lock(path.as_path(), owner, true)
        }));
    }

    let outcomes: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().expect("recovery worker"))
        .collect();
    let winners = outcomes
        .iter()
        .filter(|outcome| matches!(outcome, Ok(true)))
        .count();
    assert_eq!(winners, 1, "outcomes={outcomes:?}");

    let inspection = inspect_local_file_lock(path.as_path()).expect("inspect final state");
    assert_eq!(inspection.state, LocalFileLockInspectionState::Absent);
    assert!(!recover_local_file_lock(path.as_path(), owner, true).expect("idempotent absent"));
}
