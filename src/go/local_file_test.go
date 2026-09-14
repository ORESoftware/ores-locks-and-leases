package oreslocks

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLocalFileLockContentionReleaseAndReacquire(t *testing.T) {
	path := filepath.Join(t.TempDir(), "locks", "install.lock")
	first, acquired, err := TryAcquireLocalFileLock(path, "owner-a")
	if err != nil || !acquired {
		t.Fatalf("first acquire: acquired=%v err=%v", acquired, err)
	}
	if _, acquired, err := TryAcquireLocalFileLock(path, "owner-b"); err != nil || acquired {
		t.Fatalf("contended acquire: acquired=%v err=%v", acquired, err)
	}
	if err := first.Release(); err != nil {
		t.Fatalf("release first: %v", err)
	}
	second, acquired, err := TryAcquireLocalFileLock(path, "owner-b")
	if err != nil || !acquired {
		t.Fatalf("second acquire: acquired=%v err=%v", acquired, err)
	}
	if err := second.Release(); err != nil {
		t.Fatalf("release second: %v", err)
	}
	exists, err := LocalFileLockExists(path)
	if err != nil {
		t.Fatalf("exists: %v", err)
	}
	if exists {
		t.Fatal("lock directory should be gone after release")
	}
}

func TestLocalFileLockNoWaitReportsContention(t *testing.T) {
	path := filepath.Join(t.TempDir(), "install.lock")
	first, acquired, err := TryAcquireLocalFileLock(path, "owner-a")
	if err != nil || !acquired {
		t.Fatalf("first acquire: acquired=%v err=%v", acquired, err)
	}
	defer func() { _ = first.Release() }()

	_, err = AcquireLocalFileLock(path, "owner-b", LocalFileLockOptions{
		Wait:          false,
		WaitTimeout:   30 * time.Second,
		RetryInterval: 50 * time.Millisecond,
	})
	var lockErr *LocalFileLockError
	if !errors.As(err, &lockErr) || lockErr.Kind != LocalFileContention {
		t.Fatalf("expected contention, got %#v", err)
	}
}

func TestLocalFileLockFiniteWaitTimesOut(t *testing.T) {
	path := filepath.Join(t.TempDir(), "install.lock")
	first, acquired, err := TryAcquireLocalFileLock(path, "owner-a")
	if err != nil || !acquired {
		t.Fatalf("first acquire: acquired=%v err=%v", acquired, err)
	}
	defer func() { _ = first.Release() }()

	_, err = AcquireLocalFileLock(path, "owner-b", LocalFileLockOptions{
		Wait:          true,
		WaitTimeout:   20 * time.Millisecond,
		RetryInterval: 5 * time.Millisecond,
	})
	var lockErr *LocalFileLockError
	if !errors.As(err, &lockErr) || lockErr.Kind != LocalFileTimeout {
		t.Fatalf("expected timeout, got %#v", err)
	}
}

func TestLocalFileLockChangedOwnerFailsClosed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "install.lock")
	lock, acquired, err := TryAcquireLocalFileLock(path, "owner-a")
	if err != nil || !acquired {
		t.Fatalf("acquire: acquired=%v err=%v", acquired, err)
	}
	ownerPath := filepath.Join(path, localFileOwnerName)
	if err := os.WriteFile(ownerPath, []byte("owner-b"), 0o600); err != nil {
		t.Fatalf("replace owner: %v", err)
	}
	if err := lock.Release(); err == nil {
		t.Fatal("release should fail closed when owner token changes")
	} else {
		var lockErr *LocalFileLockError
		if !errors.As(err, &lockErr) || lockErr.Kind != LocalFileCompromised {
			t.Fatalf("expected compromised error, got %#v", err)
		}
	}
	if err := os.Remove(ownerPath); err != nil {
		t.Fatalf("cleanup owner: %v", err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatalf("cleanup lock: %v", err)
	}
}
