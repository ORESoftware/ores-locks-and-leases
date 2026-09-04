package oreslocks

// Layers says which coordination layers a routine engages. Both false is a
// deliberate pass-through for tests and single-writer development.
type Layers struct {
	// Fiducia engages the fiducia-cloud lease: outermost, cross-host,
	// TTL-bounded, fenced.
	Fiducia bool
	// PgAdvisory engages a Postgres advisory lock: inner, single-database,
	// released by Postgres.
	PgAdvisory bool
}

var (
	LayersNone        = Layers{}
	LayersFiduciaOnly = Layers{Fiducia: true}
	LayersPgOnly      = Layers{PgAdvisory: true}
	LayersBoth        = Layers{Fiducia: true, PgAdvisory: true}
)

// PgScope says how the Postgres advisory lock is scoped.
type PgScope string

const (
	// ScopeTransaction: pg_advisory_xact_lock inside a transaction the
	// routine opens; the work runs inside it; released at commit/rollback.
	ScopeTransaction PgScope = "transaction"
	// ScopeSession: pg_advisory_lock / pg_advisory_unlock on one dedicated
	// connection; no transaction is opened.
	ScopeSession PgScope = "session"
)

// Step is one action in a Plan. The values are the contract's LockStep enum.
type Step string

const (
	StepFiduciaAcquire        Step = "fiducia.acquire"
	StepFiduciaTryAcquire     Step = "fiducia.try_acquire"
	StepFiduciaRelease        Step = "fiducia.release"
	StepPgBegin               Step = "pg.begin"
	StepPgAdvisoryXactLock    Step = "pg.advisory_xact_lock"
	StepPgTryAdvisoryXactLock Step = "pg.try_advisory_xact_lock"
	StepPgCommit              Step = "pg.commit"
	StepPgRollback            Step = "pg.rollback"
	StepPgAdvisoryLock        Step = "pg.advisory_lock"
	StepPgTryAdvisoryLock     Step = "pg.try_advisory_lock"
	StepPgAdvisoryUnlock      Step = "pg.advisory_unlock"
	StepWork                  Step = "work"
)

// Plan is the ordered actions for one (layers, scope, wait) tuple.
type Plan struct {
	Layers  Layers
	PgScope PgScope
	Wait    bool
	Steps   []Step
}

// MakePlan computes the plan. Pure; identical across every language slice.
// wait=true blocks each layer up to its budget; wait=false uses the
// non-blocking acquisition of each layer and fails fast with KindContention.
func MakePlan(layers Layers, scope PgScope, wait bool) Plan {
	steps := make([]Step, 0, 6)
	pick := func(blocking, nonBlocking Step) Step {
		if wait {
			return blocking
		}
		return nonBlocking
	}
	if layers.Fiducia {
		steps = append(steps, pick(StepFiduciaAcquire, StepFiduciaTryAcquire))
	}
	switch {
	case !layers.PgAdvisory:
		steps = append(steps, StepWork)
	case scope == ScopeSession:
		steps = append(steps, pick(StepPgAdvisoryLock, StepPgTryAdvisoryLock), StepWork, StepPgAdvisoryUnlock)
	default:
		steps = append(steps, StepPgBegin, pick(StepPgAdvisoryXactLock, StepPgTryAdvisoryXactLock), StepWork, StepPgCommit)
	}
	if layers.Fiducia {
		steps = append(steps, StepFiduciaRelease)
	}
	return Plan{Layers: layers, PgScope: scope, Wait: wait, Steps: steps}
}
