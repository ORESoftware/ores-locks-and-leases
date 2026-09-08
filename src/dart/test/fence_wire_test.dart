import 'dart:convert';
import 'dart:io';

import 'package:ores_locks_and_leases/ores_locks_and_leases.dart';
import 'package:test/test.dart';

String _repeat(String value, int count) => List.filled(count, value).join();

Map<String, Object?> _valid([Map<String, Object?> overrides = const {}]) => {
      'tenantScope': 'tenant/acme',
      'resourceKey': 'example/jobs/rebuild',
      'fencingToken': maxFencingTokenText,
      'operationId': 'operation-0001',
      'payloadSha256': _repeat('a', 64),
      'holder': 'worker-a',
      'leaseId': 'lease-a',
      ...overrides,
    };

Map<String, dynamic> _map(Object? value) =>
    (value as Map<Object?, Object?>).cast<String, dynamic>();

Matcher _code(String code) =>
    isA<FenceValidationException>().having((error) => error.code, 'code', code);

void main() {
  final corpus = _map(
    jsonDecode(
      File('../../conformance/cases/fence-decision.json').readAsStringSync(),
    ),
  );

  test('wire decoder preserves the complete uint64 fencing token', () {
    final request = decodeFencedWriteRequestJson(jsonEncode(_valid()));
    expect(request.fencingToken.value, maxFencingTokenText);
    expect(request.fencingToken.numeric, (BigInt.one << 64) - BigInt.one);
  });

  test('wire decoder consumes generated wrong-runtime-type adversaries', () {
    for (final rawCase
        in (corpus['wrongTypeCases'] as List<dynamic>? ?? const [])) {
      final fixture = _map(rawCase);
      final field = fixture['field'] as String;
      final code = fixture['expectedError'] as String;
      expect(
        () => fencedWriteRequestFromJsonValue(
          _valid({field: fixture['value']}),
        ),
        throwsA(_code(code)),
        reason: field,
      );
    }
  });

  test('wire decoder rejects non-objects, unknown fields, and trailing JSON',
      () {
    for (final value in <Object?>[null, false, 7, 'request', <Object?>[]]) {
      expect(
        () => fencedWriteRequestFromJsonValue(value),
        throwsA(_code('invalid_type')),
      );
    }
    expect(
      () => fencedWriteRequestFromJsonValue(
        _valid({'authority': 'forged'}),
      ),
      throwsA(_code('unexpected_field')),
    );
    expect(
      () => decodeFencedWriteRequestJson('${jsonEncode(_valid())} {}'),
      throwsA(_code('invalid_type')),
    );
    expect(
      () => decodeFencedWriteRequestJson(
        '{"tenantScope":"tenant/acme","tenantScope":"tenant/other",'
        '"resourceKey":"example/jobs/rebuild","fencingToken":"1",'
        '"operationId":"operation-0001",'
        '"payloadSha256":"${_repeat('a', 64)}"}',
      ),
      throwsA(_code('unexpected_field')),
    );
  });

  test('wire decoder consumes generated UTF-8 and empty-field adversaries', () {
    final accepted = _valid({
      'tenantScope': _repeat('é', 128),
      'resourceKey': _repeat('é', 256),
      'operationId': _repeat('é', 64),
      'holder': _repeat('é', 128),
      'leaseId': _repeat('é', 128),
      'fencingToken': '1',
    });
    expect(
      () => fencedWriteRequestFromJsonValue(accepted),
      returnsNormally,
    );

    for (final rawCase
        in (corpus['invalidFields'] as List<dynamic>? ?? const [])) {
      final fixture = _map(rawCase);
      final field = fixture['field'] as String;
      final code = fixture['expectedError'] as String;
      expect(
        () => fencedWriteRequestFromJsonValue(
          _valid({field: fixture['value']}),
        ),
        throwsA(_code(code)),
        reason: fixture['name'] as String,
      );
    }
  });

  test('wire decoder bounds the body before JSON decoding', () {
    expect(
      () => decodeFencedWriteRequestJson(
        _repeat(' ', maxFencedWriteJsonBytes + 1),
      ),
      throwsA(_code('invalid_type')),
    );
  });
}
