package oreslocks

import (
	"path/filepath"
	"testing"
	"time"
)

func TestLocalFileLockRetrySleepNeverOutlivesRemainingBudget(t *testing.T) {
	path := filepath.Join(t.TempDir(), "retry-budget.lock")
	holder, acquired, err := TryAcquireLocalFileLock(path, "owner-a")
	if err != nil || !acquired {
		t.Fatalf("holder acquire: acquired=%v err=%v", acquired, err)
	}
	defer func() { _ = holder.Release() }()

	started := time.Now()
	_, err = AcquireLocalFileLock(path, "owner-b", LocalFileLockOptions{
		Wait:          true,
		WaitTimeout:   40 * time.Millisecond,
		RetryInterval: 5 * time.Second,
	})
	elapsed := time.Since(started)
	if err == nil {
		t.Fatal("contender must time out")
	}
	localErr, ok := err.(*LocalFileLockError)
	if !ok || localErr.Kind != LocalFileTimeout {
		t.Fatalf("expected timeout, got %T %v", err, err)
	}
	if elapsed >= time.Second {
		t.Fatalf("retry interval leaked past finite budget: %v", elapsed)
	}
}
