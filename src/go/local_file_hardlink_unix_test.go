//go:build linux || darwin

package oreslocks

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestLocalFileLockRejectsHardLinkedOwnerMarker(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "install.lock")
	alias := filepath.Join(root, "owner-alias")

	lock, acquired, err := TryAcquireLocalFileLock(path, "owner-a")
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if !acquired || lock == nil {
		t.Fatal("expected initial holder")
	}
	if err := os.Link(filepath.Join(path, localFileOwnerName), alias); err != nil {
		t.Fatalf("create owner hard link: %v", err)
	}

	inspection, err := InspectLocalFileLock(path)
	if err != nil {
		t.Fatalf("inspect: %v", err)
	}
	if inspection.State != LocalFileLockCompromised {
		t.Fatalf("hard-linked owner state = %q, want compromised", inspection.State)
	}

	releaseErr := lock.Release()
	var localErr *LocalFileLockError
	if !errors.As(releaseErr, &localErr) || localErr.Kind != LocalFileCompromised {
		t.Fatalf("release error = %#v, want compromised LocalFileLockError", releaseErr)
	}
}
