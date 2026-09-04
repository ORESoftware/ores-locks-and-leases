import 'dart:convert';
import 'dart:io';

import 'package:ores_locks_and_leases/ores_locks_and_leases.dart';
import 'package:test/test.dart';

List<dynamic> cases(String name) =>
    (jsonDecode(File('../../conformance/cases/$name').readAsStringSync()) as Map)['cases'] as List;

final class FakeLease implements Lease {
  bool held;
  final bool lapseOnRelease;
  BigInt next = BigInt.zero;
  final log = <LockStep>[];
  FakeLease({this.held = false, this.lapseOnRelease = false});

  @override
  Future<LeaseGrant> acquire(LockKey key, AcquireOptions opts, {required bool wait}) async {
    log.add(wait ? LockStep.fiduciaAcquire : LockStep.fiduciaTryAcquire);
    if (held) {
      throw wait ? LockError.timeout(key, LockStep.fiduciaAcquire, opts.waitTimeout.inMilliseconds) : LockError.contention(key, LockStep.fiduciaTryAcquire);
    }
    held = true;
    next += BigInt.one;
    return LeaseGrant(key: key, holder: 'fake', fencingToken: next, ttlMs: opts.ttl.inMilliseconds);
  }

  @override
  Future<LeaseGrant> renew(LeaseGrant grant, Duration ttl) async => grant.copyWith(ttlMs: ttl.inMilliseconds);

  @override
  Future<bool> release(LeaseGrant grant) async {
    log.add(LockStep.fiduciaRelease);
    held = false;
    return !lapseOnRelease;
  }
}

void main() {
  test('advisory-key vectors', () {
    final vectors = cases('advisory-key.json');
    expect(vectors.length, greaterThanOrEqualTo(8));
    for (final c in vectors) {
      expect(fnv1a64(c['key'] as String), BigInt.parse(c['fnv1a64_unsigned'] as String), reason: c['key'] as String);
      expect(advisoryKey(c['key'] as String), BigInt.parse(c['advisory_key'] as String), reason: c['key'] as String);
    }
  });

  test('lock-plan matrix', () {
    final matrix = cases('lock-plan.json');
    expect(matrix.length, 11);
    for (final c in matrix) {
      final layers = LockLayers(fiducia: c['layers']['fiducia'] as bool, pgAdvisory: c['layers']['pgAdvisory'] as bool);
      final expected = (c['expect']['steps'] as List).map((s) => LockStep.parse(s as String)).toList();
      expect(plan(layers, PgScope.parse(c['pgScope'] as String), c['wait'] as bool).steps, expected, reason: c['name'] as String);
    }
  });

  test('lock keys are length-bounded in bytes', () {
    expect(LockKey('a' * 512).value, hasLength(512));
    expect(() => LockKey('é' * 300), throwsArgumentError);
  });

  group('withLease', () {
    final key = LockKey('t/unit');

    test('disabled layer is a pass-through', () async {
      final lease = FakeLease();
      expect(await withLease(key, engage: false, wait: true, lease: lease, work: (g) async => g.grant == null), isTrue);
      expect(lease.log, isEmpty);
    });

    test('enabled without an authority is invalidPlan', () async {
      await expectLater(
        withLease(key, engage: true, wait: true, work: (_) async => 1),
        throwsA(isA<LockError>().having((e) => e.kind, 'kind', LockErrorKind.invalidPlan)),
      );
    });

    test('acquire → work → release with a fencing token', () async {
      final lease = FakeLease();
      final token = await withLease(key, engage: true, wait: true, lease: lease, work: (g) async => g.fencingToken);
      expect(token, BigInt.one);
      expect(lease.log, [LockStep.fiduciaAcquire, LockStep.fiduciaRelease]);
      expect(lease.held, isFalse);
    });

    test('work failure still releases and is reported as work', () async {
      final lease = FakeLease();
      await expectLater(
        withLease(key, engage: true, wait: false, lease: lease, work: (_) async => throw StateError('kaboom')),
        throwsA(isA<LockError>().having((e) => e.kind, 'kind', LockErrorKind.work).having((e) => e.step, 'step', LockStep.work)),
      );
      expect(lease.held, isFalse);
    });

    test('contention without wait, timeout with wait, lostLease on lapse', () async {
      final busy = FakeLease(held: true);
      await expectLater(withLease(key, engage: true, wait: false, lease: busy, work: (_) async => 1),
          throwsA(isA<LockError>().having((e) => e.kind, 'kind', LockErrorKind.contention).having((e) => e.retryable, 'retryable', isTrue)));
      await expectLater(withLease(key, engage: true, wait: true, lease: busy, work: (_) async => 1),
          throwsA(isA<LockError>().having((e) => e.kind, 'kind', LockErrorKind.timeout)));
      final lapsing = FakeLease(lapseOnRelease: true);
      await expectLater(withLease(key, engage: true, wait: true, lease: lapsing, work: (_) async => 1),
          throwsA(isA<LockError>().having((e) => e.kind, 'kind', LockErrorKind.lostLease).having((e) => e.step, 'step', LockStep.fiduciaRelease)));
    });
  });
}
