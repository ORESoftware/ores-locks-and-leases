import 'errors.dart';
import 'key.dart';
import 'plan.dart';

/// Acquisition tuning shared by every layer. The contract's `AcquireOptions`.
final class AcquireOptions {
  /// Lease TTL. Size it to the longest the guarded work can take.
  final Duration ttl;

  /// Total time to keep waiting. Ignored when `wait` is false.
  final Duration waitTimeout;

  /// Poll interval while waiting on the fiducia layer.
  final Duration retryInterval;

  /// Caller identity for the fiducia layer; also the release key. Null lets
  /// the adapter generate an unguessable id.
  final String? holder;

  /// Mirrors the official fiducia clients: 60s lease, 30s wait budget, 250ms poll.
  const AcquireOptions({
    this.ttl = const Duration(seconds: 60),
    this.waitTimeout = const Duration(seconds: 30),
    this.retryInterval = const Duration(milliseconds: 250),
    this.holder,
  });

  AcquireOptions copyWith(
          {Duration? ttl,
          Duration? waitTimeout,
          Duration? retryInterval,
          String? holder}) =>
      AcquireOptions(
        ttl: ttl ?? this.ttl,
        waitTimeout: waitTimeout ?? this.waitTimeout,
        retryInterval: retryInterval ?? this.retryInterval,
        holder: holder ?? this.holder,
      );
}

/// A held grant. The contract's `LeaseGrant`. [fencingToken] is minted on
/// every grant and increases monotonically; guarded writes should record it
/// (`WHERE fencing_token < @new`) so a holder whose lease lapsed cannot
/// overwrite a newer holder's work.
final class LeaseGrant {
  final LockKey key;
  final String holder;
  final BigInt fencingToken;

  /// Absolute expiry in Unix ms when the authority reports it.
  final int? leaseExpiresMs;
  final int ttlMs;

  const LeaseGrant(
      {required this.key,
      required this.holder,
      required this.fencingToken,
      this.leaseExpiresMs,
      required this.ttlMs});

  LeaseGrant copyWith({int? leaseExpiresMs, int? ttlMs}) => LeaseGrant(
      key: key,
      holder: holder,
      fencingToken: fencingToken,
      leaseExpiresMs: leaseExpiresMs ?? this.leaseExpiresMs,
      ttlMs: ttlMs ?? this.ttlMs);
}

/// A lease authority: three verbs, fenced. Implementations map native
/// failures onto [LockErrorKind].
abstract interface class Lease {
  /// With [wait], block up to `opts.waitTimeout`; without it, throw
  /// `contention` at once if the key is held.
  Future<LeaseGrant> acquire(LockKey key, AcquireOptions opts,
      {required bool wait});

  /// Extend a grant without changing its fencing token. A refusal is
  /// `lostLease`, never a warning.
  Future<LeaseGrant> renew(LeaseGrant grant, Duration ttl);

  /// `false` is a committed no-op: the authority matched no grant — the lease
  /// had already lapsed.
  Future<bool> release(LeaseGrant grant);
}

/// What `work` receives from [withLease]: the grant when the layer is on.
base class Guarded {
  final LockKey key;

  /// The fiducia grant; its `fencingToken` is what guarded writes should record.
  final LeaseGrant? grant;

  const Guarded({required this.key, this.grant});

  BigInt? get fencingToken => grant?.fencingToken;
}

/// Run [work] under a fiducia lease only — no database layer. For work that
/// touches no Postgres, or that manages its own transactions and only needs
/// cross-host exclusion and a fencing token.
///
/// `engage == false` is the contract's "neither" plan: [work] runs with no
/// grant and nothing is acquired. `engage` with no [lease] is `invalidPlan`.
///
/// Ordering: acquire → work → release. The lease is always released, even
/// when [work] throws. If [work] succeeded but the authority reports that the
/// release matched no grant, the result is `lostLease`.
Future<T> withLease<T>(
  LockKey key, {
  required bool engage,
  required bool wait,
  AcquireOptions opts = const AcquireOptions(),
  Lease? lease,
  required Future<T> Function(Guarded guarded) work,
}) async {
  if (!engage) return runWork(key, Guarded(key: key), work);
  if (lease == null) {
    throw LockError.invalidPlan(
        key, 'layers.fiducia is enabled but no lease authority was supplied');
  }
  final grant = await acquireLease(key, wait: wait, opts: opts, lease: lease);
  final inner =
      await settled(() => runWork(key, Guarded(key: key, grant: grant), work));
  return settle(key, lease, grant, inner);
}

Future<T> runWork<T, G>(
    LockKey key, G guarded, Future<T> Function(G) work) async {
  try {
    return await work(guarded);
  } catch (cause) {
    throw LockError.work(key, cause);
  }
}

Future<LeaseGrant> acquireLease(LockKey key,
    {required bool wait,
    required AcquireOptions opts,
    required Lease lease}) async {
  try {
    return await lease.acquire(key, opts, wait: wait);
  } catch (err) {
    throw tagStep(
        err, wait ? LockStep.fiduciaAcquire : LockStep.fiduciaTryAcquire);
  }
}

/// A settled outcome: either a value or the error that was thrown.
final class Outcome<T> {
  final T? value;
  final Object? error;
  final StackTrace? trace;
  const Outcome.ok(this.value)
      : error = null,
        trace = null;
  const Outcome.failed(this.error, this.trace) : value = null;
  bool get ok => error == null;
}

Future<Outcome<T>> settled<T>(Future<T> Function() run) async {
  try {
    return Outcome.ok(await run());
  } catch (error, trace) {
    return Outcome.failed(error, trace);
  }
}

/// Release the lease and combine its outcome with the inner one.
Future<T> settle<T>(
    LockKey key, Lease lease, LeaseGrant grant, Outcome<T> inner) async {
  final released = await settled(() => lease.release(grant));
  if (!released.ok) {
    final cleanup = tagStep(released.error!, LockStep.fiduciaRelease);
    if (!inner.ok) throw cleanupFailure(key, cleanup, inner.error!);
    Error.throwWithStackTrace(cleanup, released.trace!);
  }
  if (released.value != true) {
    final cleanup = LockError(
      LockErrorKind.lostLease,
      key,
      'release of `$key` (holder ${grant.holder}, fencing token ${grant.fencingToken}) matched no grant: the lease lapsed while the work ran',
      step: LockStep.fiduciaRelease,
    );
    if (!inner.ok) throw cleanupFailure(key, cleanup, inner.error!);
    throw cleanup;
  }
  if (!inner.ok) Error.throwWithStackTrace(inner.error!, inner.trace!);
  return inner.value as T;
}
