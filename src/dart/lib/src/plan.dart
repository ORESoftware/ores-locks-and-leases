/// Which coordination layers a routine engages. Both false is a deliberate
/// pass-through for tests and single-writer development.
final class LockLayers {
  /// The fiducia-cloud lease: outermost, cross-host, TTL-bounded, fenced.
  final bool fiducia;

  /// A Postgres advisory lock: inner, single-database, released by Postgres.
  final bool pgAdvisory;

  const LockLayers({required this.fiducia, required this.pgAdvisory});

  static const none = LockLayers(fiducia: false, pgAdvisory: false);
  static const fiduciaOnly = LockLayers(fiducia: true, pgAdvisory: false);
  static const pgOnly = LockLayers(fiducia: false, pgAdvisory: true);
  static const both = LockLayers(fiducia: true, pgAdvisory: true);

  @override
  bool operator ==(Object other) =>
      other is LockLayers &&
      other.fiducia == fiducia &&
      other.pgAdvisory == pgAdvisory;

  @override
  int get hashCode => Object.hash(fiducia, pgAdvisory);
}

/// How the Postgres advisory lock is scoped.
enum PgScope {
  /// `pg_advisory_xact_lock` inside a transaction the routine opens; the work
  /// runs inside it; released at commit/rollback.
  transaction('transaction'),

  /// `pg_advisory_lock` / `pg_advisory_unlock` on one dedicated connection;
  /// no transaction is opened.
  session('session');

  final String wire;
  const PgScope(this.wire);

  static PgScope parse(String value) =>
      values.firstWhere((s) => s.wire == value);
}

/// One action in a plan. [wire] is the contract's `LockStep` value.
enum LockStep {
  fiduciaAcquire('fiducia.acquire'),
  fiduciaTryAcquire('fiducia.try_acquire'),
  fiduciaRelease('fiducia.release'),
  pgBegin('pg.begin'),
  pgAdvisoryXactLock('pg.advisory_xact_lock'),
  pgTryAdvisoryXactLock('pg.try_advisory_xact_lock'),
  pgCommit('pg.commit'),
  pgRollback('pg.rollback'),
  pgAdvisoryLock('pg.advisory_lock'),
  pgTryAdvisoryLock('pg.try_advisory_lock'),
  pgAdvisoryUnlock('pg.advisory_unlock'),
  work('work');

  final String wire;
  const LockStep(this.wire);

  static LockStep parse(String value) =>
      values.firstWhere((s) => s.wire == value);
}

/// The ordered actions for one `(layers, scope, wait)` tuple.
final class LockPlan {
  final LockLayers layers;
  final PgScope pgScope;
  final bool wait;
  final List<LockStep> steps;

  const LockPlan(
      {required this.layers,
      required this.pgScope,
      required this.wait,
      required this.steps});
}

/// Compute the plan. Pure; identical across every language slice. [wait]
/// blocks each layer up to its budget; `!wait` uses the non-blocking form of
/// each acquisition and fails fast with `contention`.
LockPlan plan(LockLayers layers, PgScope pgScope, bool wait) {
  LockStep pick(LockStep blocking, LockStep nonBlocking) =>
      wait ? blocking : nonBlocking;
  final steps = <LockStep>[
    if (layers.fiducia)
      pick(LockStep.fiduciaAcquire, LockStep.fiduciaTryAcquire),
    if (!layers.pgAdvisory)
      LockStep.work
    else if (pgScope == PgScope.session) ...[
      pick(LockStep.pgAdvisoryLock, LockStep.pgTryAdvisoryLock),
      LockStep.work,
      LockStep.pgAdvisoryUnlock,
    ] else ...[
      LockStep.pgBegin,
      pick(LockStep.pgAdvisoryXactLock, LockStep.pgTryAdvisoryXactLock),
      LockStep.work,
      LockStep.pgCommit,
    ],
    if (layers.fiducia) LockStep.fiduciaRelease,
  ];
  return LockPlan(
      layers: layers,
      pgScope: pgScope,
      wait: wait,
      steps: List.unmodifiable(steps));
}
