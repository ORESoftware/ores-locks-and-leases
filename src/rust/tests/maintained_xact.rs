//! Live PostgreSQL admission tests for the maintained Fiducia + transaction
//! advisory-lock path. CI supplies `ORES_LOCKS_TEST_DATABASE_URL`; local runs
//! without it skip rather than silently substituting a mock for commit/rollback.

#![cfg(all(feature = "pg", feature = "fiducia"))]

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use ores_locks_and_leases::{
    AcquireOptions, Lease, LeaseGrant, LeaseMaintenanceOptions, LockError, LockErrorKind, LockKey,
    LockStep, pg, with_maintained_xact_lock,
};
use sea_orm::{
    ConnectOptions, ConnectionTrait, Database, DatabaseBackend, Statement, TransactionTrait,
};

struct ScriptedLease {
    fail_renewal: Option<usize>,
    renewals: AtomicUsize,
    releases: AtomicUsize,
}

impl ScriptedLease {
    fn healthy() -> Self {
        Self {
            fail_renewal: None,
            renewals: AtomicUsize::new(0),
            releases: AtomicUsize::new(0),
        }
    }

    fn fail_on_renewal(number: usize) -> Self {
        Self {
            fail_renewal: Some(number),
            renewals: AtomicUsize::new(0),
            releases: AtomicUsize::new(0),
        }
    }
}

impl Lease for ScriptedLease {
    async fn acquire(
        &self,
        key: &LockKey,
        opts: &AcquireOptions,
        _wait: bool,
    ) -> Result<LeaseGrant, LockError> {
        Ok(LeaseGrant {
            key: key.clone(),
            holder: "maintained-test".into(),
            fencing_token: 77,
            lease_expires_ms: None,
            ttl_ms: opts.ttl_ms(),
        })
    }

    async fn renew(&self, grant: &LeaseGrant, ttl: Duration) -> Result<LeaseGrant, LockError> {
        let number = self.renewals.fetch_add(1, Ordering::SeqCst) + 1;
        if self.fail_renewal == Some(number) {
            return Err(LockError::new(
                LockErrorKind::LostLease,
                &grant.key,
                format!("scripted Fiducia lease loss on renewal {number}"),
            ));
        }
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

async fn prepare_table<C: ConnectionTrait>(db: &C, table: &str) {
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
}

async fn row_count<C: ConnectionTrait>(db: &C, table: &str) -> i64 {
    let row = db
        .query_one(Statement::from_string(
            DatabaseBackend::Postgres,
            format!("SELECT COUNT(*)::bigint AS count FROM {table}"),
        ))
        .await
        .unwrap()
        .unwrap();
    row.try_get("", "count").unwrap()
}

#[tokio::test]
async fn periodic_and_final_renewals_admit_commit() {
    let Some(url) = database_url() else {
        eprintln!("skipping: ORES_LOCKS_TEST_DATABASE_URL is not set");
        return;
    };
    let db = Database::connect(ConnectOptions::new(url)).await.unwrap();
    let table = "ores_locks_maintained_success";
    prepare_table(&db, table).await;

    let lease = ScriptedLease::healthy();
    let key = LockKey::new("ores-locks/test/maintained-success").unwrap();
    let acquire = AcquireOptions::default()
        .ttl(Duration::from_millis(120))
        .wait_timeout(Duration::from_millis(200))
        .retry_interval(Duration::from_millis(5));
    let maintenance = LeaseMaintenanceOptions::default().renew_interval(Duration::from_millis(20));

    let value =
        with_maintained_xact_lock(&key, true, &acquire, &maintenance, &lease, &db, |guarded| {
            Box::pin(async move {
                let txn = guarded.txn.expect("transaction must be present");
                txn.execute(Statement::from_string(
                    DatabaseBackend::Postgres,
                    format!("INSERT INTO {table} (id) VALUES ('committed')"),
                ))
                .await?;
                tokio::time::sleep(Duration::from_millis(75)).await;
                Ok::<_, sea_orm::DbErr>("committed")
            })
        })
        .await
        .unwrap();

    assert_eq!(value, "committed");
    assert_eq!(row_count(&db, table).await, 1);
    assert!(
        lease.renewals.load(Ordering::SeqCst) >= 2,
        "long work needs periodic renewal plus final commit admission"
    );
    assert_eq!(lease.releases.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn final_renewal_failure_rolls_back_the_protected_write() {
    let Some(url) = database_url() else {
        eprintln!("skipping: ORES_LOCKS_TEST_DATABASE_URL is not set");
        return;
    };
    let db = Database::connect(ConnectOptions::new(url)).await.unwrap();
    let table = "ores_locks_maintained_final_failure";
    prepare_table(&db, table).await;

    let lease = ScriptedLease::fail_on_renewal(1);
    let key = LockKey::new("ores-locks/test/final-renewal-failure").unwrap();
    let acquire = AcquireOptions::default().ttl(Duration::from_secs(2));
    let maintenance = LeaseMaintenanceOptions::default().renew_interval(Duration::from_millis(500));

    let error = with_maintained_xact_lock(
        &key,
        false,
        &acquire,
        &maintenance,
        &lease,
        &db,
        |guarded| {
            Box::pin(async move {
                guarded
                    .txn
                    .expect("transaction must be present")
                    .execute(Statement::from_string(
                        DatabaseBackend::Postgres,
                        format!("INSERT INTO {table} (id) VALUES ('must-rollback')"),
                    ))
                    .await?;
                Ok::<_, sea_orm::DbErr>(())
            })
        },
    )
    .await
    .unwrap_err();

    assert_eq!(error.kind, LockErrorKind::LostLease);
    assert_eq!(error.step, Some(LockStep::FiduciaRenew));
    assert_eq!(row_count(&db, table).await, 0);
    assert_eq!(lease.renewals.load(Ordering::SeqCst), 1);
    assert_eq!(lease.releases.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn periodic_lease_loss_cancels_work_and_rolls_back() {
    let Some(url) = database_url() else {
        eprintln!("skipping: ORES_LOCKS_TEST_DATABASE_URL is not set");
        return;
    };
    let db = Database::connect(ConnectOptions::new(url)).await.unwrap();
    let table = "ores_locks_maintained_periodic_failure";
    prepare_table(&db, table).await;

    let lease = ScriptedLease::fail_on_renewal(1);
    let key = LockKey::new("ores-locks/test/periodic-renewal-failure").unwrap();
    let acquire = AcquireOptions::default().ttl(Duration::from_millis(120));
    let maintenance = LeaseMaintenanceOptions::default().renew_interval(Duration::from_millis(20));

    let started = tokio::time::Instant::now();
    let error =
        with_maintained_xact_lock(&key, true, &acquire, &maintenance, &lease, &db, |guarded| {
            Box::pin(async move {
                guarded
                    .txn
                    .expect("transaction must be present")
                    .execute(Statement::from_string(
                        DatabaseBackend::Postgres,
                        format!("INSERT INTO {table} (id) VALUES ('must-rollback')"),
                    ))
                    .await?;
                tokio::time::sleep(Duration::from_secs(5)).await;
                Ok::<_, sea_orm::DbErr>(())
            })
        })
        .await
        .unwrap_err();

    assert_eq!(error.kind, LockErrorKind::LostLease);
    assert_eq!(error.step, Some(LockStep::FiduciaRenew));
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "renewal failure must preempt cooperative async work"
    );
    assert_eq!(row_count(&db, table).await, 0);
    assert_eq!(lease.releases.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn lease_loss_interrupts_live_postgres_advisory_contention() {
    let Some(url) = database_url() else {
        eprintln!("skipping: ORES_LOCKS_TEST_DATABASE_URL is not set");
        return;
    };
    let db = Database::connect(ConnectOptions::new(url)).await.unwrap();
    let key = LockKey::new("ores-locks/test/maintained-contention-loss").unwrap();

    let holder = db.begin().await.unwrap();
    pg::xact_lock(&holder, &key).await.unwrap();

    let lease = ScriptedLease::fail_on_renewal(1);
    let acquire = AcquireOptions::default()
        .ttl(Duration::from_millis(200))
        .wait_timeout(Duration::from_secs(2))
        .retry_interval(Duration::from_millis(5));
    let maintenance = LeaseMaintenanceOptions::default().renew_interval(Duration::from_millis(50));
    let work_ran = Arc::new(AtomicBool::new(false));
    let marker = Arc::clone(&work_ran);

    let started = tokio::time::Instant::now();
    let error = with_maintained_xact_lock(
        &key,
        true,
        &acquire,
        &maintenance,
        &lease,
        &db,
        move |_guarded| {
            Box::pin(async move {
                marker.store(true, Ordering::SeqCst);
                Ok::<_, sea_orm::DbErr>(())
            })
        },
    )
    .await
    .unwrap_err();

    assert_eq!(error.kind, LockErrorKind::LostLease);
    assert_eq!(error.step, Some(LockStep::FiduciaRenew));
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "lease loss must interrupt PostgreSQL advisory-lock contention"
    );
    assert!(!work_ran.load(Ordering::SeqCst));
    assert_eq!(lease.renewals.load(Ordering::SeqCst), 1);
    assert_eq!(lease.releases.load(Ordering::SeqCst), 1);

    holder.rollback().await.unwrap();
}
