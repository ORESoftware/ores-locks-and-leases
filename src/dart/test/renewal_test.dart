import 'dart:convert';
import 'dart:io';

import 'package:ores_locks_and_leases/ores_locks_and_leases.dart';
import 'package:test/test.dart';

final maxToken = BigInt.parse('18446744073709551615');

LeaseGrant grant({
  String holder = 'holder-a',
  BigInt? token,
  int? leaseExpiresMs = 100000,
  int ttlMs = 10000,
}) => LeaseGrant(
  key: LockKey('renewal/test/resource'),
  holder: holder,
  fencingToken: token ?? maxToken,
  leaseExpiresMs: leaseExpiresMs,
  ttlMs: ttlMs,
);

const policy = RenewalPolicy(
  renewEvery: Duration(milliseconds: 4000),
  safetyMargin: Duration(milliseconds: 2000),
);

final class FakeLease implements Lease {
  LeaseGrant? response;
  Object? error;
  int calls = 0;

  FakeLease({this.response, this.error});

  @override
  Future<LeaseGrant> acquire(
    LockKey key,
    AcquireOptions opts, {
    required bool wait,
  }) async => throw UnsupportedError('unused');

  @override
  Future<LeaseGrant> renew(LeaseGrant grant, Duration ttl) async {
    calls++;
    if (error != null) throw error!;
    return response!;
  }

  @override
  Future<bool> release(LeaseGrant grant) async => true;
}

void main() {
  test('shared renewal decision corpus', () {
    final corpus = jsonDecode(
      File('../../conformance/cases/renewal-decision.json').readAsStringSync(),
    ) as Map<String, Object?>;
    for (final raw in corpus['cases']! as List<Object?>) {
      final entry = (raw! as Map).cast<String, Object?>();
      final expected = (entry['expect']! as Map).cast<String, Object?>();
      if (expected['kind'] == 'invalid') {
        expect(
          () => LeaseRenewalSupervisor(
            grant(ttlMs: entry['ttlMs']! as int),
            RenewalPolicy(
              renewEvery: Duration(milliseconds: entry['renewEveryMs']! as int),
              safetyMargin: Duration(
                milliseconds: entry['safetyMarginMs']! as int,
              ),
            ),
            entry['startMs']! as int,
          ),
          throwsA(
            isA<RenewalError>().having(
              (error) => error.reason.wire,
              'reason',
              expected['reason'],
            ),
          ),
          reason: entry['name']! as String,
        );
        continue;
      }
      final supervisor = LeaseRenewalSupervisor(
        grant(ttlMs: entry['ttlMs']! as int),
        RenewalPolicy(
          renewEvery: Duration(milliseconds: entry['renewEveryMs']! as int),
          safetyMargin: Duration(milliseconds: entry['safetyMarginMs']! as int),
        ),
        entry['startMs']! as int,
      );
      final decision = supervisor.decide(entry['nowMs']! as int);
      final kind = switch (decision) {
        RenewalWait() => 'wait',
        RenewalNow() => 'renew_now',
        RenewalLost() => 'lost',
      };
      expect(kind, expected['kind'], reason: entry['name']! as String);
      if (decision is RenewalWait) {
        expect(decision.checkInMs, expected['checkInMs']);
      }
      if (decision is RenewalLost) {
        expect(decision.reason.wire, expected['reason']);
      }
      expect(supervisor.grant.fencingToken, maxToken);
    }
  });

  test('successful checkpoint preserves full-width identity', () async {
    final supervisor = LeaseRenewalSupervisor(grant(), policy, 1000);
    final lease = FakeLease(response: grant(leaseExpiresMs: 110000));
    final times = <int>[5000, 5100];
    final checkpoint = await supervisor.checkpoint(
      lease,
      clock: () => times.removeAt(0),
    );
    expect(checkpoint, isA<RenewalCheckpointRenewed>());
    expect((checkpoint as RenewalCheckpointRenewed).checkInMs, 4000);
    expect(lease.calls, 1);
    expect(supervisor.grant.fencingToken, maxToken);
    expect(supervisor.localDeadlineMs, 15100);
    expect(supervisor.nextRenewalMs, 9100);
  });

  test('renewal failure is sticky and prevents another call', () async {
    final supervisor = LeaseRenewalSupervisor(
      grant(token: BigInt.from(7)),
      policy,
      1000,
    );
    final lease = FakeLease(error: StateError('partition'));
    await expectLater(
      supervisor.checkpoint(lease, clock: () => 5000),
      throwsA(
        isA<RenewalError>().having(
          (error) => error.reason,
          'reason',
          RenewalLossReason.renewalFailed,
        ),
      ),
    );
    await expectLater(
      supervisor.checkpoint(lease, clock: () => 5001),
      throwsA(
        isA<RenewalError>().having(
          (error) => error.reason,
          'reason',
          RenewalLossReason.renewalFailed,
        ),
      ),
    );
    expect(lease.calls, 1);
  });

  test('identity, token, deadline, and late completion drift fail closed', () {
    final mutations = <LeaseGrant>[
      grant(holder: 'holder-b', leaseExpiresMs: 110000),
      grant(token: maxToken - BigInt.one, leaseExpiresMs: 110000),
      grant(leaseExpiresMs: null),
      grant(leaseExpiresMs: 100000),
    ];
    for (final renewed in mutations) {
      final supervisor = LeaseRenewalSupervisor(grant(), policy, 1000);
      expect(
        () => supervisor.acceptRenewal(5100, renewed),
        throwsA(isA<RenewalError>()),
      );
      expect(supervisor.isLive, isFalse);
    }
    final late = LeaseRenewalSupervisor(grant(), policy, 1000);
    expect(
      () => late.acceptRenewal(11000, grant(leaseExpiresMs: 110000)),
      throwsA(
        isA<RenewalError>().having(
          (error) => error.reason,
          'reason',
          RenewalLossReason.completionAfterDeadline,
        ),
      ),
    );
  });
}
