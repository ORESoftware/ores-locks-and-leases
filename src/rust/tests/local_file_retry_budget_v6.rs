use ores_locks_and_leases::{LocalFileLock, LocalFileLockErrorKind, LocalFileLockOptions};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn test_path() -> std::path::PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "ores-retry-budget-{}-{nonce}-{}",
        std::process::id(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    ))
}

#[test]
fn local_file_retry_sleep_never_outlives_remaining_budget() {
    let path = test_path();
    let mut holder = LocalFileLock::try_acquire(&path, "owner-a")
        .expect("holder acquire")
        .expect("holder");

    let started = Instant::now();
    let error = LocalFileLock::acquire(
        &path,
        "owner-b",
        LocalFileLockOptions {
            wait: true,
            wait_timeout: Duration::from_millis(40),
            retry_interval: Duration::from_secs(5),
        },
    )
    .expect_err("contender must time out");
    let elapsed = started.elapsed();

    assert_eq!(error.kind, LocalFileLockErrorKind::Timeout);
    assert!(
        elapsed < Duration::from_secs(1),
        "retry interval leaked past the finite budget: {elapsed:?}"
    );
    holder.release().expect("holder release");
}
