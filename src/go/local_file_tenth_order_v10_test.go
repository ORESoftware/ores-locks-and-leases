package oreslocks

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLocalFileLockTenthOrderPartialReleaseRetainsOriginalError(t *testing.T) {
	path := filepath.Join(t.TempDir(), "partial.lock")
	lock, acquired, err := TryAcquireLocalFileLock(path, "owner-a")
	if err != nil || !acquired || lock == nil {
		t.Fatalf("acquire: lock=%v acquired=%v err=%v", lock, acquired, err)
	}
	if err := os.WriteFile(filepath.Join(path, "unexpected"), []byte("dirty"), 0o600); err != nil {
		t.Fatal(err)
	}

	first := lock.Release()
	if first == nil {
		t.Fatal("expected destructive partial-release failure")
	}
	second := lock.Release()
	if second == nil {
		t.Fatal("expected retained destructive partial-release failure")
	}
	if first != second {
		t.Fatalf("expected exact retained error object: first=%p second=%p", first, second)
	}
}

func TestLocalFileLockTenthOrderFiniteWaitBudgetIsEndToEnd(t *testing.T) {
	path := filepath.Join(t.TempDir(), "timeout.lock")
	holder, acquired, err := TryAcquireLocalFileLock(path, "holder")
	if err != nil || !acquired || holder == nil {
		t.Fatalf("acquire holder: lock=%v acquired=%v err=%v", holder, acquired, err)
	}
	defer func() { _ = holder.Release() }()

	started := time.Now()
	_, err = AcquireLocalFileLock(path, "waiter", LocalFileLockOptions{
		Wait:          true,
		WaitTimeout:   30 * time.Millisecond,
		RetryInterval: 5 * time.Millisecond,
	})
	elapsed := time.Since(started)
	var localErr *LocalFileLockError
	if !errors.As(err, &localErr) || localErr.Kind != LocalFileTimeout {
		t.Fatalf("expected timeout, got %v", err)
	}
	if elapsed < 20*time.Millisecond {
		t.Fatalf("timeout returned implausibly early: %v", elapsed)
	}
	if elapsed > 2*time.Second {
		t.Fatalf("timeout exceeded bounded end-to-end budget: %v", elapsed)
	}
}
