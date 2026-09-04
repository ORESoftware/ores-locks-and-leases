import 'package:postgres/postgres.dart';

import 'errors.dart';
import 'key.dart';
import 'lease.dart';
import 'plan.dart';

/// What transaction-scoped work receives: the [Guarded] layers plus the
/// session whose open transaction holds the advisory lock (null when the
/// Postgres layer is off). Run every statement of the work through it; the
/// lock is released when the routine commits.
final class XactGuarded extends Guarded {
  final TxSession? tx;
  const XactGuarded({required super.key, super.grant, this.tx});
}

/// What session-scoped work receives: the [Guarded] layers plus the dedicated
/// connection holding the advisory lock (null when the Postgres layer is off).
final class SessionGuarded extends Guarded {
  final Connection? connection;
  const SessionGuarded({required super.key, super.grant, this.connection});
}

TypedValue _param(LockKey key) =>
    TypedValue(Type.bigInteger, key.advisory.toInt());

Future<bool> _queryBool(
    Session session, LockKey key, String sql, LockStep step) async {
  final Result rows;
  try {
    rows =
        await session.execute(Sql.named(sql), parameters: {'k': _param(key)});
  } catch (cause) {
    throw LockError.database(key, step, cause);
  }
  if (rows.isEmpty) {
    throw LockError.database(key, step, '`$sql` returned no row');
  }
  return rows.first[0] == true;
}

Future<void> _exec(
    Session session, LockKey key, String sql, LockStep step) async {
  try {
    await session.execute(Sql.named(sql), parameters: {'k': _param(key)});
  } catch (cause) {
    throw LockError.database(key, step, cause);
  }
}

/// `SELECT pg_advisory_xact_lock(@k)` on [tx]; released at commit/rollback.
Future<void> xactLock(TxSession tx, LockKey key) => _exec(
    tx, key, 'SELECT pg_advisory_xact_lock(@k)', LockStep.pgAdvisoryXactLock);

/// `SELECT pg_try_advisory_xact_lock(@k)`; a held key is `contention`.
Future<void> tryXactLock(TxSession tx, LockKey key) async {
  final acquired = await _queryBool(tx, key,
      'SELECT pg_try_advisory_xact_lock(@k)', LockStep.pgTryAdvisoryXactLock);
  if (!acquired) {
    throw LockError.contention(key, LockStep.pgTryAdvisoryXactLock);
  }
}

Lease? _pickLease(LockKey key, LockLayers layers, Lease? lease) {
  if (!layers.fiducia) return null;
  if (lease == null) {
    throw LockError.invalidPlan(
        key, 'layers.fiducia is enabled but no lease authority was supplied');
  }
  return lease;
}

/// Run [work] under a fiducia lease and/or a transaction-scoped advisory lock
/// (`pg_advisory_xact_lock`) through `package:postgres`.
///
/// - `layers.fiducia` needs [lease]; `layers.pgAdvisory` needs [db]. A
///   missing one is `invalidPlan` before anything is acquired.
/// - `!wait` uses the non-blocking form of every acquisition and fails fast
///   with `contention`.
/// - The transaction is committed after [work] completes and rolled back when
///   it throws; the lease is released in both cases.
/// - If [work] and commit succeeded but the lease had already lapsed, the
///   result is `lostLease`.
Future<T> withXactLock<T>(
  LockKey key, {
  required LockLayers layers,
  required bool wait,
  AcquireOptions opts = const AcquireOptions(),
  Lease? lease,
  Pool? db,
  required Future<T> Function(XactGuarded guarded) work,
}) async {
  final theLease = _pickLease(key, layers, lease);
  if (layers.pgAdvisory && db == null) {
    throw LockError.invalidPlan(
        key, 'layers.pgAdvisory is enabled but no pool was supplied');
  }
  final grant = theLease == null
      ? null
      : await acquireLease(key, wait: wait, opts: opts, lease: theLease);

  final inner = await settled(() async {
    if (!layers.pgAdvisory) {
      return runWork(key, XactGuarded(key: key, grant: grant), work);
    }
    try {
      return await db!.runTx((tx) async {
        if (wait) {
          await xactLock(tx, key);
        } else {
          await tryXactLock(tx, key);
        }
        return runWork(key, XactGuarded(key: key, grant: grant, tx: tx), work);
      });
    } on LockError {
      rethrow;
    } catch (cause) {
      // Anything else escaping runTx is the transaction itself (begin/commit).
      throw LockError.database(key, LockStep.pgCommit, cause);
    }
  });
  if (theLease == null || grant == null) {
    if (!inner.ok) Error.throwWithStackTrace(inner.error!, inner.trace!);
    return inner.value as T;
  }
  return settle(key, theLease, grant, inner);
}

/// Run [work] under a fiducia lease and/or a *session*-scoped advisory lock
/// (`pg_advisory_lock` / `pg_advisory_unlock`). No transaction is opened. The
/// lock is taken on a connection checked out of [db] for the whole guarded
/// section (`Pool.withConnection`), so lock, work and unlock reach the same
/// Postgres session; [work] receives that connection.
///
/// An unlock that reports the session did not hold the lock is `database` at
/// `pg.advisory_unlock` and wins over a successful [work].
Future<T> withSessionLock<T>(
  LockKey key, {
  required LockLayers layers,
  required bool wait,
  AcquireOptions opts = const AcquireOptions(),
  Lease? lease,
  Pool? db,
  required Future<T> Function(SessionGuarded guarded) work,
}) async {
  final theLease = _pickLease(key, layers, lease);
  if (layers.pgAdvisory && db == null) {
    throw LockError.invalidPlan(key,
        'layers.pgAdvisory is enabled with session scope but no pool was supplied');
  }
  final grant = theLease == null
      ? null
      : await acquireLease(key, wait: wait, opts: opts, lease: theLease);

  final inner = await settled(() async {
    if (!layers.pgAdvisory) {
      return runWork(key, SessionGuarded(key: key, grant: grant), work);
    }
    return db!.withConnection((connection) async {
      if (wait) {
        await _exec(connection, key, 'SELECT pg_advisory_lock(@k)',
            LockStep.pgAdvisoryLock);
      } else {
        final acquired = await _queryBool(connection, key,
            'SELECT pg_try_advisory_lock(@k)', LockStep.pgTryAdvisoryLock);
        if (!acquired) {
          throw LockError.contention(key, LockStep.pgTryAdvisoryLock);
        }
      }
      final result = await settled(() => runWork(
          key,
          SessionGuarded(key: key, grant: grant, connection: connection),
          work));
      final unlocked = await settled(() => _queryBool(connection, key,
          'SELECT pg_advisory_unlock(@k)', LockStep.pgAdvisoryUnlock));
      if (!result.ok) Error.throwWithStackTrace(result.error!, result.trace!);
      if (!unlocked.ok) {
        Error.throwWithStackTrace(unlocked.error!, unlocked.trace!);
      }
      if (unlocked.value != true) {
        throw LockError(LockErrorKind.database, key,
            'pg_advisory_unlock reported the session did not hold `$key`',
            step: LockStep.pgAdvisoryUnlock);
      }
      return result.value as T;
    });
  });
  if (theLease == null || grant == null) {
    if (!inner.ok) Error.throwWithStackTrace(inner.error!, inner.trace!);
    return inner.value as T;
  }
  return settle(key, theLease, grant, inner);
}
