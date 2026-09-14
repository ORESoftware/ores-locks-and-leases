package oreslocks

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
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

func TestLocalFileLockZeroTimeoutTimesOutImmediately(t *testing.T) {
	path := filepath.Join(t.TempDir(), "install.lock")
	first, acquired, err := TryAcquireLocalFileLock(path, "owner-a")
	if err != nil || !acquired {
		t.Fatalf("first acquire: acquired=%v err=%v", acquired, err)
	}
	defer func() { _ = first.Release() }()

	_, err = AcquireLocalFileLock(path, "owner-b", LocalFileLockOptions{
		Wait:          true,
		WaitTimeout:   0,
		RetryInterval: 50 * time.Millisecond,
	})
	var lockErr *LocalFileLockError
	if !errors.As(err, &lockErr) || lockErr.Kind != LocalFileTimeout {
		t.Fatalf("expected zero-budget timeout, got %#v", err)
	}
}

func TestLocalFileLockEmptyOwnerIsInvalid(t *testing.T) {
	path := filepath.Join(t.TempDir(), "install.lock")
	_, _, err := TryAcquireLocalFileLock(path, "")
	var lockErr *LocalFileLockError
	if !errors.As(err, &lockErr) || lockErr.Kind != LocalFileInvalidInput {
		t.Fatalf("expected invalid input, got %#v", err)
	}
}

func TestLocalFileLockOwnerAtMaxCodepointsIsValid(t *testing.T) {
	path := filepath.Join(t.TempDir(), "install.lock")
	owner := strings.Repeat("😀", 512)
	lock, acquired, err := TryAcquireLocalFileLock(path, owner)
	if err != nil || !acquired {
		t.Fatalf("expected 512-code-point owner to be valid: acquired=%v err=%v", acquired, err)
	}
	if err := lock.Release(); err != nil {
		t.Fatalf("release max owner lock: %v", err)
	}
}

func TestLocalFileLockOversizedOwnerIsInvalid(t *testing.T) {
	path := filepath.Join(t.TempDir(), "install.lock")
	_, _, err := TryAcquireLocalFileLock(path, strings.Repeat("😀", 513))
	var lockErr *LocalFileLockError
	if !errors.As(err, &lockErr) || lockErr.Kind != LocalFileInvalidInput {
		t.Fatalf("expected oversized owner invalid input, got %#v", err)
	}
}

func TestLocalFileLockNegativeRetryIsInvalidEvenWithoutWaiting(t *testing.T) {
	path := filepath.Join(t.TempDir(), "install.lock")
	_, err := AcquireLocalFileLock(path, "owner-a", LocalFileLockOptions{
		Wait:          false,
		WaitTimeout:   30 * time.Second,
		RetryInterval: -1 * time.Millisecond,
	})
	var lockErr *LocalFileLockError
	if !errors.As(err, &lockErr) || lockErr.Kind != LocalFileInvalidInput {
		t.Fatalf("expected negative retry invalid input, got %#v", err)
	}
}

func TestLocalFileLockZeroRetryIsValidWithoutWaiting(t *testing.T) {
	path := filepath.Join(t.TempDir(), "install.lock")
	lock, err := AcquireLocalFileLock(path, "owner-a", LocalFileLockOptions{
		Wait:          false,
		WaitTimeout:   30 * time.Second,
		RetryInterval: 0,
	})
	if err != nil {
		t.Fatalf("zero retry without waiting must be valid: %v", err)
	}
	if err := lock.Release(); err != nil {
		t.Fatalf("release zero-retry lock: %v", err)
	}
}

func TestLocalFileLockOwnerMarkerIsPrivateOnPosix(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX mode bits are not the Windows ownership primitive")
	}
	path := filepath.Join(t.TempDir(), "install.lock")
	lock, acquired, err := TryAcquireLocalFileLock(path, "owner-a")
	if err != nil || !acquired {
		t.Fatalf("acquire: acquired=%v err=%v", acquired, err)
	}
	ownerInfo, err := os.Stat(filepath.Join(path, localFileOwnerName))
	if err != nil {
		t.Fatalf("stat owner marker: %v", err)
	}
	if got := ownerInfo.Mode().Perm() & 0o077; got != 0 {
		t.Fatalf("owner marker exposes group/other permissions: %#o", got)
	}
	if err := lock.Release(); err != nil {
		t.Fatalf("release: %v", err)
	}
}

func TestLocalFileLockExistingRegularFileIsCompromised(t *testing.T) {
	path := filepath.Join(t.TempDir(), "install.lock")
	if err := os.WriteFile(path, []byte("not a lock directory"), 0o600); err != nil {
		t.Fatalf("seed regular file: %v", err)
	}
	_, _, err := TryAcquireLocalFileLock(path, "owner-a")
	var lockErr *LocalFileLockError
	if !errors.As(err, &lockErr) || lockErr.Kind != LocalFileCompromised {
		t.Fatalf("expected compromised error, got %#v", err)
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

func TestLocalFileLockMissingOwnerFailsClosed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "install.lock")
	lock, acquired, err := TryAcquireLocalFileLock(path, "owner-a")
	if err != nil || !acquired {
		t.Fatalf("acquire: acquired=%v err=%v", acquired, err)
	}
	ownerPath := filepath.Join(path, localFileOwnerName)
	if err := os.Remove(ownerPath); err != nil {
		t.Fatalf("remove owner: %v", err)
	}
	err = lock.Release()
	var lockErr *LocalFileLockError
	if !errors.As(err, &lockErr) || lockErr.Kind != LocalFileCompromised {
		t.Fatalf("expected compromised error, got %#v", err)
	}
}

func TestLocalFileLockUnexpectedEntryFailsClosed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "install.lock")
	lock, acquired, err := TryAcquireLocalFileLock(path, "owner-a")
	if err != nil || !acquired {
		t.Fatalf("acquire: acquired=%v err=%v", acquired, err)
	}
	if err := os.WriteFile(filepath.Join(path, "unexpected"), []byte("do not delete"), 0o600); err != nil {
		t.Fatalf("write unexpected entry: %v", err)
	}

	err = lock.Release()
	var lockErr *LocalFileLockError
	if !errors.As(err, &lockErr) || lockErr.Kind != LocalFileCompromised {
		t.Fatalf("expected compromised error for dirty directory, got %#v", err)
	}
	if _, err := os.Stat(filepath.Join(path, "unexpected")); err != nil {
		t.Fatalf("unexpected entry must remain for explicit recovery: %v", err)
	}
}

func TestLocalFileLockNestedUnicodePath(t *testing.T) {
	path := filepath.Join(t.TempDir(), "locks", "锁", "paquete-ñ.lock")
	lock, acquired, err := TryAcquireLocalFileLock(path, "owner-λ")
	if err != nil || !acquired {
		t.Fatalf("unicode acquire: acquired=%v err=%v", acquired, err)
	}
	if lock.Owner() != "owner-λ" {
		t.Fatalf("owner round trip: %q", lock.Owner())
	}
	if err := lock.Release(); err != nil {
		t.Fatalf("unicode release: %v", err)
	}
}
