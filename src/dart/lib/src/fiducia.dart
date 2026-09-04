import 'dart:convert';
import 'dart:math';

import 'package:http/http.dart' as http;

import 'errors.dart';
import 'key.dart';
import 'lease.dart';
import 'plan.dart';

/// [Lease] over the fiducia-cloud node HTTP protocol with `package:http`. It
/// speaks the same three endpoints the official clients do
/// (`/v1/locks/acquire`, `/v1/locks/renew`, `/v1/locks/release`) with the
/// same headers.
///
/// The node never holds a request open: `acquire` returns at once with
/// `acquired: false` when the key is held, so the client owns the wait. This
/// adapter polls at `opts.retryInterval` until the grant arrives or
/// `opts.waitTimeout` elapses.
final class FiduciaLease implements Lease {
  final Uri _base;
  final Map<String, String> _headers;
  final http.Client _client;
  final String? _refusal;
  final String Function() _generateHolder;

  FiduciaLease._(this._base, this._headers, this._client, this._refusal, this._generateHolder);

  /// The trusted internal hop straight to a fiducia-node.
  factory FiduciaLease.internal(String baseUrl, {required String secret, required String orgId, http.Client? client, bool allowCleartextInternal = false, String Function()? generateHolder}) {
    return FiduciaLease._(
      _base(baseUrl),
      {'content-type': 'application/json', 'x-fiducia-internal-auth': secret, 'x-fiducia-org-id': orgId},
      client ?? http.Client(),
      cleartextRefusal(baseUrl, hasCredential: true, allow: allowCleartextInternal),
      generateHolder ?? generatedHolder,
    );
  }

  /// A public edge or load-balancer endpoint authenticated with an API key.
  factory FiduciaLease.bearer(String baseUrl, {required String apiKey, http.Client? client, bool allowCleartextInternal = false, String Function()? generateHolder}) {
    return FiduciaLease._(
      _base(baseUrl),
      {'content-type': 'application/json', 'authorization': 'Bearer $apiKey'},
      client ?? http.Client(),
      cleartextRefusal(baseUrl, hasCredential: true, allow: allowCleartextInternal),
      generateHolder ?? generatedHolder,
    );
  }

  static Uri _base(String baseUrl) => Uri.parse(baseUrl.replaceAll(RegExp(r'/+$'), ''));

  /// Why a credential must not be sent to [baseUrl], or null when it may be.
  static String? cleartextRefusal(String baseUrl, {required bool hasCredential, required bool allow}) {
    if (!hasCredential || allow || !baseUrl.startsWith('http://')) return null;
    final host = Uri.parse(baseUrl).host;
    const localSuffixes = ['.svc', '.cluster.local', '.internal', '.local'];
    if (host == 'localhost' || host == '127.0.0.1' || host == '::1' || localSuffixes.any(host.endsWith)) return null;
    return 'fiducia: refusing to send a credential over cleartext http to "$host"; use https or allowCleartextInternal';
  }

  /// An unguessable holder identity; holder names carry queue identity and
  /// cancellation authority.
  static String generatedHolder() {
    final random = Random.secure();
    final bytes = List<int>.generate(16, (_) => random.nextInt(256));
    return 'ores-locks-${bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join()}';
  }

  Future<Map<String, Object?>> _post(String path, Map<String, Object?> body) async {
    if (_refusal != null) throw StateError(_refusal);
    final response = await _client.post(
      _base.replace(path: '${_base.path}$path'),
      headers: _headers,
      body: jsonEncode(body, toEncodable: (v) => v is BigInt ? v.toInt() : v),
    );
    if (response.statusCode >= 300) throw http.ClientException('fiducia: HTTP ${response.statusCode}: ${response.body.trim()}');
    if (response.body.isEmpty) return const {};
    final parsed = jsonDecode(response.body);
    final output = parsed is Map ? (parsed['result'] as Map?)?['output'] : null;
    return output is Map ? output.cast<String, Object?>() : const {};
  }

  static BigInt? _uint(Object? value) {
    if (value is int && value >= 0) return BigInt.from(value);
    if (value is String && RegExp(r'^\d+$').hasMatch(value)) return BigInt.parse(value);
    return null;
  }

  @override
  Future<LeaseGrant> acquire(LockKey key, AcquireOptions opts, {required bool wait}) async {
    final holder = opts.holder ?? _generateHolder();
    final started = DateTime.now();
    for (;;) {
      final Map<String, Object?> out;
      try {
        out = await _post('/v1/locks/acquire', {'key': key.value, 'holder': holder, 'ttl_ms': opts.ttl.inMilliseconds});
      } catch (cause) {
        throw LockError.transport(key, cause);
      }
      if (out['acquired'] == true) {
        final token = _uint(out['fencing_token']);
        if (token == null) throw LockError.transport(key, 'fiducia: acquired without a fencing token');
        return LeaseGrant(key: key, holder: holder, fencingToken: token, leaseExpiresMs: _uint(out['lease_expires_ms'])?.toInt(), ttlMs: opts.ttl.inMilliseconds);
      }
      if (!wait) throw LockError.contention(key, LockStep.fiduciaTryAcquire);
      final waited = DateTime.now().difference(started);
      if (waited + opts.retryInterval > opts.waitTimeout) throw LockError.timeout(key, LockStep.fiduciaAcquire, waited.inMilliseconds);
      await Future<void>.delayed(opts.retryInterval);
    }
  }

  @override
  Future<LeaseGrant> renew(LeaseGrant grant, Duration ttl) async {
    final Map<String, Object?> out;
    try {
      out = await _post('/v1/locks/renew', {'key': grant.key.value, 'holder': grant.holder, 'fencing_token': grant.fencingToken, 'ttl_ms': ttl.inMilliseconds});
    } catch (cause) {
      throw LockError.transport(grant.key, cause);
    }
    // `renewed: false` is lost fenced authority: fiducia has already reaped
    // the grant and may have promoted another holder.
    if (out['renewed'] != true) throw LockError(LockErrorKind.lostLease, grant.key, 'fiducia: lock renewal lost fenced authority');
    return grant.copyWith(ttlMs: ttl.inMilliseconds, leaseExpiresMs: _uint(out['lease_expires_ms'])?.toInt());
  }

  @override
  Future<bool> release(LeaseGrant grant) async {
    try {
      final out = await _post('/v1/locks/release', {'key': grant.key.value, 'holder': grant.holder, 'fencing_token': grant.fencingToken});
      return out['released'] == true;
    } catch (cause) {
      throw LockError.transport(grant.key, cause, step: LockStep.fiduciaRelease);
    }
  }
}
