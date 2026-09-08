import 'package:ores_locks_and_leases/ores_locks_and_leases.dart';
import 'package:test/test.dart';

LeaseGrant grant({
  String key = 'tests/maintained',
  String holder = 'holder-a',
  int token = 41,
}) =>
    LeaseGrant(
      key: LockKey(key),
      holder: holder,
      fencingToken: BigInt.from(token),
      ttlMs: 60000,
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

  test('renewal must preserve key holder and fencing token', () {
    final original = grant();
    expect(
      () => validateRenewedLeaseGrant(original, grant()),
      returnsNormally,
    );

    for (final changed in [
      grant(key: 'tests/other'),
      grant(holder: 'holder-b'),
      grant(token: 42),
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
