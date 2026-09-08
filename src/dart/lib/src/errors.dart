import 'key.dart';
import 'plan.dart';

/// Why an acquisition or guarded run failed. The contract's `LockErrorKind`.
enum LockErrorKind {
  /// A layer is held by someone else and `wait` was false.
  contention('contention'),

  /// The wait budget elapsed before every layer was held.
  timeout('timeout'),

  /// The fiducia lease could not be renewed or was reaped; fenced authority
  /// is gone and the guarded work must not continue.
  lostLease('lost_lease'),

  /// Transport/HTTP failure talking to the lease authority; ownership is
  /// unknown — never treat this as "not held".
  transport('transport'),

  /// The database refused the advisory statement, the transaction, or the
  /// connection.
  database('database'),

  /// The caller's work threw; outer layers were still released and the
  /// transaction, if any, rolled back.
  work('work'),

  /// The inputs cannot be planned.
  invalidPlan('invalid_plan');

  final String wire;
  const LockErrorKind(this.wire);
}

/// The one structured failure every routine surfaces. The contract's `LockError`.
final class LockError implements Exception {
  final LockErrorKind kind;
  final LockKey key;

  /// Which step failed, when known.
  LockStep? step;
  final String message;
  final Object? cause;

  LockError(this.kind, this.key, this.message, {this.step, this.cause});

  LockError.contention(this.key, LockStep this.step)
      : kind = LockErrorKind.contention,
        message = '`$key` is held by another holder',
        cause = null;

  LockError.timeout(this.key, LockStep this.step, int waitedMs)
      : kind = LockErrorKind.timeout,
        message = 'gave up waiting for `$key` after $waitedMs ms',
        cause = null;

  LockError.work(this.key, Object this.cause)
      : kind = LockErrorKind.work,
        step = LockStep.work,
        message = cause.toString();

  LockError.invalidPlan(this.key, this.message)
      : kind = LockErrorKind.invalidPlan,
        cause = null;

  LockError.database(this.key, LockStep this.step, Object this.cause)
      : kind = LockErrorKind.database,
        message = cause.toString();

  LockError.transport(this.key, Object this.cause, {this.step})
      : kind = LockErrorKind.transport,
        message = cause.toString();

  /// Retrying the whole routine is reasonable: busy or out of budget, nothing half-done.
  bool get retryable =>
      kind == LockErrorKind.contention || kind == LockErrorKind.timeout;

  @override
  String toString() => step == null
      ? '${kind.wire} for `$key`: $message'
      : '${kind.wire} at ${step!.wire} for `$key`: $message';
}

/// Fill in the step on a [LockError] that has none; other errors pass through.
Object tagStep(Object error, LockStep step) {
  if (error is LockError && error.step == null) error.step = step;
  return error;
}

/// Keep a safety-critical cleanup failure primary while retaining the guarded
/// operation's earlier failure. A failed release/unlock leaves ownership or
/// session state unknown, so callers must not see only a work error and assume
/// an immediate whole-operation retry is safe.
LockError cleanupFailure(LockKey key, Object cleanup, Object inner) {
  final normalized =
      cleanup is LockError ? cleanup : LockError.transport(key, cleanup);
  return LockError(
    normalized.kind,
    normalized.key,
    '${normalized.message}; guarded operation also failed: $inner',
    step: normalized.step,
    cause: (cleanup: cleanup, inner: inner),
  );
}
