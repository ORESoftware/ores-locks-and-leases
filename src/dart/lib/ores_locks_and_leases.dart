/// Composed distributed locking for the ORESoftware fleet — the Dart slice of
/// `ORESoftware/ores-locks-and-leases`.
///
/// Two layers, each individually switchable through [LockLayers]: an outer
/// fiducia-cloud lease (cross-host, TTL-bounded, fenced) and an inner Postgres
/// advisory lock (transaction- or session-scoped). The order is the
/// contract's and the same in every language slice:
///
/// ```text
/// fiducia.acquire → pg.begin → pg.advisory_xact_lock → work → pg.commit → fiducia.release
/// ```
///
/// `key`, `plan`, `errors` and `lease` are dependency-free and safe for
/// Flutter and browser targets (the `*-pub-lib-core` packages); `pg` needs
/// `package:postgres` and `fiducia` needs `package:http`.
library;

export 'src/errors.dart';
export 'src/fiducia.dart';
export 'src/key.dart';
export 'src/lease.dart';
export 'src/pg.dart';
export 'src/plan.dart';
