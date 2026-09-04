//! Live-database checks for the `pg` feature. They run only when
//! `ORES_LOCKS_TEST_DATABASE_URL` points at a Postgres the test may use; CI
//! provides one, local runs skip with a note.

#![cfg(feature = "pg")]

use std::sync::Arc;
use std::time::Duration;

use ores_locks_and_leases::pg::DedicatedConnection;
use ores_locks_and_leases::{
    AcquireOptions, LockErrorKind, LockKey, LockLayers, NoLease, with_session_lock, with_xact_lock,
};
use sea_orm::{ConnectOptions, Database};

fn database_url() -> Option<String> {
    std::env::var("ORES_LOCKS_TEST_DATABASE_URL").ok()
}

#[tokio::test]
async fn xact_lock_serializes_two_writers() {
    let Some(url) = database_url() else {
        eprintln!("skipping: ORES_LOCKS_TEST_DATABASE_URL is not set");
        return;
    };
    let db = Arc::new(Database::connect(ConnectOptions::new(url)).await.unwrap());
    let key = LockKey::new("ores-locks/test/xact-serialize").unwrap();

    let first = {
        let db = db.clone();
        let key = key.clone();
        tokio::spawn(async move {
            with_xact_lock(
                &key,
                LockLayers::PG_ONLY,
                true,
                &AcquireOptions::default(),
                None::<&NoLease>,
                Some(&*db),
                |g| {
                    Box::pin(async move {
                        assert!(g.txn.is_some());
                        tokio::time::sleep(Duration::from_millis(400)).await;
                        Ok::<_, String>("first")
                    })
                },
            )
            .await
        })
    };
    tokio::time::sleep(Duration::from_millis(100)).await;

    // While the first holder sleeps inside its transaction, a try-lock must
    // report contention rather than wait.
    let contended = with_xact_lock(
        &key,
        LockLayers::PG_ONLY,
        false,
        &AcquireOptions::default(),
        None::<&NoLease>,
        Some(&*db),
        |_| Box::pin(async { Ok::<_, String>("never") }),
    )
    .await;
    assert_eq!(contended.unwrap_err().kind, LockErrorKind::Contention);

    assert_eq!(first.await.unwrap().unwrap(), "first");

    // Once released, the same try-lock succeeds.
    let free = with_xact_lock(
        &key,
        LockLayers::PG_ONLY,
        false,
        &AcquireOptions::default(),
        None::<&NoLease>,
        Some(&*db),
        |_| Box::pin(async { Ok::<_, String>("free") }),
    )
    .await;
    assert_eq!(free.unwrap(), "free");
}

#[tokio::test]
async fn session_lock_round_trips_on_a_dedicated_connection() {
    let Some(url) = database_url() else {
        eprintln!("skipping: ORES_LOCKS_TEST_DATABASE_URL is not set");
        return;
    };
    let conn = DedicatedConnection::connect(ConnectOptions::new(url))
        .await
        .unwrap();
    let key = LockKey::new("ores-locks/test/session").unwrap();
    let value = with_session_lock(
        &key,
        LockLayers::PG_ONLY,
        false,
        &AcquireOptions::default(),
        None::<&NoLease>,
        Some(&conn),
        |g| {
            Box::pin(async move {
                assert!(g.txn.is_none(), "session scope opens no transaction");
                Ok::<_, String>(42)
            })
        },
    )
    .await
    .unwrap();
    assert_eq!(value, 42);
}
