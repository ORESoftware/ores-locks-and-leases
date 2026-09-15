package oreslocks

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestWithLocalFileLockPanicKeepsPanicPrecedenceAndReleases(t *testing.T) {
	path := filepath.Join(t.TempDir(), "panic-release.lock")
	defer func() {
		if recovered := recover(); recovered == nil {
			t.Fatal("expected work panic to propagate")
		}
		if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("Go panic unwinding should best-effort release local lock; stat err=%v", err)
		}
	}()

	_, _ = WithLocalFileLock(
		path,
		"owner-a",
		DefaultLocalFileLockOptions(),
		func(*LocalFileLock) (int, error) {
			panic("work-boom")
		},
	)
}
