package oreslocks

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func skipSymlinkUnavailable(t *testing.T, err error) {
	t.Helper()
	if errors.Is(err, os.ErrPermission) {
		t.Skipf("symlink unavailable on runner: %v", err)
	}
	if err != nil {
		t.Fatalf("create symlink: %v", err)
	}
}

func TestLocalFileLockRendezvousSymlinkIsCompromised(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "target")
	link := filepath.Join(root, "install.lock")
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatalf("create target: %v", err)
	}
	err := os.Symlink(target, link)
	skipSymlinkUnavailable(t, err)

	_, _, err = TryAcquireLocalFileLock(link, "owner-a")
	var lockErr *LocalFileLockError
	if !errors.As(err, &lockErr) || lockErr.Kind != LocalFileCompromised {
		t.Fatalf("unexpected acquire result: %#v", err)
	}
	_, err = LocalFileLockExists(link)
	if !errors.As(err, &lockErr) || lockErr.Kind != LocalFileCompromised {
		t.Fatalf("unexpected exists result: %#v", err)
	}
}

func TestLocalFileLockImmediateParentSymlinkIsCompromised(t *testing.T) {
	root := t.TempDir()
	targetParent := filepath.Join(root, "real-parent")
	aliasParent := filepath.Join(root, "alias-parent")
	if err := os.Mkdir(targetParent, 0o700); err != nil {
		t.Fatalf("create target parent: %v", err)
	}
	err := os.Symlink(targetParent, aliasParent)
	skipSymlinkUnavailable(t, err)

	_, _, err = TryAcquireLocalFileLock(filepath.Join(aliasParent, "install.lock"), "owner-a")
	var lockErr *LocalFileLockError
	if !errors.As(err, &lockErr) || lockErr.Kind != LocalFileCompromised {
		t.Fatalf("unexpected acquire result: %#v", err)
	}
}

func TestLocalFileLockOwnerSymlinkIsCompromisedOnRelease(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "install.lock")
	lock, acquired, err := TryAcquireLocalFileLock(path, "owner-a")
	if err != nil || !acquired {
		t.Fatalf("acquire: acquired=%v err=%v", acquired, err)
	}
	ownerPath := filepath.Join(path, localFileOwnerName)
	if err := os.Remove(ownerPath); err != nil {
		t.Fatalf("remove owner: %v", err)
	}
	externalOwner := filepath.Join(root, "external-owner")
	if err := os.WriteFile(externalOwner, []byte("owner-a"), 0o600); err != nil {
		t.Fatalf("write external owner: %v", err)
	}
	if err := os.Symlink(externalOwner, ownerPath); err != nil {
		if errors.Is(err, os.ErrPermission) {
			if restoreErr := os.WriteFile(ownerPath, []byte("owner-a"), 0o600); restoreErr != nil {
				t.Fatalf("restore owner: %v", restoreErr)
			}
			if releaseErr := lock.Release(); releaseErr != nil {
				t.Fatalf("release restored lock: %v", releaseErr)
			}
			t.Skipf("file symlink unavailable on runner: %v", err)
		}
		t.Fatalf("create owner symlink: %v", err)
	}

	err = lock.Release()
	var lockErr *LocalFileLockError
	if !errors.As(err, &lockErr) || lockErr.Kind != LocalFileCompromised {
		t.Fatalf("unexpected release result: %#v", err)
	}
	lock.released = true
}

func TestLocalFileLockCaseAliasesContendWhenFilesystemAliasesCase(t *testing.T) {
	root := t.TempDir()
	upper := filepath.Join(root, "Install.lock")
	lower := filepath.Join(root, "install.lock")
	first, acquired, err := TryAcquireLocalFileLock(upper, "owner-a")
	if err != nil || !acquired {
		t.Fatalf("acquire upper: acquired=%v err=%v", acquired, err)
	}
	defer func() {
		if err := first.Release(); err != nil {
			t.Fatalf("release upper: %v", err)
		}
	}()

	upperInfo, upperErr := os.Stat(upper)
	lowerInfo, lowerErr := os.Stat(lower)
	if upperErr == nil && lowerErr == nil && os.SameFile(upperInfo, lowerInfo) {
		second, acquired, err := TryAcquireLocalFileLock(lower, "owner-b")
		if err != nil || acquired || second != nil {
			t.Fatalf("case alias must contend: lock=%#v acquired=%v err=%v", second, acquired, err)
		}
	}
}
