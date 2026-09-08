import 'dart:convert';
import 'dart:io';

import 'package:ores_locks_and_leases/ores_locks_and_leases.dart';
import 'package:test/test.dart';

Map<String, dynamic> _map(Object? value) =>
    (value as Map<Object?, Object?>).cast<String, dynamic>();

FencedWriteRequest _request(Map<String, dynamic> value) => FencedWriteRequest(
      tenantScope: value['tenantScope'] as String,
      resourceKey: LockKey(value['resourceKey'] as String),
      fencingToken: FencingTokenText.parse(value['fencingToken'] as String),
      operationId: value['operationId'] as String,
      payloadSha256: value['payloadSha256'] as String,
      holder: value.containsKey('holder') ? value['holder'] as String : null,
      leaseId: value.containsKey('leaseId') ? value['leaseId'] as String : null,
    );

FenceWatermark _watermark(Map<String, dynamic> value) =>
    FenceWatermark.fromRequest(_request(value));

void _expectFenceError(
  void Function() callback,
  String code,
  String name,
) {
  expect(
    callback,
    throwsA(
      isA<FenceValidationException>().having(
        (error) => error.code,
        'code',
        code,
      ),
    ),
    reason: name,
  );
}

void main() {
  final corpus = _map(jsonDecode(
    File(
      Platform.environment['ORES_FENCE_ADVERSARIAL_CORPUS'] ??
          '../../conformance/cases/fence-adversarial.json',
    ).readAsStringSync(),
  ));

  test('adversarial corpus has the pinned reproducible identity', () {
    expect(corpus['schema'], 'ores.locks.fence-adversarial/v1');
    expect(corpus['generator'], 'splitmix64-v1');
    expect(corpus['seed'], '0x4f5245534c4f434b');
  });

  for (final rawCase in corpus['tokenCases'] as List<dynamic>) {
    final fixture = _map(rawCase);
    final expected = _map(fixture['expected']);
    test('adversarial token: ${fixture['name']}', () {
      final value = fixture['value'] as String;
      if (expected['ok'] as bool) {
        expect(
          FencingTokenText.parse(value).value,
          expected['canonical'],
        );
        return;
      }
      _expectFenceError(
        () => FencingTokenText.parse(value),
        expected['error'] as String,
        fixture['name'] as String,
      );
    });
  }

  for (final rawCase in corpus['requestCases'] as List<dynamic>) {
    final fixture = _map(rawCase);
    final expected = _map(fixture['expected']);
    test('adversarial request: ${fixture['name']}', () {
      if (expected['ok'] as bool) {
        final request = _request(_map(fixture['incoming']));
        expect(request.fencingToken.value, fixture['incoming']['fencingToken']);
        return;
      }
      _expectFenceError(
        () => _request(_map(fixture['incoming'])),
        expected['error'] as String,
        fixture['name'] as String,
      );
    });
  }

  for (final rawCase in corpus['decisionCases'] as List<dynamic>) {
    final fixture = _map(rawCase);
    test('adversarial decision: ${fixture['name']}', () {
      final incoming = _request(_map(fixture['incoming']));
      final current = fixture['current'] == null
          ? null
          : _watermark(_map(fixture['current']));
      final expectedError = fixture['expectedError'] as String?;
      if (expectedError != null) {
        _expectFenceError(
          () => evaluateFence(current, incoming),
          expectedError,
          fixture['name'] as String,
        );
        return;
      }

      final expected = _map(fixture['expected']);
      final decision = evaluateFence(current, incoming);
      expect(decision.kind.wire, expected['kind']);
      expect(decision.shouldApply, expected['shouldApply']);
      expect(decision.incomingToken.value, expected['incomingToken']);
      expect(decision.currentToken.value, expected['currentToken']);
      expect(decision.previousToken?.value, expected['previousToken']);
    });
  }
}
