import 'package:ores_locks_and_leases/ores_locks_and_leases.dart';
import 'package:test/test.dart';

LeaseGrant grant({
  String key = 'tests/maintained',
  String holder = 'holder-a',
  int token = 41,
  int ttlMs = 60000,
  int? leaseExpiresMs,
}) =>
    LeaseGrant(
      key: LockKey(key),
      holder: holder,
      fencingToken: BigInt.from(token),
      leaseExpiresMs: leaseExpiresMs,
      ttlMs: ttlMs,
    );

void main() {
  test('fiducia.renew is observable without changing the legacy plan', () {
    expect(LockStep.parse('fiducia.renew'), LockStep.fiduciaRenew);
    expect(
      plan(LockLayers.both, PgScope.transaction, true)
          .steps
          .contains(LockStep.fiduciaRenew),
      isFalse,
    );
  });

  test('maintenance timing rejects unsafe intervals before acquisition', () {
    final key = LockKey('tests/options');
    const acquire = AcquireOptions(ttl: Duration(milliseconds: 100));

    expect(
      () => validateLeaseMaintenanceOptions(
        key,
        acquire,
        const LeaseMaintenanceOptions(
          renewInterval: Duration(milliseconds: 51),
        ),
        wait: true,
      ),
      throwsA(
        isA<LockError>().having(
          (error) => error.kind,
          'kind',
          LockErrorKind.invalidPlan,
        ),
      ),
    );
    expect(
      () => validateLeaseMaintenanceOptions(
        key,
        acquire,
        const LeaseMaintenanceOptions(
          renewInterval: Duration(milliseconds: 50),
        ),
        wait: true,
      ),
      returnsNormally,
    );
  });

  test('acquired grant must preserve requested holder TTL and valid expiry',
      () {
    final key = LockKey('tests/maintained');
    const acquire = AcquireOptions(
      ttl: Duration(milliseconds: 60000),
      holder: 'holder-a',
    );
    expect(
      () => validateAcquiredLeaseGrant(key, acquire, grant(), wait: true),
      returnsNormally,
    );

    for (final changed in [
      grant(holder: 'holder-b'),
      grant(ttlMs: 59999),
      grant(leaseExpiresMs: 0),
    ]) {
      expect(
        () => validateAcquiredLeaseGrant(
          key,
          acquire,
          changed,
          wait: false,
        ),
        throwsA(
          isA<LockError>()
              .having(
                (error) => error.kind,
                'kind',
                LockErrorKind.lostLease,
              )
              .having(
                (error) => error.step,
                'step',
                LockStep.fiduciaTryAcquire,
              ),
        ),
      );
    }
  });

  test('renewal must preserve key holder fencing token TTL and valid expiry',
      () {
    final original = grant();
    expect(
      () => validateRenewedLeaseGrant(original, grant()),
      returnsNormally,
    );

    for (final changed in [
      grant(key: 'tests/other'),
      grant(holder: 'holder-b'),
      grant(token: 42),
      grant(ttlMs: 59999),
      grant(leaseExpiresMs: 0),
    ]) {
      expect(
        () => validateRenewedLeaseGrant(original, changed),
        throwsA(
          isA<LockError>()
              .having(
                (error) => error.kind,
                'kind',
                LockErrorKind.lostLease,
              )
              .having(
                (error) => error.step,
                'step',
                LockStep.fiduciaRenew,
              ),
        ),
      );
    }
  });
}
