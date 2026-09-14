package oreslocks

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestWithLocalFileLockAcquireFailureDoesNotRunWork(t *testing.T) {
	path := filepath.Join(t.TempDir(), "install.lock")
	first, acquired, err := TryAcquireLocalFileLock(path, "owner-a")
	if err != nil || !acquired {
		t.Fatalf("seed acquire: acquired=%v err=%v", acquired, err)
	}
	calls := 0

	_, err = WithLocalFileLock(path, "owner-b", LocalFileLockOptions{Wait: false}, func(*LocalFileLock) (struct{}, error) {
		calls++
		return struct{}{}, nil
	})
	if err == nil {
		t.Fatal("expected scoped acquire failure")
	}
	if calls != 0 {
		t.Fatalf("work called %d times", calls)
	}
	var scoped *ScopedLocalFileLockError
	if !errors.As(err, &scoped) || scoped.Kind != ScopedLocalFileLockErrorLock {
		t.Fatalf("unexpected scoped error: %#v", err)
	}
	var lockErr *LocalFileLockError
	if !errors.As(scoped.LockError, &lockErr) || lockErr.Kind != LocalFileContention {
		t.Fatalf("unexpected lock error: %#v", scoped.LockError)
	}
	if err := first.Release(); err != nil {
		t.Fatalf("release seed holder: %v", err)
	}
}

func TestWithLocalFileLockPreservesWorkFailure(t *testing.T) {
	path := filepath.Join(t.TempDir(), "install.lock")
	workErr := errors.New("work failed")
	_, err := WithLocalFileLock(path, "owner-a", DefaultLocalFileLockOptions(), func(*LocalFileLock) (int, error) {
		return 0, workErr
	})
	var scoped *ScopedLocalFileLockError
	if !errors.As(err, &scoped) || scoped.Kind != ScopedLocalFileLockErrorWork || !errors.Is(scoped.WorkError, workErr) {
		t.Fatalf("unexpected scoped error: %#v", err)
	}
	if _, statErr := os.Stat(path); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("lock directory survived successful release: %v", statErr)
	}
}

func TestWithLocalFileLockReleaseFailureAfterWorkIsLockError(t *testing.T) {
	path := filepath.Join(t.TempDir(), "install.lock")
	_, err := WithLocalFileLock(path, "owner-a", DefaultLocalFileLockOptions(), func(lock *LocalFileLock) (int, error) {
		if writeErr := os.WriteFile(filepath.Join(lock.Path(), localFileOwnerName), []byte("owner-b"), 0o600); writeErr != nil {
			t.Fatalf("mutate owner marker: %v", writeErr)
		}
		return 42, nil
	})
	var scoped *ScopedLocalFileLockError
	if !errors.As(err, &scoped) || scoped.Kind != ScopedLocalFileLockErrorLock {
		t.Fatalf("unexpected scoped error: %#v", err)
	}
	var lockErr *LocalFileLockError
	if !errors.As(scoped.LockError, &lockErr) || lockErr.Kind != LocalFileCompromised {
		t.Fatalf("unexpected release error: %#v", scoped.LockError)
	}
}

func TestWithLocalFileLockPreservesWorkAndReleaseFailures(t *testing.T) {
	path := filepath.Join(t.TempDir(), "install.lock")
	workErr := errors.New("work failed")
	_, err := WithLocalFileLock(path, "owner-a", DefaultLocalFileLockOptions(), func(lock *LocalFileLock) (int, error) {
		if writeErr := os.WriteFile(filepath.Join(lock.Path(), localFileOwnerName), []byte("owner-b"), 0o600); writeErr != nil {
			t.Fatalf("mutate owner marker: %v", writeErr)
		}
		return 0, workErr
	})
	var scoped *ScopedLocalFileLockError
	if !errors.As(err, &scoped) || scoped.Kind != ScopedLocalFileLockErrorWorkAndRelease || !errors.Is(scoped.WorkError, workErr) {
		t.Fatalf("unexpected scoped error: %#v", err)
	}
	var lockErr *LocalFileLockError
	if !errors.As(scoped.LockError, &lockErr) || lockErr.Kind != LocalFileCompromised {
		t.Fatalf("unexpected release error: %#v", scoped.LockError)
	}
}
