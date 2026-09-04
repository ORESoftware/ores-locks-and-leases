package oreslocks

import "fmt"

// Kind is why an acquisition or guarded run failed. Contract enum LockErrorKind.
type Kind string

const (
	// KindContention: a layer is held by someone else and wait was false.
	KindContention Kind = "contention"
	// KindTimeout: the wait budget elapsed before every layer was held.
	KindTimeout Kind = "timeout"
	// KindLostLease: the fiducia lease could not be renewed or was reaped.
	// Fenced authority is gone; the guarded work must not continue.
	KindLostLease Kind = "lost_lease"
	// KindTransport: transport/HTTP failure talking to the lease authority.
	// Ownership is unknown — never treat this as "not held".
	KindTransport Kind = "transport"
	// KindDatabase: the database refused the advisory statement, the
	// transaction, or the connection.
	KindDatabase Kind = "database"
	// KindWork: the caller's work returned an error; outer layers were still
	// released and the transaction, if any, rolled back.
	KindWork Kind = "work"
	// KindInvalidPlan: the inputs cannot be planned.
	KindInvalidPlan Kind = "invalid_plan"
)

// Error is the one structured failure every routine surfaces. Contract
// model LockError. Cause, when set, is the underlying error (errors.Unwrap).
type Error struct {
	Kind    Kind
	Key     LockKey
	Step    Step // "" when unknown
	Message string
	Cause   error
}

func (e *Error) Error() string {
	if e.Step != "" {
		return fmt.Sprintf("%s at %s for `%s`: %s", e.Kind, e.Step, e.Key, e.Message)
	}
	return fmt.Sprintf("%s for `%s`: %s", e.Kind, e.Key, e.Message)
}

func (e *Error) Unwrap() error { return e.Cause }

// Retryable reports whether retrying the whole routine is reasonable: the
// layer was busy or the budget ran out, and nothing was left half-done.
func (e *Error) Retryable() bool { return e.Kind == KindContention || e.Kind == KindTimeout }

func newError(kind Kind, key LockKey, step Step, message string, cause error) *Error {
	return &Error{Kind: kind, Key: key, Step: step, Message: message, Cause: cause}
}

func contention(key LockKey, step Step) *Error {
	return newError(KindContention, key, step, fmt.Sprintf("`%s` is held by another holder", key), nil)
}

func timeout(key LockKey, step Step, waitedMs int64) *Error {
	return newError(KindTimeout, key, step, fmt.Sprintf("gave up waiting for `%s` after %d ms", key, waitedMs), nil)
}

func workErr(key LockKey, cause error) *Error {
	return newError(KindWork, key, StepWork, cause.Error(), cause)
}

func invalidPlan(key LockKey, message string) *Error {
	return newError(KindInvalidPlan, key, "", message, nil)
}

func dbErr(key LockKey, step Step, cause error) *Error {
	return newError(KindDatabase, key, step, cause.Error(), cause)
}

// tagStep fills in the step on an *Error that has none; other errors pass through.
func tagStep(err error, step Step) error {
	if le, ok := err.(*Error); ok && le.Step == "" {
		le.Step = step
	}
	return err
}
