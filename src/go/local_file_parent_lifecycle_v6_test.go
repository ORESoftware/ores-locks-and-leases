package oreslocks

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLocalFileLockReleasePreservesAutoCreatedParent(t *testing.T) {
	root := t.TempDir()
	parent := filepath.Join(root, "auto-created-parent")
	path := filepath.Join(parent, "install.lock")
	if _, err := os.Stat(parent); !os.IsNotExist(err) {
		t.Fatalf("parent should start absent, err=%v", err)
	}

	lock, acquired, err := TryAcquireLocalFileLock(path, "owner-a")
	if err != nil || !acquired {
		t.Fatalf("acquire: acquired=%v err=%v", acquired, err)
	}
	if err := lock.Release(); err != nil {
		t.Fatalf("release: %v", err)
	}

	info, err := os.Stat(parent)
	if err != nil || !info.IsDir() {
		t.Fatalf("release must preserve auto-created parent: info=%v err=%v", info, err)
	}
	entries, err := os.ReadDir(parent)
	if err != nil {
		t.Fatalf("read parent: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("parent must be empty after release: %v", entries)
	}
}
