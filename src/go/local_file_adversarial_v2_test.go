package oreslocks

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLocalFileLockWaiterAcquiresAfterReleaseWithinBudget(t *testing.T) {
	path := filepath.Join(t.TempDir(), "install.lock")
	first, acquired, err := TryAcquireLocalFileLock(path, "owner-a")
	if err != nil || !acquired || first == nil {
		t.Fatalf("first acquire: acquired=%v err=%v", acquired, err)
	}

	released := make(chan error, 1)
	go func() {
		time.Sleep(25 * time.Millisecond)
		released <- first.Release()
	}()

	second, err := AcquireLocalFileLock(path, "owner-b", LocalFileLockOptions{
		Wait:          true,
		WaitTimeout:   500 * time.Millisecond,
		RetryInterval: 5 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("waiter acquire: %v", err)
	}
	if second.Owner() != "owner-b" {
		t.Fatalf("unexpected owner: %q", second.Owner())
	}
	if err := second.Release(); err != nil {
		t.Fatalf("second release: %v", err)
	}
	if err := <-released; err != nil {
		t.Fatalf("first release: %v", err)
	}
}

func TestLocalFileLockInspectionBoundsPersistedOwnerRead(t *testing.T) {
	path := filepath.Join(t.TempDir(), "install.lock")
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, localFileOwnerName), bytes.Repeat([]byte{'a'}, localFileOwnerMaxUTF8Bytes+1), 0o600); err != nil {
		t.Fatal(err)
	}

	inspection, err := InspectLocalFileLock(path)
	if err != nil {
		t.Fatalf("inspect: %v", err)
	}
	if inspection.State != LocalFileLockCompromised {
		t.Fatalf("expected compromised, got %s", inspection.State)
	}
	if !strings.Contains(inspection.Message, "2048-byte") {
		t.Fatalf("unexpected message: %q", inspection.Message)
	}
}

func TestLocalFileLockReleaseBoundsPersistedOwnerRead(t *testing.T) {
	path := filepath.Join(t.TempDir(), "install.lock")
	lock, acquired, err := TryAcquireLocalFileLock(path, "owner-a")
	if err != nil || !acquired {
		t.Fatalf("acquire: %v", err)
	}
	if err := os.WriteFile(filepath.Join(path, localFileOwnerName), bytes.Repeat([]byte{'a'}, localFileOwnerMaxUTF8Bytes+1), 0o600); err != nil {
		t.Fatal(err)
	}

	err = lock.Release()
	var localErr *LocalFileLockError
	if !errors.As(err, &localErr) || localErr.Kind != LocalFileCompromised || !strings.Contains(localErr.Message, "2048-byte") {
		t.Fatalf("expected bounded compromised release, got %v", err)
	}
}

func TestLocalFileLockInspectionRejectsInvalidUTF8(t *testing.T) {
	path := filepath.Join(t.TempDir(), "install.lock")
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, localFileOwnerName), []byte{0xff}, 0o600); err != nil {
		t.Fatal(err)
	}

	inspection, err := InspectLocalFileLock(path)
	if err != nil {
		t.Fatalf("inspect: %v", err)
	}
	if inspection.State != LocalFileLockCompromised {
		t.Fatalf("expected compromised, got %s", inspection.State)
	}
	if !strings.Contains(inspection.Message, "valid UTF-8") {
		t.Fatalf("unexpected message: %q", inspection.Message)
	}
}

func TestLocalFileLockExistsFailsClosedForIncompleteState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "install.lock")
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := LocalFileLockExists(path); err == nil {
		t.Fatal("boolean exists must not bless an incomplete ownerless lock")
	}
}

func TestGeneratedLocalFileLockOwnerIsFreshAndValid(t *testing.T) {
	first, err := GeneratedLocalFileLockOwner()
	if err != nil {
		t.Fatal(err)
	}
	second, err := GeneratedLocalFileLockOwner()
	if err != nil {
		t.Fatal(err)
	}
	if first == second || !strings.HasPrefix(first, "ores-locks-") || !strings.HasPrefix(second, "ores-locks-") {
		t.Fatalf("unexpected generated owners: %q %q", first, second)
	}
	if err := validateLocalOwner("generated", first); err != nil {
		t.Fatalf("generated owner rejected: %v", err)
	}
}

func TestLocalFileLockErrorsDoNotRenderOwnerTokens(t *testing.T) {
	path := filepath.Join(t.TempDir(), "install.lock")
	secretOwner := "owner-secret-control-\n-5f4dcc3b5aa765d61d8327deb882cf99"
	lock, acquired, err := TryAcquireLocalFileLock(path, secretOwner)
	if err != nil || !acquired {
		t.Fatalf("acquire: %v", err)
	}
	if err := os.WriteFile(filepath.Join(path, localFileOwnerName), []byte("other-owner"), 0o600); err != nil {
		t.Fatal(err)
	}
	err = lock.Release()
	if err == nil {
		t.Fatal("expected compromised release")
	}
	if strings.Contains(err.Error(), secretOwner) {
		t.Fatalf("owner token leaked in error: %v", err)
	}
}
