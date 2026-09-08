import 'lease.dart';

/// Logical-clock domain shared with JavaScript clients.
const int maxRenewalClockMs = 9007199254740991;

/// Largest TTL exactly representable by every supported duration type.
const int maxRenewalTtlMs = 9223372036854;

/// Scheduling policy for a held Fiducia lease.
final class RenewalPolicy {
  final Duration renewEvery;
  final Duration safetyMargin;

  const RenewalPolicy({required this.renewEvery, required this.safetyMargin});

  static const defaults = RenewalPolicy(
    renewEvery: Duration(seconds: 20),
    safetyMargin: Duration(seconds: 10),
  );
}

/// Why this supervisor permanently stopped authorizing protected effects.
enum RenewalLossReason {
  invalidPolicy('invalid_policy'),
  clockRegression('clock_regression'),
  expired('expired'),
  renewalFailed('renewal_failed'),
  identityChanged('identity_changed'),
  tokenChanged('token_changed'),
  deadlineMissing('deadline_missing'),
  deadlineInvalid('deadline_invalid'),
  deadlineRegressed('deadline_regressed'),
  completionAfterDeadline('completion_after_deadline'),
  deadlineOverflow('deadline_overflow'),
  invalidTtl('invalid_ttl');

  final String wire;
  const RenewalLossReason(this.wire);
}

/// Terminal renewal error. Once recorded by a supervisor it is sticky.
final class RenewalError implements Exception {
  final RenewalLossReason reason;
  final String message;
  final Object? cause;

  const RenewalError(this.reason, this.message, {this.cause});

  @override
  String toString() => cause == null
      ? '${reason.wire}: $message'
      : '${reason.wire}: $message; cause: $cause';
}

sealed class RenewalDecision {
  const RenewalDecision();
}

final class RenewalWait extends RenewalDecision {
  final int checkInMs;
  const RenewalWait(this.checkInMs);
}

final class RenewalNow extends RenewalDecision {
  const RenewalNow();
}

final class RenewalLost extends RenewalDecision {
  final RenewalLossReason reason;
  const RenewalLost(this.reason);
}

sealed class RenewalCheckpoint {
  const RenewalCheckpoint();
}

final class RenewalCheckpointWait extends RenewalCheckpoint {
  final int checkInMs;
  const RenewalCheckpointWait(this.checkInMs);
}

final class RenewalCheckpointRenewed extends RenewalCheckpoint {
  final int checkInMs;
  const RenewalCheckpointRenewed(this.checkInMs);
}

/// Source of process-local monotonic milliseconds.
typedef MonotonicClock = int Function();

/// A [Stopwatch]-based monotonic clock suitable for one supervisor lifetime.
final class StopwatchClock {
  final Stopwatch _stopwatch;
  final int _originMs;

  StopwatchClock({int originMs = 0})
    : _originMs = originMs,
      _stopwatch = Stopwatch()..start();

  int call() => _originMs + _stopwatch.elapsedMilliseconds;
}

/// Sticky, cooperative supervisor for one exact Fiducia grant identity.
///
/// Call [checkpoint] before every authoritative commit. This cannot undo an
/// unfenced side effect already emitted by the caller; protected datastores
/// must still admit the fencing token atomically with the mutation.
final class LeaseRenewalSupervisor {
  LeaseGrant _grant;
  final RenewalPolicy policy;
  int _localDeadlineMs;
  int _nextRenewalMs;
  int _lastObservedMs;
  RenewalError? _loss;

  LeaseRenewalSupervisor(LeaseGrant grant, this.policy, int nowMs)
    : _grant = grant,
      _localDeadlineMs = 0,
      _nextRenewalMs = 0,
      _lastObservedMs = nowMs {
    _validateGrant(grant);
    _validateClock(nowMs);
    _validateAuthorityDeadline(grant.leaseExpiresMs);
    final schedule = _schedule(nowMs, grant.ttlMs, policy);
    _localDeadlineMs = schedule.$1;
    _nextRenewalMs = schedule.$2;
  }

  LeaseGrant get grant => _grant;
  int get localDeadlineMs => _localDeadlineMs;
  int get nextRenewalMs => _nextRenewalMs;
  RenewalError? get loss => _loss;
  bool get isLive => _loss == null;

  RenewalDecision decide(int nowMs) {
    final loss = _loss;
    if (loss != null) return RenewalLost(loss.reason);
    try {
      _validateClock(nowMs);
    } on RenewalError catch (error) {
      return _lose(error);
    }
    if (nowMs < _lastObservedMs) {
      return _lose(
        RenewalError(
          RenewalLossReason.clockRegression,
          'monotonic clock regressed from $_lastObservedMs to $nowMs',
        ),
      );
    }
    _lastObservedMs = nowMs;
    if (nowMs >= _localDeadlineMs) {
      return _lose(
        RenewalError(
          RenewalLossReason.expired,
          'local lease deadline $_localDeadlineMs was reached at $nowMs',
        ),
      );
    }
    if (nowMs >= _nextRenewalMs) return const RenewalNow();
    return RenewalWait(_nextRenewalMs - nowMs);
  }

  void assertLive(int nowMs) {
    if (decide(nowMs) case RenewalLost()) throw _loss!;
  }

  Future<RenewalCheckpoint> checkpoint(
    Lease lease, {
    required MonotonicClock clock,
  }) async {
    final decision = decide(clock());
    if (decision is RenewalWait) {
      return RenewalCheckpointWait(decision.checkInMs);
    }
    if (decision is RenewalLost) throw _loss!;

    final previous = _grant;
    late final LeaseGrant renewed;
    try {
      renewed = await lease.renew(
        previous,
        Duration(milliseconds: previous.ttlMs),
      );
    } catch (cause) {
      throw _fail(
        RenewalError(
          RenewalLossReason.renewalFailed,
          'lease authority did not prove continued ownership',
          cause: cause,
        ),
      );
    }
    return acceptRenewal(clock(), renewed);
  }

  RenewalCheckpoint acceptRenewal(int completedMs, LeaseGrant renewed) {
    if (_loss != null) throw _loss!;
    try {
      _validateClock(completedMs);
      _validateGrant(renewed);
    } on RenewalError catch (error) {
      throw _fail(error);
    }
    if (completedMs < _lastObservedMs) {
      throw _fail(
        RenewalError(
          RenewalLossReason.clockRegression,
          'monotonic clock regressed from $_lastObservedMs to $completedMs during renewal',
        ),
      );
    }
    _lastObservedMs = completedMs;
    if (completedMs >= _localDeadlineMs) {
      throw _fail(
        RenewalError(
          RenewalLossReason.completionAfterDeadline,
          'renewal completed at $completedMs, not before local deadline $_localDeadlineMs',
        ),
      );
    }
    if (renewed.key != _grant.key || renewed.holder != _grant.holder) {
      throw _fail(
        const RenewalError(
          RenewalLossReason.identityChanged,
          'renewal changed the lock key or holder identity',
        ),
      );
    }
    if (renewed.fencingToken != _grant.fencingToken) {
      throw _fail(
        RenewalError(
          RenewalLossReason.tokenChanged,
          'renewal changed fencing token ${_grant.fencingToken} to ${renewed.fencingToken}',
        ),
      );
    }
    try {
      _validateDeadlineProgress(_grant.leaseExpiresMs, renewed.leaseExpiresMs);
      final schedule = _schedule(completedMs, renewed.ttlMs, policy);
      _grant = renewed;
      _localDeadlineMs = schedule.$1;
      _nextRenewalMs = schedule.$2;
      return RenewalCheckpointRenewed(_nextRenewalMs - completedMs);
    } on RenewalError catch (error) {
      throw _fail(error);
    }
  }

  RenewalDecision _lose(RenewalError error) {
    final recorded = _record(error);
    return RenewalLost(recorded.reason);
  }

  RenewalError _fail(RenewalError error) => _record(error);

  RenewalError _record(RenewalError error) {
    _loss ??= error;
    return _loss!;
  }
}

void _validateGrant(LeaseGrant grant) {
  if (grant.holder.isEmpty) {
    throw const RenewalError(
      RenewalLossReason.identityChanged,
      'grant holder must be non-empty',
    );
  }
  if (grant.fencingToken.isNegative ||
      grant.fencingToken > BigInt.parse('18446744073709551615')) {
    throw const RenewalError(
      RenewalLossReason.tokenChanged,
      'fencing token must be an unsigned 64-bit integer',
    );
  }
  if (grant.ttlMs <= 0 || grant.ttlMs > maxRenewalTtlMs) {
    throw const RenewalError(
      RenewalLossReason.invalidTtl,
      'lease TTL is outside the shared millisecond domain',
    );
  }
  _validateAuthorityDeadline(grant.leaseExpiresMs);
}

void _validateClock(int value) {
  if (value < 0 || value > maxRenewalClockMs) {
    throw const RenewalError(
      RenewalLossReason.deadlineOverflow,
      'logical clock is outside the shared millisecond domain',
    );
  }
}

void _validateAuthorityDeadline(int? value) {
  if (value != null && (value <= 0 || value > maxRenewalClockMs)) {
    throw const RenewalError(
      RenewalLossReason.deadlineInvalid,
      'authority deadline must be positive and within the shared millisecond domain',
    );
  }
}

void _validateDeadlineProgress(int? previous, int? renewed) {
  _validateAuthorityDeadline(renewed);
  if (previous != null && renewed == null) {
    throw const RenewalError(
      RenewalLossReason.deadlineMissing,
      'renewal omitted a deadline that the authority previously reported',
    );
  }
  if (previous != null && renewed != null && renewed <= previous) {
    throw RenewalError(
      RenewalLossReason.deadlineRegressed,
      'authority deadline did not advance: $previous -> $renewed',
    );
  }
}

(int, int) _schedule(int nowMs, int ttlMs, RenewalPolicy policy) {
  _validateClock(nowMs);
  if (ttlMs <= 0 || ttlMs > maxRenewalTtlMs) {
    throw const RenewalError(
      RenewalLossReason.invalidTtl,
      'lease TTL is outside the shared millisecond domain',
    );
  }
  final renewEveryMs = policy.renewEvery.inMilliseconds;
  final safetyMarginMs = policy.safetyMargin.inMilliseconds;
  if (renewEveryMs <= 0 ||
      safetyMarginMs <= 0 ||
      renewEveryMs >= ttlMs ||
      safetyMarginMs >= ttlMs) {
    throw const RenewalError(
      RenewalLossReason.invalidPolicy,
      'renewal interval and safety margin must both be positive and less than the lease TTL',
    );
  }
  final deadlineMs = nowMs + ttlMs;
  final intervalDue = nowMs + renewEveryMs;
  if (deadlineMs > maxRenewalClockMs || intervalDue > maxRenewalClockMs) {
    throw const RenewalError(
      RenewalLossReason.deadlineOverflow,
      'renewal schedule exceeds the shared logical-clock domain',
    );
  }
  final marginDue = deadlineMs - safetyMarginMs;
  final nextRenewalMs = intervalDue < marginDue ? intervalDue : marginDue;
  if (nextRenewalMs <= nowMs) {
    throw const RenewalError(
      RenewalLossReason.invalidPolicy,
      'renewal policy leaves no positive live interval',
    );
  }
  return (deadlineMs, nextRenewalMs);
}
