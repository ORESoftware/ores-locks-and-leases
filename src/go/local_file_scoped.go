package oreslocks

// ScopedLocalFileLockErrorKind classifies structured failures from
// WithLocalFileLock without discarding either work or release errors.
type ScopedLocalFileLockErrorKind string

const (
	ScopedLocalFileLockErrorLock           ScopedLocalFileLockErrorKind = "lock"
	ScopedLocalFileLockErrorWork           ScopedLocalFileLockErrorKind = "work"
	ScopedLocalFileLockErrorWorkAndRelease ScopedLocalFileLockErrorKind = "work_and_release"
)

// ScopedLocalFileLockError preserves the work and/or local-lock failure that
// produced a scoped-operation error.
type ScopedLocalFileLockError struct {
	Kind      ScopedLocalFileLockErrorKind
	LockError error
	WorkError error
}

func (e *ScopedLocalFileLockError) Error() string {
	switch e.Kind {
	case ScopedLocalFileLockErrorWorkAndRelease:
		return "local lock work and release both failed"
	case ScopedLocalFileLockErrorWork:
		return "local lock work failed"
	default:
		return "local lock acquisition or release failed"
	}
}

// WithLocalFileLock acquires, executes work exactly once, then releases exactly
// once after a successful acquisition. Expected work failures are returned as
// error values. Go panics are not normalized into structured work errors; defer
// attempts release during unwinding and the original panic keeps precedence.
func WithLocalFileLock[T any](
	path string,
	owner string,
	options LocalFileLockOptions,
	work func(*LocalFileLock) (T, error),
) (value T, err error) {
	lock, acquireErr := AcquireLocalFileLock(path, owner, options)
	if acquireErr != nil {
		return value, &ScopedLocalFileLockError{
			Kind:      ScopedLocalFileLockErrorLock,
			LockError: acquireErr,
		}
	}

	// Preserve fatal panic precedence while still making a best-effort release.
	deferredRelease := true
	defer func() {
		if deferredRelease {
			_ = lock.Release()
		}
	}()

	value, workErr := work(lock)
	releaseErr := lock.Release()
	deferredRelease = false

	switch {
	case workErr != nil && releaseErr != nil:
		return value, &ScopedLocalFileLockError{
			Kind:      ScopedLocalFileLockErrorWorkAndRelease,
			WorkError: workErr,
			LockError: releaseErr,
		}
	case workErr != nil:
		return value, &ScopedLocalFileLockError{
			Kind:      ScopedLocalFileLockErrorWork,
			WorkError: workErr,
		}
	case releaseErr != nil:
		return value, &ScopedLocalFileLockError{
			Kind:      ScopedLocalFileLockErrorLock,
			LockError: releaseErr,
		}
	default:
		return value, nil
	}
}
