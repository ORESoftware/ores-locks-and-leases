import 'dart:async';

import 'package:postgres/postgres.dart';

import 'errors.dart';
import 'key.dart';
import 'lease.dart';
import 'plan.dart';

/// Renewal cadence for a maintained Fiducia + PostgreSQL transaction.
final class LeaseMaintenanceOptions {
  /// Must be positive and no greater than half of [AcquireOptions.ttl].
  final Duration renewInterval;

  const LeaseMaintenanceOptions({
    this.renewInterval = const Duration(seconds: 20),
  });
}

/// Cooperative cancellation signal for maintained work.
final class LeaseMaintenanceSignal {
  final Completer<Object> _cancelled = Completer<Object>();

  bool get cancelled => _cancelled.isCompleted;
  Future<Object> get whenCancelled => _cancelled.future;

  void _cancel(Object reason) {
    if (!_cancelled.isCompleted) _cancelled.complete(reason);
  }
}

/// What [withMaintainedXactLock] supplies to protected work.
final class MaintainedXactGuarded extends Guarded {
  /// The session whose open transaction owns the advisory lock.
  final TxSession tx;

  /// Completed with the renewal failure when fenced authority is lost.
  final LeaseMaintenanceSignal signal;

  const MaintainedXactGuarded({
    required super.key,
    required LeaseGrant super.grant,
    required this.tx,
    required this.signal,
  });
}

/// Validate timing before either coordination layer is acquired.
void validateLeaseMaintenanceOptions(
  LockKey key,
  AcquireOptions acquire,
  LeaseMaintenanceOptions maintenance, {
  required bool wait,
}) {
  final ttlMs = acquire.ttl.inMilliseconds;
  final renewMs = maintenance.renewInterval.inMilliseconds;
  if (ttlMs <= 0) {
    throw LockError.invalidPlan(
      key,
      'fiducia lease TTL must be greater than zero',
    );
  }
  if (renewMs <= 0) {
    throw LockError.invalidPlan(
      key,
      'fiducia renewal interval must be greater than zero',
    );
  }
  if (renewMs > ttlMs ~/ 2) {
    throw LockError.invalidPlan(
      key,
      'fiducia renewal interval $renewMs ms is unsafe for TTL $ttlMs ms; '
      'it must be no greater than half the TTL',
    );
  }
  if (acquire.waitTimeout.isNegative) {
    throw LockError.invalidPlan(
      key,
      'PostgreSQL advisory-lock wait timeout must not be negative',
    );
  }
  if (wait && acquire.retryInterval.inMilliseconds <= 0) {
    throw LockError.invalidPlan(
      key,
      'PostgreSQL advisory-lock retry interval must be greater than zero '
      'when wait is enabled',
    );
  }
}

LockError _renewalError(LockKey key, Object cause) {
  final error = cause is LockError ? cause : LockError.transport(key, cause);
  return tagStep(error, LockStep.fiduciaRenew) as LockError;
}

/// Reject any renewal response that changes fenced grant identity.
void validateRenewedLeaseGrant(
  LeaseGrant original,
  LeaseGrant renewed,
) {
  final changed = renewed.key != original.key
      ? 'key'
      : renewed.holder != original.holder
          ? 'holder'
          : renewed.fencingToken != original.fencingToken
              ? 'fencing token'
              : null;
  if (changed != null) {
    throw LockError(
      LockErrorKind.lostLease,
      original.key,
      'fiducia renewal changed the grant $changed; fenced authority cannot '
      'be proven',
      step: LockStep.fiduciaRenew,
    );
  }
}

Future<LeaseGrant> _renewChecked(
  Lease lease,
  LeaseGrant original,
  Duration ttl,
) async {
  final LeaseGrant renewed;
  try {
    renewed = await lease.renew(original, ttl);
  } catch (cause) {
    throw _renewalError(original.key, cause);
  }
  validateRenewedLeaseGrant(original, renewed);
  return renewed;
}

final class _LeaseMaintainer {
  final Lease lease;
  final LeaseGrant grant;
  final Duration ttl;
  final Duration interval;
  final LeaseMaintenanceSignal signal = LeaseMaintenanceSignal();
  final Completer<void> _stop = Completer<void>();
  final Completer<LockError> _failed = Completer<LockError>();

  late final Future<void> _task;
  LockError? failure;

  _LeaseMaintainer(this.lease, this.grant, this.ttl, this.interval) {
    _task = _run();
  }

  Future<LockError> get whenFailed => _failed.future;

  Future<void> stop() async {
    if (!_stop.isCompleted) _stop.complete();
    await _task;
  }

  Future<void> _run() async {
    while (!_stop.isCompleted) {
      final shouldRenew = await Future.any<bool>([
        Future<void>.delayed(interval).then((_) => true),
        _stop.future.then((_) => false),
      ]);
      if (!shouldRenew) return;

      try {
        await _renewChecked(lease, grant, ttl);
      } catch (cause) {
        final error = _renewalError(grant.key, cause as Object);
        failure = error;
        signal._cancel(error);
        if (!_failed.isCompleted) _failed.complete(error);
        return;
      }
    }
  }
}

TypedValue _keyParameter(LockKey key) =>
    TypedValue(Type.bigInteger, key.advisory.toInt());

Future<bool> _tryXactLock(
  TxSession tx,
  LockKey key, {
  required bool wait,
}) async {
  final step =
      wait ? LockStep.pgAdvisoryXactLock : LockStep.pgTryAdvisoryXactLock;
  try {
    final rows = await tx.execute(
      Sql.named('SELECT pg_try_advisory_xact_lock(@k)'),
      parameters: {'k': _keyParameter(key)},
    );
    if (rows.isEmpty) {
      throw LockError.database(
        key,
        step,
        '`SELECT pg_try_advisory_xact_lock` returned no row',
      );
    }
    return rows.first[0] == true;
  } on LockError {
    rethrow;
  } catch (cause) {
    throw LockError.database(key, step, cause);
  }
}

Future<void> _sleepOrRenewalFailure(
  Duration duration,
  _LeaseMaintainer maintainer,
) async {
  final failure = maintainer.failure;
  if (failure != null) throw failure;

  final outcome = await Future.any<Object?>([
    Future<void>.delayed(duration).then<Object?>((_) => null),
    maintainer.whenFailed,
  ]);
  if (outcome is LockError) throw outcome;
}

Future<void> _acquireMaintainedXactLock(
  TxSession tx,
  LockKey key,
  bool wait,
  AcquireOptions acquire,
  _LeaseMaintainer maintainer,
) async {
  final elapsed = Stopwatch()..start();
  while (true) {
    final failure = maintainer.failure;
    if (failure != null) throw failure;
    if (await _tryXactLock(tx, key, wait: wait)) return;
    if (!wait) {
      throw LockError.contention(
        key,
        LockStep.pgTryAdvisoryXactLock,
      );
    }
    if (elapsed.elapsed >= acquire.waitTimeout) {
      throw LockError.timeout(
        key,
        LockStep.pgAdvisoryXactLock,
        acquire.waitTimeout.inMilliseconds,
      );
    }

    final remaining = acquire.waitTimeout - elapsed.elapsed;
    final delay =
        remaining < acquire.retryInterval ? remaining : acquire.retryInterval;
    await _sleepOrRenewalFailure(delay, maintainer);
  }
}

/// Hold a Fiducia lease around one PostgreSQL advisory-lock transaction.
///
/// Waiting uses `pg_try_advisory_xact_lock` polling so lease loss can interrupt
/// the wait. The outer grant is renewed while lock acquisition and work are
/// pending. After work settles, one final successful renewal is mandatory
/// before `runTx` may commit. Throwing before callback return makes
/// `package:postgres` roll the transaction back.
Future<T> withMaintainedXactLock<T>(
  LockKey key, {
  required bool wait,
  required AcquireOptions acquire,
  required LeaseMaintenanceOptions maintenance,
  required Lease lease,
  required Pool db,
  required Future<T> Function(MaintainedXactGuarded guarded) work,
}) async {
  validateLeaseMaintenanceOptions(
    key,
    acquire,
    maintenance,
    wait: wait,
  );
  final grant = await acquireLease(
    key,
    wait: wait,
    opts: acquire,
    lease: lease,
  );

  final inner = await settled(() async {
    final maintainer = _LeaseMaintainer(
      lease,
      grant,
      acquire.ttl,
      maintenance.renewInterval,
    );
    try {
      return await db.runTx((tx) async {
        T? value;
        Object? failure;
        StackTrace? failureTrace;

        try {
          await _acquireMaintainedXactLock(
            tx,
            key,
            wait,
            acquire,
            maintainer,
          );
          value = await runWork(
            key,
            MaintainedXactGuarded(
              key: key,
              grant: grant,
              tx: tx,
              signal: maintainer.signal,
            ),
            work,
          );
        } catch (error, trace) {
          failure = error;
          failureTrace = trace;
        }

        await maintainer.stop();
        final maintenanceFailure = maintainer.failure;
        if (maintenanceFailure != null) {
          failure = failure == null
              ? maintenanceFailure
              : cleanupFailure(key, maintenanceFailure, failure!);
          failureTrace ??= StackTrace.current;
        }
        if (failure != null) {
          Error.throwWithStackTrace(failure!, failureTrace!);
        }

        await _renewChecked(lease, grant, acquire.ttl);
        return value as T;
      });
    } on LockError {
      rethrow;
    } catch (cause) {
      throw LockError.database(key, LockStep.pgCommit, cause);
    } finally {
      await maintainer.stop();
    }
  });

  return settle(key, lease, grant, inner);
}

/// Maintained both-layer path with package defaults.
Future<T> withMaintainedBoth<T>(
  LockKey key, {
  required Lease lease,
  required Pool db,
  required Future<T> Function(MaintainedXactGuarded guarded) work,
}) =>
    withMaintainedXactLock(
      key,
      wait: true,
      acquire: const AcquireOptions(),
      maintenance: const LeaseMaintenanceOptions(),
      lease: lease,
      db: db,
      work: work,
    );
