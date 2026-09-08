/// Composed distributed locking for the ORESoftware fleet — the Dart slice of
/// `ORESoftware/ores-locks-and-leases`.
///
/// Two layers, each individually switchable through [LockLayers]: an outer
/// fiducia-cloud lease (cross-host, TTL-bounded, fenced) and an inner Postgres
/// advisory lock (transaction- or session-scoped). The maintained transaction
/// path renews Fiducia while PostgreSQL work runs and requires one final
/// renewal before commit.
///
/// ```text
/// fiducia.acquire → pg.begin → pg_advisory_xact_lock → work → fiducia.renew → pg.commit → fiducia.release
/// ```
///
/// `key`, `plan`, `errors`, `lease`, `fence`, and `fence_wire` are
/// dependency-free and safe for Flutter and browser targets (the
/// `*-pub-lib-core` packages); `pg` and `maintained` need `package:postgres`
/// and `fiducia` needs `package:http`.
library;

export 'src/errors.dart';
export 'src/fence.dart';
export 'src/fence_wire.dart';
export 'src/fiducia.dart';
export 'src/key.dart';
export 'src/lease.dart';
export 'src/maintained.dart';
export 'src/pg.dart';
export 'src/plan.dart';
