package oreslocks

import (
	"bytes"
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
