import 'dart:convert';

import 'fence.dart';
import 'key.dart';

/// Maximum UTF-8 bytes accepted by [decodeFencedWriteRequestJson].
const int maxFencedWriteJsonBytes = 4096;

const Set<String> _fencedWriteFields = {
  'tenantScope',
  'resourceKey',
  'fencingToken',
  'operationId',
  'payloadSha256',
  'holder',
  'leaseId',
};

/// Decode one untrusted JSON fencing request without numeric coercion.
///
/// Unknown fields, wrong runtime types, JSON `null` optionals, trailing values,
/// and overlarge bodies are rejected before a datastore call. Fencing tokens
/// must be canonical decimal JSON strings so the full Fiducia `uint64` range
/// remains exact on Flutter web as well as native Dart.
FencedWriteRequest decodeFencedWriteRequestJson(String source) {
  final bytes = utf8.encode(source).length;
  if (bytes == 0 || bytes > maxFencedWriteJsonBytes) {
    throw const FenceValidationException(
      'invalid_type',
      'fenced write request must be non-empty JSON within the size limit',
      field: 'request',
    );
  }

  _rejectDuplicateTopLevelKeys(source);

  final Object? decoded;
  try {
    decoded = jsonDecode(source);
  } on FormatException {
    throw const FenceValidationException(
      'invalid_type',
      'fenced write request must contain exactly one valid JSON value',
      field: 'request',
    );
  }
  return fencedWriteRequestFromJsonValue(decoded);
}

/// Validate an already-decoded, untrusted JSON value.
FencedWriteRequest fencedWriteRequestFromJsonValue(Object? value) {
  if (value is! Map) {
    throw const FenceValidationException(
      'invalid_type',
      'fenced write request must be a JSON object with string keys',
      field: 'request',
    );
  }

  final fields = <String, Object?>{};
  for (final entry in value.entries) {
    if (entry.key is! String) {
      throw const FenceValidationException(
        'invalid_type',
        'fenced write request must be a JSON object with string keys',
        field: 'request',
      );
    }
    fields[entry.key as String] = entry.value;
  }

  for (final field in fields.keys) {
    if (!_fencedWriteFields.contains(field)) {
      throw FenceValidationException(
        'unexpected_field',
        'fenced write request contains unknown field ${jsonEncode(field)}',
        field: field,
      );
    }
  }

  final tenantScope = _requiredString(fields, 'tenantScope', 'invalid_type');
  final resourceKeyText = _requiredString(fields, 'resourceKey', 'invalid_type');
  final fencingTokenText =
      _requiredString(fields, 'fencingToken', 'invalid_fencing_token');
  final operationId = _requiredString(fields, 'operationId', 'invalid_type');
  final payloadSha256 =
      _requiredString(fields, 'payloadSha256', 'invalid_payload_sha256');
  final holder = _optionalString(fields, 'holder');
  final leaseId = _optionalString(fields, 'leaseId');

  final resourceBytes = utf8.encode(resourceKeyText).length;
  if (resourceBytes > maxLockKeyBytes) {
    throw FenceValidationException(
      'too_long',
      'resourceKey is $resourceBytes bytes; maximum is $maxLockKeyBytes',
      field: 'resourceKey',
    );
  }

  return FencedWriteRequest(
    tenantScope: tenantScope,
    resourceKey: LockKey(resourceKeyText),
    fencingToken: FencingTokenText.parse(fencingTokenText),
    operationId: operationId,
    payloadSha256: payloadSha256,
    holder: holder,
    leaseId: leaseId,
  );
}

String _requiredString(
  Map<String, Object?> value,
  String field,
  String wrongTypeCode,
) {
  if (!value.containsKey(field) || value[field] is! String) {
    throw FenceValidationException(
      wrongTypeCode,
      '$field must be an own JSON string field',
      field: field,
    );
  }
  return value[field] as String;
}

String? _optionalString(Map<String, Object?> value, String field) {
  if (!value.containsKey(field)) return null;
  if (value[field] is! String) {
    throw FenceValidationException(
      'invalid_type',
      '$field must be an own JSON string field when present',
      field: field,
    );
  }
  return value[field] as String;
}

void _rejectDuplicateTopLevelKeys(String source) {
  var index = _skipWhitespace(source, 0);
  if (index >= source.length || source.codeUnitAt(index) != 0x7b) return;
  index += 1;
  final keys = <String>{};

  while (index < source.length) {
    index = _skipWhitespace(source, index);
    if (index >= source.length || source.codeUnitAt(index) == 0x7d) return;
    if (source.codeUnitAt(index) != 0x22) return;

    final keyStart = index;
    index = _skipJsonString(source, index);
    if (index <= keyStart || index > source.length) return;
    final String key;
    try {
      key = jsonDecode(source.substring(keyStart, index)) as String;
    } on Object {
      return;
    }
    if (!keys.add(key)) {
      throw FenceValidationException(
        'unexpected_field',
        'fenced write request contains duplicate field ${jsonEncode(key)}',
        field: key,
      );
    }

    index = _skipWhitespace(source, index);
    if (index >= source.length || source.codeUnitAt(index) != 0x3a) return;
    index = _skipJsonValue(source, index + 1);
    index = _skipWhitespace(source, index);
    if (index >= source.length || source.codeUnitAt(index) == 0x7d) return;
    if (source.codeUnitAt(index) != 0x2c) return;
    index += 1;
  }
}

int _skipWhitespace(String source, int index) {
  while (index < source.length) {
    final unit = source.codeUnitAt(index);
    if (unit != 0x20 && unit != 0x09 && unit != 0x0a && unit != 0x0d) break;
    index += 1;
  }
  return index;
}

int _skipJsonString(String source, int index) {
  if (index >= source.length || source.codeUnitAt(index) != 0x22) return index;
  index += 1;
  while (index < source.length) {
    final unit = source.codeUnitAt(index);
    if (unit == 0x5c) {
      index += 2;
      continue;
    }
    index += 1;
    if (unit == 0x22) return index;
  }
  return index;
}

int _skipJsonValue(String source, int index) {
  index = _skipWhitespace(source, index);
  var objectDepth = 0;
  var arrayDepth = 0;
  while (index < source.length) {
    final unit = source.codeUnitAt(index);
    if (unit == 0x22) {
      index = _skipJsonString(source, index);
      continue;
    }
    if (unit == 0x7b) objectDepth += 1;
    if (unit == 0x5b) arrayDepth += 1;
    if (unit == 0x7d) {
      if (objectDepth == 0 && arrayDepth == 0) return index;
      objectDepth -= 1;
    }
    if (unit == 0x5d) arrayDepth -= 1;
    if (unit == 0x2c && objectDepth == 0 && arrayDepth == 0) return index;
    index += 1;
  }
  return index;
}
