package oreslocks

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestLocalFileLockRecoveryClaimIsIncomplete(t *testing.T) {
	path := filepath.Join(t.TempDir(), "recovering-state.lock")
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, localFileOwnerRecoveringName), []byte("owner-a"), 0o600); err != nil {
		t.Fatal(err)
	}

	inspection, err := InspectLocalFileLock(path)
	if err != nil {
		t.Fatal(err)
	}
	if inspection.State != LocalFileLockIncomplete || inspection.Owner != "" {
		t.Fatalf("recovery claim must inspect incomplete: %+v", inspection)
	}
}

func TestLocalFileLockConcurrentExactOwnerRecoveryHasOneWinner(t *testing.T) {
	path := filepath.Join(t.TempDir(), "parallel-recovery.lock")
	owner := "parallel-go-owner"
	lock, acquired, err := TryAcquireLocalFileLock(path, owner)
	if err != nil || !acquired || lock == nil {
		t.Fatalf("acquire crash-held lock: lock=%v acquired=%v err=%v", lock, acquired, err)
	}
	// Deliberately do not release `lock`: this models a crashed process whose
	// persisted owner marker is the only remaining recovery authority.

	type outcome struct {
		recovered bool
		err       error
	}
	outcomes := make(chan outcome, 32)
	var wg sync.WaitGroup
	wg.Add(32)
	for i := 0; i < 32; i++ {
		go func() {
			defer wg.Done()
			recovered, err := RecoverLocalFileLock(path, owner, true)
			outcomes <- outcome{recovered: recovered, err: err}
		}()
	}
	wg.Wait()
	close(outcomes)

	winners := 0
	for result := range outcomes {
		if result.err == nil && result.recovered {
			winners++
		}
	}
	if winners != 1 {
		t.Fatalf("expected exactly one destructive recovery winner, got %d", winners)
	}

	inspection, err := InspectLocalFileLock(path)
	if err != nil {
		t.Fatal(err)
	}
	if inspection.State != LocalFileLockAbsent {
		t.Fatalf("expected absent final state, got %+v", inspection)
	}
	recovered, err := RecoverLocalFileLock(path, owner, true)
	if err != nil || recovered {
		t.Fatalf("absent recovery must be false/no-op: recovered=%v err=%v", recovered, err)
	}
}
