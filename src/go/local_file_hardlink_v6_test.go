package oreslocks

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestLocalFileLockHardLinkedOwnerFailsClosedWhenLinkCountAvailable(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("portable Go hard-link count enforcement uses the Unix Stat_t capability")
	}
	root := t.TempDir()
	path := filepath.Join(root, "install.lock")
	alias := filepath.Join(root, "owner-hardlink-alias")
	lock, acquired, err := TryAcquireLocalFileLock(path, "owner-hardlink")
	if err != nil || !acquired {
		t.Fatalf("acquire: acquired=%v err=%v", acquired, err)
	}
	if err := os.Link(filepath.Join(path, localFileOwnerName), alias); err != nil {
		if os.IsPermission(err) {
			t.Skipf("filesystem does not permit hard links: %v", err)
		}
		t.Fatalf("create hard link: %v", err)
	}

	inspection, err := InspectLocalFileLock(path)
	if err != nil {
		t.Fatalf("inspect hard-linked owner: %v", err)
	}
	if inspection.State != LocalFileLockCompromised {
		t.Fatalf("expected compromised inspection, got %+v", inspection)
	}
	if err := lock.Release(); err == nil {
		t.Fatal("release must fail closed while owner marker is multiply linked")
	} else if localErr, ok := err.(*LocalFileLockError); !ok || localErr.Kind != LocalFileCompromised {
		t.Fatalf("expected compromised release error, got %T %v", err, err)
	}

	if err := os.Remove(alias); err != nil {
		t.Fatalf("remove hard-link alias: %v", err)
	}
	if err := lock.Release(); err != nil {
		t.Fatalf("release after alias removal: %v", err)
	}
}
