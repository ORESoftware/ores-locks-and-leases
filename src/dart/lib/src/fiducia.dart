import 'dart:convert';
import 'dart:math';

import 'package:http/http.dart' as http;

import 'errors.dart';
import 'key.dart';
import 'lease.dart';
import 'plan.dart';

/// [Lease] over the fiducia-cloud lock HTTP protocol with `package:http`.
///
/// This keeps the small local [Lease] abstraction while matching the current
/// fiducia-clients wire contract: one request identity per logical acquisition,
/// explicit wait budget, `keys[]` renewal, and token-scoped release.
/// Hosted traffic should use the public edge/load-balancer endpoint; the
/// internal constructor is only for a trusted in-cluster hop.
final class FiduciaLease implements Lease {
  static final BigInt _maxSafeJsonInteger = BigInt.from(9007199254740991);
  static const int _maxErrorBodyChars = 8192;

  final Uri _base;
  final Map<String, String> _headers;
  final http.Client _client;
  final String? _refusal;
  final String Function() _generateHolder;

  FiduciaLease._(
    this._base,
    this._headers,
    this._client,
    this._refusal,
    this._generateHolder,
  );

  /// The trusted internal hop straight to a fiducia-node.
  factory FiduciaLease.internal(
    String baseUrl, {
    required String secret,
    required String orgId,
    http.Client? client,
    bool allowCleartextInternal = false,
    String Function()? generateHolder,
  }) {
    return FiduciaLease._(
      _parseBase(baseUrl),
      {
        'content-type': 'application/json',
        'x-fiducia-internal-auth': secret,
        'x-fiducia-org-id': orgId,
      },
      client ?? http.Client(),
      cleartextRefusal(
        baseUrl,
        hasCredential: true,
        allow: allowCleartextInternal,
      ),
      generateHolder ?? generatedHolder,
    );
  }

  /// A public edge or load-balancer endpoint authenticated with an API key.
  factory FiduciaLease.bearer(
    String baseUrl, {
    required String apiKey,
    http.Client? client,
    bool allowCleartextInternal = false,
    String Function()? generateHolder,
  }) {
    return FiduciaLease._(
      _parseBase(baseUrl),
      {'content-type': 'application/json', 'authorization': 'Bearer $apiKey'},
      client ?? http.Client(),
      cleartextRefusal(
        baseUrl,
        hasCredential: true,
        allow: allowCleartextInternal,
      ),
      generateHolder ?? generatedHolder,
    );
  }

  static Uri _parseBase(String baseUrl) =>
      Uri.parse(baseUrl.replaceAll(RegExp(r'/+$'), ''));

  /// Why a credential must not be sent to [baseUrl], or null when it may be.
  static String? cleartextRefusal(
    String baseUrl, {
    required bool hasCredential,
    required bool allow,
  }) {
    if (!hasCredential || allow || !baseUrl.startsWith('http://')) return null;
    final host = Uri.parse(baseUrl).host;
    const localSuffixes = ['.svc', '.cluster.local', '.internal', '.local'];
    if (host == 'localhost' ||
        host == '127.0.0.1' ||
        host == '::1' ||
        localSuffixes.any(host.endsWith)) {
      return null;
    }
    return 'fiducia: refusing to send a credential over cleartext http to "$host"; use https or allowCleartextInternal';
  }

  static String _randomIdentity(String prefix) {
    final random = Random.secure();
    final bytes = List<int>.generate(16, (_) => random.nextInt(256));
    return '$prefix${bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join()}';
  }

  /// An unguessable holder identity; holder names carry ownership authority.
  static String generatedHolder() => _randomIdentity('ores-locks-');

  /// Per-acquisition identity, intentionally distinct from holder identity.
  static String _generatedRequestId() =>
      _randomIdentity('ores-lock-request-');

  Future<Map<String, Object?>> _post(
    String path,
    Map<String, Object?> body,
  ) async {
    if (_refusal != null) throw StateError(_refusal);
    final wireBody = body.map((key, value) {
      if (value is! BigInt) return MapEntry(key, value);
      if (value.isNegative || value > _maxSafeJsonInteger) {
        throw RangeError(
          'fiducia: fencing token $value cannot be represented exactly by the current numeric JSON wire format',
        );
      }
      return MapEntry(key, value.toInt());
    });
    final response = await _client.post(
      _base.replace(path: '${_base.path}$path'),
      headers: _headers,
      body: jsonEncode(wireBody),
    );
    if (response.statusCode >= 300) {
      final trimmed = response.body.trim();
      final bounded = trimmed.substring(0, min(trimmed.length, _maxErrorBodyChars));
      throw http.ClientException(
        'fiducia: HTTP ${response.statusCode}: $bounded',
      );
    }
    if (response.body.isEmpty) return const {};
    final parsed = jsonDecode(response.body);
    final result = parsed is Map ? parsed['result'] : null;
    final output = result is Map ? result['output'] : null;
    return output is Map ? output.cast<String, Object?>() : const {};
  }

  static BigInt? _uint(Object? value) {
    // Flutter web's JSON decoder rounds numeric literals above 2^53-1.
    // Apply the same bound on every Dart target so native and web callers
    // fail closed identically. Decimal strings remain lossless for a future
    // Fiducia wire revision.
    if (value is int && value >= 0 && value <= 9007199254740991) {
      return BigInt.from(value);
    }
    if (value is String && RegExp(r'^\d+$').hasMatch(value)) {
      return BigInt.parse(value);
    }
    return null;
  }

  @override
  Future<LeaseGrant> acquire(
    LockKey key,
    AcquireOptions opts, {
    required bool wait,
  }) async {
    final holder = opts.holder ?? _generateHolder();
    final requestId = _generatedRequestId();
    final started = DateTime.now();
    var attempt = 0;
    for (;;) {
      final Map<String, Object?> out;
      try {
        out = await _post('/v1/locks/acquire', {
          'key': key.value,
          'holder': holder,
          'ttl_ms': opts.ttl.inMilliseconds,
          'wait': wait,
          if (wait) 'wait_timeout_ms': opts.waitTimeout.inMilliseconds,
          'request_id': requestId,
        });
      } catch (cause) {
        // A transport failure leaves ownership unknown. Never turn it into
        // contention or continue guarded work.
        throw LockError.transport(key, cause);
      }
      if (out['acquired'] == true) {
        final token = _uint(out['fencing_token']);
        if (token == null || token == BigInt.zero) {
          throw LockError.transport(
            key,
            'fiducia: acquired without a positive fencing token',
          );
        }
        var grant = LeaseGrant(
          key: key,
          holder: holder,
          fencingToken: token,
          leaseExpiresMs: _uint(out['lease_expires_ms'])?.toInt(),
          ttlMs: opts.ttl.inMilliseconds,
        );
        // A retry-discovered grant may have aged before this response. Prove
        // current fenced authority before exposing it to application work.
        if (attempt > 0 || out['renewed'] == false) {
          grant = await renew(grant, opts.ttl);
        }
        return grant;
      }
      if (!wait) throw LockError.contention(key, LockStep.fiduciaTryAcquire);
      final waited = DateTime.now().difference(started);
      if (waited + opts.retryInterval > opts.waitTimeout) {
        throw LockError.timeout(
          key,
          LockStep.fiduciaAcquire,
          waited.inMilliseconds,
        );
      }
      attempt += 1;
      await Future<void>.delayed(opts.retryInterval);
    }
  }

  @override
  Future<LeaseGrant> renew(LeaseGrant grant, Duration ttl) async {
    final Map<String, Object?> out;
    try {
      out = await _post('/v1/locks/renew', {
        'keys': [grant.key.value],
        'holder': grant.holder,
        'fencing_token': grant.fencingToken,
        'ttl_ms': ttl.inMilliseconds,
      });
    } catch (cause) {
      throw LockError.transport(grant.key, cause);
    }
    if (out['renewed'] != true) {
      throw LockError(
        LockErrorKind.lostLease,
        grant.key,
        'fiducia: lock renewal lost fenced authority',
      );
    }
    return grant.copyWith(
      ttlMs: ttl.inMilliseconds,
      leaseExpiresMs: _uint(out['lease_expires_ms'])?.toInt(),
    );
  }

  @override
  Future<bool> release(LeaseGrant grant) async {
    try {
      final out = await _post('/v1/locks/release', {
        'holder': grant.holder,
        'fencing_token': grant.fencingToken,
      });
      return out['released'] == true;
    } catch (cause) {
      throw LockError.transport(
        grant.key,
        cause,
        step: LockStep.fiduciaRelease,
      );
    }
  }
}
