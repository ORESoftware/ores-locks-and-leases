import 'dart:convert';
import 'dart:io';

import 'package:ores_locks_and_leases/ores_locks_and_leases.dart';
import 'package:test/test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

List<dynamic> cases(String name) =>
    (jsonDecode(File('../../conformance/cases/$name').readAsStringSync())
        as Map)['cases'] as List;

final class FakeLease implements Lease {
  bool held;
  final bool lapseOnRelease;
  final bool failRelease;
  BigInt next = BigInt.zero;
  final log = <LockStep>[];
  FakeLease(
      {this.held = false,
      this.lapseOnRelease = false,
      this.failRelease = false});

  @override
  Future<LeaseGrant> acquire(LockKey key, AcquireOptions opts,
      {required bool wait}) async {
    log.add(wait ? LockStep.fiduciaAcquire : LockStep.fiduciaTryAcquire);
    if (held) {
      throw wait
          ? LockError.timeout(
              key, LockStep.fiduciaAcquire, opts.waitTimeout.inMilliseconds)
          : LockError.contention(key, LockStep.fiduciaTryAcquire);
    }
    held = true;
    next += BigInt.one;
    return LeaseGrant(
        key: key,
        holder: 'fake',
        fencingToken: next,
        ttlMs: opts.ttl.inMilliseconds);
  }

  @override
  Future<LeaseGrant> renew(LeaseGrant grant, Duration ttl) async =>
      grant.copyWith(ttlMs: ttl.inMilliseconds);

  @override
  Future<bool> release(LeaseGrant grant) async {
    log.add(LockStep.fiduciaRelease);
    if (failRelease) {
      throw LockError.transport(
          grant.key, 'release transport failed; ownership is unknown');
    }
    held = false;
    return !lapseOnRelease;
  }
}

void main() {
  test('advisory-key vectors', () {
    final vectors = cases('advisory-key.json');
    expect(vectors.length, greaterThanOrEqualTo(8));
    for (final c in vectors) {
      expect(fnv1a64(c['key'] as String),
          BigInt.parse(c['fnv1a64_unsigned'] as String),
          reason: c['key'] as String);
      expect(advisoryKey(c['key'] as String),
          BigInt.parse(c['advisory_key'] as String),
          reason: c['key'] as String);
    }
  });

  test('lock-plan matrix', () {
    final matrix = cases('lock-plan.json');
    expect(matrix.length, 11);
    for (final c in matrix) {
      final layers = LockLayers(
          fiducia: c['layers']['fiducia'] as bool,
          pgAdvisory: c['layers']['pgAdvisory'] as bool);
      final expected = (c['expect']['steps'] as List)
          .map((s) => LockStep.parse(s as String))
          .toList();
      expect(
          plan(layers, PgScope.parse(c['pgScope'] as String), c['wait'] as bool)
              .steps,
          expected,
          reason: c['name'] as String);
    }
  });

  test('lock keys are length-bounded in bytes', () {
    expect(LockKey('a' * 512).value, hasLength(512));
    expect(() => LockKey('é' * 300), throwsArgumentError);
  });

  group('FiduciaLease', () {
    final key = LockKey('t/http');

    test(
        'constructs a bearer client and parses the canonical response envelope',
        () async {
      final client = MockClient((request) async {
        expect(
            request.url.toString(), 'https://fiducia.example/v1/locks/acquire');
        expect(request.headers['authorization'], 'Bearer test-key');
        final body = jsonDecode(request.body) as Map<String, dynamic>;
        expect(body['holder'], 'test-holder');
        return http.Response(
          jsonEncode({
            'result': {
              'output': {
                'acquired': true,
                'fencing_token': '7',
                'lease_expires_ms': '1700000000000',
              },
            },
          }),
          200,
        );
      });
      final lease = FiduciaLease.bearer(
        'https://fiducia.example/',
        apiKey: 'test-key',
        client: client,
        generateHolder: () => 'test-holder',
      );

      final grant =
          await lease.acquire(key, const AcquireOptions(), wait: false);

      expect(grant.holder, 'test-holder');
      expect(grant.fencingToken, BigInt.from(7));
      expect(grant.leaseExpiresMs, 1700000000000);
    });

    test('fails closed before sending credentials to public cleartext HTTP',
        () async {
      var called = false;
      final lease = FiduciaLease.bearer(
        'http://fiducia.example',
        apiKey: 'test-key',
        client: MockClient((_) async {
          called = true;
          return http.Response('{}', 200);
        }),
      );

      await expectLater(
        lease.acquire(key, const AcquireOptions(), wait: false),
        throwsA(isA<LockError>()
            .having((error) => error.kind, 'kind', LockErrorKind.transport)),
      );
      expect(called, isFalse);
    });

    test('fails closed on fencing tokens outside exact JSON-number range',
        () async {
      final responseLease = FiduciaLease.bearer(
        'https://fiducia.example',
        apiKey: 'test-key',
        client: MockClient((_) async => http.Response(
            '{"result":{"output":{"acquired":true,"fencing_token":9007199254740993}}}',
            200)),
      );
      await expectLater(
          responseLease.acquire(key, const AcquireOptions(), wait: false),
          throwsA(isA<LockError>()
              .having((e) => e.kind, 'kind', LockErrorKind.transport)));

      var called = false;
      final requestLease = FiduciaLease.bearer(
        'https://fiducia.example',
        apiKey: 'test-key',
        client: MockClient((_) async {
          called = true;
          return http.Response('{}', 200);
        }),
      );
      await expectLater(
        requestLease.release(LeaseGrant(
            key: key,
            holder: 'holder',
            fencingToken: BigInt.parse('9007199254740993'),
            ttlMs: 1000)),
        throwsA(isA<LockError>()
            .having((e) => e.kind, 'kind', LockErrorKind.transport)
            .having((e) => e.message, 'message',
                contains('cannot be represented exactly'))),
      );
      expect(called, isFalse);
    });
  });

  group('withLease', () {
    final key = LockKey('t/unit');

    test('disabled layer is a pass-through', () async {
      final lease = FakeLease();
      expect(
          await withLease(key,
              engage: false,
              wait: true,
              lease: lease,
              work: (g) async => g.grant == null),
          isTrue);
      expect(lease.log, isEmpty);
    });

    test('enabled without an authority is invalidPlan', () async {
      await expectLater(
        withLease(key, engage: true, wait: true, work: (_) async => 1),
        throwsA(isA<LockError>()
            .having((e) => e.kind, 'kind', LockErrorKind.invalidPlan)),
      );
    });

    test('acquire → work → release with a fencing token', () async {
      final lease = FakeLease();
      final token = await withLease(key,
          engage: true,
          wait: true,
          lease: lease,
          work: (g) async => g.fencingToken);
      expect(token, BigInt.one);
      expect(lease.log, [LockStep.fiduciaAcquire, LockStep.fiduciaRelease]);
      expect(lease.held, isFalse);
    });

    test('work failure still releases and is reported as work', () async {
      final lease = FakeLease();
      await expectLater(
        withLease(key,
            engage: true,
            wait: false,
            lease: lease,
            work: (_) async => throw StateError('kaboom')),
        throwsA(isA<LockError>()
            .having((e) => e.kind, 'kind', LockErrorKind.work)
            .having((e) => e.step, 'step', LockStep.work)),
      );
      expect(lease.held, isFalse);
    });

    test('contention without wait, timeout with wait, lostLease on lapse',
        () async {
      final busy = FakeLease(held: true);
      await expectLater(
          withLease(key,
              engage: true, wait: false, lease: busy, work: (_) async => 1),
          throwsA(isA<LockError>()
              .having((e) => e.kind, 'kind', LockErrorKind.contention)
              .having((e) => e.retryable, 'retryable', isTrue)));
      await expectLater(
          withLease(key,
              engage: true, wait: true, lease: busy, work: (_) async => 1),
          throwsA(isA<LockError>()
              .having((e) => e.kind, 'kind', LockErrorKind.timeout)));
      final lapsing = FakeLease(lapseOnRelease: true);
      await expectLater(
          withLease(key,
              engage: true, wait: true, lease: lapsing, work: (_) async => 1),
          throwsA(isA<LockError>()
              .having((e) => e.kind, 'kind', LockErrorKind.lostLease)
              .having((e) => e.step, 'step', LockStep.fiduciaRelease)));
    });

    test('cleanup failure wins over work failure and retains both diagnostics',
        () async {
      final lease = FakeLease(failRelease: true);
      await expectLater(
        withLease(key,
            engage: true,
            wait: true,
            lease: lease,
            work: (_) async => throw StateError('work exploded')),
        throwsA(isA<LockError>()
            .having((e) => e.kind, 'kind', LockErrorKind.transport)
            .having((e) => e.step, 'step', LockStep.fiduciaRelease)
            .having((e) => e.message, 'message', contains('work exploded'))),
      );
      expect(lease.held, isTrue,
          reason: 'transport failure leaves ownership unknown');
    });

    test('confirmed lapse wins over work failure', () async {
      final lease = FakeLease(lapseOnRelease: true);
      await expectLater(
        withLease(key,
            engage: true,
            wait: true,
            lease: lease,
            work: (_) async => throw StateError('work exploded')),
        throwsA(isA<LockError>()
            .having((e) => e.kind, 'kind', LockErrorKind.lostLease)
            .having((e) => e.step, 'step', LockStep.fiduciaRelease)
            .having((e) => e.message, 'message', contains('work exploded'))),
      );
    });
  });
}
