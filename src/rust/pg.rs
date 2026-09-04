//! The inner layer: Postgres advisory locks through SeaORM.
//!
//! Two scopes, mirroring `pg_advisory_xact_lock` and `pg_advisory_lock`:
//!
//! * [`xact_lock`] / [`try_xact_lock`] take the lock *inside a transaction*;
//!   Postgres releases it at commit or rollback. Nothing to unlock.
//! * [`session_lock`] / [`try_session_lock`] / [`session_unlock`] take the
//!   lock on a *connection*. Because SeaORM pools connections, a session lock
//!   is only meaningful on a connection that is guaranteed to be the same one
//!   for lock, work and unlock — [`DedicatedConnection`] is that guarantee,
//!   as a type.
//!
//! Only Postgres has advisory locks; every function checks the backend and
//! reports [`LockErrorKind::InvalidPlan`] on anything else rather than
//! sending SQL that would fail in a less obvious way.

use sea_orm::{
    ConnectOptions, ConnectionTrait, Database, DatabaseConnection, DatabaseTransaction, DbBackend,
    DbErr, Statement, Value,
};

use crate::error::{LockError, LockErrorKind};
use crate::key::LockKey;
use crate::plan::LockStep;

fn statement(sql: &str, key: &LockKey) -> Statement {
    Statement::from_sql_and_values(
        DbBackend::Postgres,
        sql,
        [Value::BigInt(Some(key.advisory_key()))],
    )
}

fn db_error(key: &LockKey, step: LockStep, err: DbErr) -> LockError {
    LockError::new(LockErrorKind::Database, key, err.to_string()).at(step)
}

fn require_postgres<C: ConnectionTrait>(conn: &C, key: &LockKey) -> Result<(), LockError> {
    if conn.get_database_backend() == DbBackend::Postgres {
        Ok(())
    } else {
        Err(LockError::invalid_plan(
            key,
            "advisory locks need a Postgres connection; this backend is not Postgres",
        ))
    }
}

async fn acquire_bool<C: ConnectionTrait>(
    conn: &C,
    key: &LockKey,
    sql: &str,
    step: LockStep,
) -> Result<bool, LockError> {
    let row = conn
        .query_one(statement(sql, key))
        .await
        .map_err(|err| db_error(key, step, err))?;
    let row = row.ok_or_else(|| {
        LockError::new(
            LockErrorKind::Database,
            key,
            format!("`{sql}` returned no row"),
        )
        .at(step)
    })?;
    row.try_get_by_index::<bool>(0)
        .map_err(|err| db_error(key, step, err))
}

/// `SELECT pg_advisory_xact_lock($1)` on `txn`. Blocks until granted; the
/// lock is released when `txn` commits or rolls back.
pub async fn xact_lock(txn: &DatabaseTransaction, key: &LockKey) -> Result<(), LockError> {
    require_postgres(txn, key)?;
    txn.execute(statement("SELECT pg_advisory_xact_lock($1)", key))
        .await
        .map(|_| ())
        .map_err(|err| db_error(key, LockStep::PgAdvisoryXactLock, err))
}

/// `SELECT pg_try_advisory_xact_lock($1)` on `txn`. Never blocks; a held
/// key is [`LockErrorKind::Contention`].
pub async fn try_xact_lock(txn: &DatabaseTransaction, key: &LockKey) -> Result<(), LockError> {
    require_postgres(txn, key)?;
    let acquired = acquire_bool(
        txn,
        key,
        "SELECT pg_try_advisory_xact_lock($1)",
        LockStep::PgTryAdvisoryXactLock,
    )
    .await?;
    if acquired {
        Ok(())
    } else {
        Err(LockError::contention(key, LockStep::PgTryAdvisoryXactLock))
    }
}

/// A SeaORM connection whose pool holds exactly one physical connection, so
/// every statement — lock, work, unlock — reaches the same Postgres session.
/// The only handle [`session_lock`] and friends accept.
#[derive(Debug, Clone)]
pub struct DedicatedConnection(DatabaseConnection);

impl DedicatedConnection {
    /// Connect with `max_connections = min_connections = 1`. Every other
    /// option on `options` is kept.
    pub async fn connect(mut options: ConnectOptions) -> Result<Self, DbErr> {
        options.max_connections(1).min_connections(1);
        Database::connect(options).await.map(Self)
    }

    /// Wrap a connection the caller vouches for. Only sound when the caller
    /// built it with a single-connection pool; a normal pooled connection
    /// makes `session_unlock` a silent no-op on a different session.
    pub fn from_single_connection_pool(conn: DatabaseConnection) -> Self {
        Self(conn)
    }

    pub fn inner(&self) -> &DatabaseConnection {
        &self.0
    }

    pub fn into_inner(self) -> DatabaseConnection {
        self.0
    }
}

/// `SELECT pg_advisory_lock($1)` on the dedicated session. Blocks until
/// granted; pair with [`session_unlock`].
pub async fn session_lock(conn: &DedicatedConnection, key: &LockKey) -> Result<(), LockError> {
    require_postgres(conn.inner(), key)?;
    conn.inner()
        .execute(statement("SELECT pg_advisory_lock($1)", key))
        .await
        .map(|_| ())
        .map_err(|err| db_error(key, LockStep::PgAdvisoryLock, err))
}

/// `SELECT pg_try_advisory_lock($1)` on the dedicated session. A held key is
/// [`LockErrorKind::Contention`].
pub async fn try_session_lock(conn: &DedicatedConnection, key: &LockKey) -> Result<(), LockError> {
    require_postgres(conn.inner(), key)?;
    let acquired = acquire_bool(
        conn.inner(),
        key,
        "SELECT pg_try_advisory_lock($1)",
        LockStep::PgTryAdvisoryLock,
    )
    .await?;
    if acquired {
        Ok(())
    } else {
        Err(LockError::contention(key, LockStep::PgTryAdvisoryLock))
    }
}

/// `SELECT pg_advisory_unlock($1)`. `Ok(false)` means the session did not
/// hold the lock — a bug in the caller's pairing, surfaced rather than hidden.
pub async fn session_unlock(conn: &DedicatedConnection, key: &LockKey) -> Result<bool, LockError> {
    acquire_bool(
        conn.inner(),
        key,
        "SELECT pg_advisory_unlock($1)",
        LockStep::PgAdvisoryUnlock,
    )
    .await
}
