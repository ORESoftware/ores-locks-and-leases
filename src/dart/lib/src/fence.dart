import 'dart:convert';

import 'key.dart';

/// Largest canonical unsigned-64 fencing token.
const String maxFencingTokenText = '18446744073709551615';
const int maxTenantScopeBytes = 256;
const int maxOperationIdBytes = 128;
const int maxFenceMetadataBytes = 256;

final BigInt _maxFencingToken = BigInt.parse(maxFencingTokenText);
final RegExp _canonicalToken = RegExp(r'^(0|[1-9][0-9]{0,19})$');
final RegExp _lowerSha256 = RegExp(r'^[0-9a-f]{64}$');

/// Lossless JSON/Redis/SQL representation of a Fiducia `uint64` token.
final class FencingTokenText implements Comparable<FencingTokenText> {
  final String value;
  final BigInt numeric;

  FencingTokenText._(this.value, this.numeric);

  /// Parse canonical decimal text without ever passing through a Dart `num`.
  factory FencingTokenText.parse(String value) {
    if (!_canonicalToken.hasMatch(value)) {
      throw FenceValidationException(
        'invalid_fencing_token',
        'fencing token ${jsonEncode(value)} is not canonical unsigned-64 decimal text',
        field: 'fencingToken',
      );
    }
    final numeric = BigInt.parse(value);
    if (numeric > _maxFencingToken || numeric.toString() != value) {
      throw FenceValidationException(
        'invalid_fencing_token',
        'fencing token ${jsonEncode(value)} is outside the unsigned-64 range',
        field: 'fencingToken',
      );
    }
    return FencingTokenText._(value, numeric);
  }

  factory FencingTokenText.fromBigInt(BigInt value) {
    if (value.isNegative || value > _maxFencingToken) {
      throw FenceValidationException(
        'invalid_fencing_token',
        'fencing token $value is outside the unsigned-64 range',
        field: 'fencingToken',
      );
    }
    return FencingTokenText._(value.toString(), value);
  }

  @override
  int compareTo(FencingTokenText other) => numeric.compareTo(other.numeric);

  @override
  String toString() => value;

  @override
  bool operator ==(Object other) =>
      other is FencingTokenText && other.value == value;

  @override
  int get hashCode => value.hashCode;
}

/// Stable decision vocabulary shared by SQL, Redis, and every runtime.
enum FenceDecisionKind {
  advanced,
  replay,
  stale,
  tokenReuse;

  String get wire => switch (this) {
        FenceDecisionKind.advanced => 'advanced',
        FenceDecisionKind.replay => 'replay',
        FenceDecisionKind.stale => 'stale',
        FenceDecisionKind.tokenReuse => 'token_reuse',
      };
}

/// One application mutation guarded by a Fiducia token.
final class FencedWriteRequest {
  final String tenantScope;
  final LockKey resourceKey;
  final FencingTokenText fencingToken;
  final String operationId;
  final String payloadSha256;
  final String? holder;
  final String? leaseId;

  FencedWriteRequest._({
    required this.tenantScope,
    required this.resourceKey,
    required this.fencingToken,
    required this.operationId,
    required this.payloadSha256,
    this.holder,
    this.leaseId,
  });

  factory FencedWriteRequest({
    required String tenantScope,
    required LockKey resourceKey,
    required FencingTokenText fencingToken,
    required String operationId,
    required String payloadSha256,
    String? holder,
    String? leaseId,
  }) {
    _validateField('tenantScope', tenantScope, maxTenantScopeBytes);
    _validateField('resourceKey', resourceKey.value, maxLockKeyBytes);
    _validateField('operationId', operationId, maxOperationIdBytes);
    _validateOptionalField('holder', holder, maxFenceMetadataBytes);
    _validateOptionalField('leaseId', leaseId, maxFenceMetadataBytes);
    if (!_lowerSha256.hasMatch(payloadSha256)) {
      throw const FenceValidationException(
        'invalid_payload_sha256',
        'payloadSha256 must be exactly 64 lowercase hexadecimal characters',
        field: 'payloadSha256',
      );
    }

    return FencedWriteRequest._(
      tenantScope: tenantScope,
      resourceKey: resourceKey,
      fencingToken: fencingToken,
      operationId: operationId,
      payloadSha256: payloadSha256,
      holder: holder,
      leaseId: leaseId,
    );
  }
}

/// Last accepted write for one `(tenantScope, resourceKey)` identity.
final class FenceWatermark {
  final String tenantScope;
  final LockKey resourceKey;
  final FencingTokenText fencingToken;
  final String operationId;
  final String payloadSha256;
  final String? holder;
  final String? leaseId;

  FenceWatermark._({
    required this.tenantScope,
    required this.resourceKey,
    required this.fencingToken,
    required this.operationId,
    required this.payloadSha256,
    this.holder,
    this.leaseId,
  });

  factory FenceWatermark({
    required String tenantScope,
    required LockKey resourceKey,
    required FencingTokenText fencingToken,
    required String operationId,
    required String payloadSha256,
    String? holder,
    String? leaseId,
  }) {
    final request = FencedWriteRequest(
      tenantScope: tenantScope,
      resourceKey: resourceKey,
      fencingToken: fencingToken,
      operationId: operationId,
      payloadSha256: payloadSha256,
      holder: holder,
      leaseId: leaseId,
    );
    return FenceWatermark.fromRequest(request);
  }

  factory FenceWatermark.fromRequest(FencedWriteRequest request) =>
      FenceWatermark._(
        tenantScope: request.tenantScope,
        resourceKey: request.resourceKey,
        fencingToken: request.fencingToken,
        operationId: request.operationId,
        payloadSha256: request.payloadSha256,
        holder: request.holder,
        leaseId: request.leaseId,
      );
}

/// Pure decision data. [shouldApply] is true only for `advanced`.
final class FenceDecision {
  final FenceDecisionKind kind;
  final bool shouldApply;
  final FencingTokenText incomingToken;
  final FencingTokenText currentToken;
  final FencingTokenText? previousToken;

  const FenceDecision({
    required this.kind,
    required this.shouldApply,
    required this.incomingToken,
    required this.currentToken,
    this.previousToken,
  });
}

/// Compare an incoming request with an optional current watermark.
///
/// The datastore adapter must persist an `advanced` watermark and perform the
/// protected mutation in the same transaction or Redis script.
FenceDecision evaluateFence(
  FenceWatermark? current,
  FencedWriteRequest incoming,
) {
  if (current == null) {
    return FenceDecision(
      kind: FenceDecisionKind.advanced,
      shouldApply: true,
      incomingToken: incoming.fencingToken,
      currentToken: incoming.fencingToken,
    );
  }

  if (current.tenantScope != incoming.tenantScope ||
      current.resourceKey != incoming.resourceKey) {
    throw const FenceValidationException(
      'identity_mismatch',
      'current watermark and incoming request identify different resources',
    );
  }

  final comparison = incoming.fencingToken.compareTo(current.fencingToken);
  if (comparison > 0) {
    return FenceDecision(
      kind: FenceDecisionKind.advanced,
      shouldApply: true,
      incomingToken: incoming.fencingToken,
      currentToken: incoming.fencingToken,
      previousToken: current.fencingToken,
    );
  }
  if (comparison < 0) {
    return FenceDecision(
      kind: FenceDecisionKind.stale,
      shouldApply: false,
      incomingToken: incoming.fencingToken,
      currentToken: current.fencingToken,
      previousToken: current.fencingToken,
    );
  }

  final sameOperation = current.operationId == incoming.operationId &&
      current.payloadSha256 == incoming.payloadSha256;
  return FenceDecision(
    kind:
        sameOperation ? FenceDecisionKind.replay : FenceDecisionKind.tokenReuse,
    shouldApply: false,
    incomingToken: incoming.fencingToken,
    currentToken: current.fencingToken,
    previousToken: current.fencingToken,
  );
}

/// Validation error emitted before a datastore call is attempted.
final class FenceValidationException implements Exception {
  final String code;
  final String message;
  final String? field;

  const FenceValidationException(this.code, this.message, {this.field});

  @override
  String toString() => 'FenceValidationException($code): $message';
}

void _validateField(String field, String value, int maxBytes) {
  if (value.isEmpty) {
    throw FenceValidationException(
      'empty_field',
      '$field must not be empty',
      field: field,
    );
  }
  final bytes = utf8.encode(value).length;
  if (bytes > maxBytes) {
    throw FenceValidationException(
      'too_long',
      '$field is $bytes bytes; maximum is $maxBytes',
      field: field,
    );
  }
}

void _validateOptionalField(String field, String? value, int maxBytes) {
  if (value != null) _validateField(field, value, maxBytes);
}
