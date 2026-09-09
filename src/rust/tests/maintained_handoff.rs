//! Live PostgreSQL handoff evidence for the maintained Fiducia + transaction
//! advisory-lock path. The waiting holder must renew while another transaction
//! owns the advisory key, then acquire, pass final renewal, and commit only
//! after the first transaction releases the key.

#![cfg(all(feature = "pg", feature = "fiducia"))]

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use ores_locks_and_leases::{
    AcquireOptions, Lease, LeaseGrant, LeaseMaintenanceOptions, LockError, LockKey, pg,
    with_maintained_xact_lock,
};
use sea_orm::{
    ConnectOptions, ConnectionTrait, Database, DatabaseBackend, Statement, TransactionTrait,
};

#[derive(Default)]
struct CountingLease {
    renewals: AtomicUsize,
    releases: AtomicUsize,
}

impl Lease for CountingLease {
    async fn acquire(
        &self,
        key: &LockKey,
        opts: &AcquireOptions,
        _wait: bool,
    ) -> Result<LeaseGrant, LockError> {
        Ok(LeaseGrant {
            key: key.clone(),
            holder: "maintained-handoff".into(),
            fencing_token: 31337,
            lease_expires_ms: None,
            ttl_ms: opts.ttl_ms(),
        })
    }

    async fn renew(
        &self,
        grant: &LeaseGrant,
        ttl: Duration,
    ) -> Result<LeaseGrant, LockError> {
        self.renewals.fetch_add(1, Ordering::SeqCst);
        let mut renewed = grant.clone();
        renewed.ttl_ms = u64::try_from(ttl.as_millis()).unwrap_or(u64::MAX);
        Ok(renewed)
    }

    async fn release(&self, _grant: &LeaseGrant) -> Result<bool, LockError> {
        self.releases.fetch_add(1, Ordering::SeqCst);
        Ok(true)
    }
}

fn database_url() -> Option<String> {
    std::env::var("ORES_LOCKS_TEST_DATABASE_URL").ok()
}

#[tokio::test]
async fn waiting_holder_renews_then_commits_after_live_postgres_handoff() {
    let Some(url) = database_url() else {
        eprintln!("skipping: ORES_LOCKS_TEST_DATABASE_URL is not set");
        return;
    };
    let db = Database::connect(ConnectOptions::new(url)).await.unwrap();
    let table = "ores_locks_maintained_handoff";
    db.execute(Statement::from_string(
        DatabaseBackend::Postgres,
        format!("CREATE TABLE IF NOT EXISTS {table} (id text PRIMARY KEY)"),
    ))
    .await
    .unwrap();
    db.execute(Statement::from_string(
        DatabaseBackend::Postgres,
        format!("TRUNCATE TABLE {table}"),
    ))
    .await
    .unwrap();

    let key = LockKey::new("ores-locks/test/maintained-handoff").unwrap();
    let holder = db.begin().await.unwrap();
    pg::xact_lock(&holder, &key).await.unwrap();

    let lease = Arc::new(CountingLease::default());
    let acquire = AcquireOptions::default()
        .ttl(Duration::from_millis(200))
        .wait_timeout(Duration::from_secs(2))
        .retry_interval(Duration::from_millis(5));
    let maintenance =
        LeaseMaintenanceOptions::default().renew_interval(Duration::from_millis(20));

    let waiter = {
        let db = db.clone();
        let key = key.clone();
        let lease = Arc::clone(&lease);
        tokio::spawn(async move {
            with_maintained_xact_lock(
                &key,
                true,
                &acquire,
                &maintenance,
                lease.as_ref(),
                &db,
                |guarded| {
                    Box::pin(async move {
                        guarded
                            .txn
                            .expect("maintained work must receive the locked transaction")
                            .execute(Statement::from_string(
                                DatabaseBackend::Postgres,
                                format!("INSERT INTO {table} (id) VALUES ('handoff-committed')"),
                            ))
                            .await?;
                        Ok::<_, sea_orm::DbErr>(())
                    })
                },
            )
            .await
        })
    };

    tokio::time::timeout(Duration::from_secs(1), async {
        while lease.renewals.load(Ordering::SeqCst) < 2 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the waiting holder must renew while the advisory key is contended");

    holder.rollback().await.unwrap();
    waiter.await.unwrap().unwrap();

    let count = db
        .query_one(Statement::from_string(
            DatabaseBackend::Postgres,
            format!("SELECT COUNT(*)::bigint AS count FROM {table}"),
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get::<i64>("", "count")
        .unwrap();

    assert_eq!(count, 1);
    assert!(
        lease.renewals.load(Ordering::SeqCst) >= 3,
        "at least two contention renewals plus final commit admission are required"
    );
    assert_eq!(lease.releases.load(Ordering::SeqCst), 1);
}
