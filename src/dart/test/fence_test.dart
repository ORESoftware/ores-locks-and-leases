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
  holder: value['holder'] as String?,
  leaseId: value['leaseId'] as String?,
);

FenceWatermark _watermark(Map<String, dynamic> value) =>
    FenceWatermark.fromRequest(_request(value));

void main() {
  final corpus = _map(
    jsonDecode(
      File('../../conformance/cases/fence-decision.json').readAsStringSync(),
    ),
  );

  for (final rawCase in corpus['cases'] as List<dynamic>) {
    final fixture = _map(rawCase);
    test('fence conformance: ${fixture['name']}', () {
      final incoming = _request(_map(fixture['incoming']));
      final current = fixture['current'] == null
          ? null
          : _watermark(_map(fixture['current']));

      final expectedError = fixture['expectedError'] as String?;
      if (expectedError != null) {
        expect(
          () => evaluateFence(current, incoming),
          throwsA(
            isA<FenceValidationException>().having(
              (error) => error.code,
              'code',
              expectedError,
            ),
          ),
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

  test('invalid fencing-token text fails closed', () {
    for (final value in corpus['invalidTokens'] as List<dynamic>) {
      expect(
        () => FencingTokenText.parse(value as String),
        throwsA(
          isA<FenceValidationException>().having(
            (error) => error.code,
            'code',
            'invalid_fencing_token',
          ),
        ),
        reason: '$value',
      );
    }
  });

  test('full unsigned-64 maximum remains exact', () {
    final token = FencingTokenText.fromBigInt(
      BigInt.parse(maxFencingTokenText),
    );
    expect(token.value, maxFencingTokenText);
    expect(token.numeric, (BigInt.one << 64) - BigInt.one);
  });
}
