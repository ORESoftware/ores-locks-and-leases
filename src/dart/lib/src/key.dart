import 'dart:convert';

/// The longest key the contract admits, in UTF-8 bytes.
const int maxLockKeyBytes = 512;

/// A caller-chosen lock identity. Convention: `<org>/<domain>/<name>`, e.g.
/// `zed-pkg/registry/publish:zed-lib-core`.
final class LockKey {
  final String value;

  LockKey._(this.value);

  /// Validate the contract's length bound.
  factory LockKey(String key) {
    final bytes = utf8.encode(key).length;
    if (bytes > maxLockKeyBytes) {
      throw ArgumentError.value(key, 'key', 'lock key is $bytes bytes; the contract allows at most $maxLockKeyBytes');
    }
    return LockKey._(key);
  }

  /// The Postgres `bigint` this key locks. See [advisoryKey].
  BigInt get advisory => advisoryKey(value);

  @override
  String toString() => value;

  @override
  bool operator ==(Object other) => other is LockKey && other.value == value;

  @override
  int get hashCode => value.hashCode;
}

final BigInt _fnvOffsetBasis = BigInt.parse('14695981039346656037');
final BigInt _fnvPrime = BigInt.from(1099511628211);
final BigInt _mask64 = (BigInt.one << 64) - BigInt.one;

/// FNV-1a, 64-bit, over the UTF-8 bytes of [key], as an unsigned value.
///
/// `BigInt` rather than `int` so the result is identical on the VM (64-bit
/// wrapping ints) and on the web (53-bit doubles).
BigInt fnv1a64(String key) {
  var hash = _fnvOffsetBasis;
  for (final byte in utf8.encode(key)) {
    hash ^= BigInt.from(byte);
    hash = (hash * _fnvPrime) & _mask64;
  }
  return hash;
}

/// The `bigint` every runtime locks for [key]: FNV-1a 64 reinterpreted as a
/// two's-complement signed integer. Vectors: `conformance/cases/advisory-key.json`.
BigInt advisoryKey(String key) => fnv1a64(key).toSigned(64);
