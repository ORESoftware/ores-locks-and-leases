package oreslocks

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLocalFileLockInspectionAbsentAndHeld(t *testing.T) {
	path := filepath.Join(t.TempDir(), "install.lock")
	inspection, err := InspectLocalFileLock(path)
	if err != nil || inspection.State != LocalFileLockAbsent {
		t.Fatalf("inspect absent: %#v err=%v", inspection, err)
	}
	lock, acquired, err := TryAcquireLocalFileLock(path, "owner-a")
	if err != nil || !acquired {
		t.Fatalf("acquire: acquired=%v err=%v", acquired, err)
	}
	inspection, err = InspectLocalFileLock(path)
	if err != nil || inspection.State != LocalFileLockHeld || inspection.Owner != "owner-a" {
		t.Fatalf("inspect held: %#v err=%v", inspection, err)
	}
	lock.released = true
	if _, err := RecoverLocalFileLock(path, "owner-a", true); err != nil {
		t.Fatalf("cleanup recovery: %v", err)
	}
}

func TestLocalFileLockInspectionIncompleteCrashWindows(t *testing.T) {
	t.Run("mkdir-before-owner", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "install.lock")
		if err := os.Mkdir(path, 0o700); err != nil {
			t.Fatalf("seed incomplete directory: %v", err)
		}
		inspection, err := InspectLocalFileLock(path)
		if err != nil || inspection.State != LocalFileLockIncomplete {
			t.Fatalf("inspect incomplete: %#v err=%v", inspection, err)
		}
		_, err = RecoverLocalFileLock(path, "owner-a", true)
		var lockErr *LocalFileLockError
		if !errors.As(err, &lockErr) || lockErr.Kind != LocalFileCompromised {
			t.Fatalf("incomplete recovery must fail closed: %#v", err)
		}
		if _, statErr := os.Stat(path); statErr != nil {
			t.Fatalf("incomplete directory was removed: %v", statErr)
		}
	})

	t.Run("owner-removed-before-rmdir", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "install.lock")
		lock, acquired, err := TryAcquireLocalFileLock(path, "owner-a")
		if err != nil || !acquired {
			t.Fatalf("acquire: acquired=%v err=%v", acquired, err)
		}
		lock.released = true
		if err := os.Remove(filepath.Join(path, localFileOwnerName)); err != nil {
			t.Fatalf("simulate release crash: %v", err)
		}
		inspection, err := InspectLocalFileLock(path)
		if err != nil || inspection.State != LocalFileLockIncomplete {
			t.Fatalf("inspect release crash: %#v err=%v", inspection, err)
		}
		_, err = RecoverLocalFileLock(path, "owner-a", true)
		var lockErr *LocalFileLockError
		if !errors.As(err, &lockErr) || lockErr.Kind != LocalFileCompromised {
			t.Fatalf("release-crash recovery must fail closed: %#v", err)
		}
	})
}

func TestLocalFileLockInspectionDirtyIsCompromised(t *testing.T) {
	path := filepath.Join(t.TempDir(), "install.lock")
	lock, acquired, err := TryAcquireLocalFileLock(path, "owner-a")
	if err != nil || !acquired {
		t.Fatalf("acquire: acquired=%v err=%v", acquired, err)
	}
	lock.released = true
	if err := os.Remove(filepath.Join(path, localFileOwnerName)); err != nil {
		t.Fatalf("remove owner: %v", err)
	}
	if err := os.WriteFile(filepath.Join(path, "unexpected"), []byte("x"), 0o600); err != nil {
		t.Fatalf("seed unexpected: %v", err)
	}
	inspection, err := InspectLocalFileLock(path)
	if err != nil || inspection.State != LocalFileLockCompromised {
		t.Fatalf("dirty inspection: %#v err=%v", inspection, err)
	}
}

func TestLocalFileLockInspectionOversizedPersistedOwnerIsCompromised(t *testing.T) {
	path := filepath.Join(t.TempDir(), "install.lock")
	lock, acquired, err := TryAcquireLocalFileLock(path, "owner-a")
	if err != nil || !acquired {
		t.Fatalf("acquire: acquired=%v err=%v", acquired, err)
	}
	lock.released = true
	if err := os.WriteFile(filepath.Join(path, localFileOwnerName), []byte(strings.Repeat("😀", 513)), 0o600); err != nil {
		t.Fatalf("replace owner: %v", err)
	}
	inspection, err := InspectLocalFileLock(path)
	if err != nil || inspection.State != LocalFileLockCompromised {
		t.Fatalf("oversized owner inspection: %#v err=%v", inspection, err)
	}
}

func TestLocalFileLockRecoveryRequiresConfirmationAndOwner(t *testing.T) {
	path := filepath.Join(t.TempDir(), "install.lock")
	lock, acquired, err := TryAcquireLocalFileLock(path, "owner-a")
	if err != nil || !acquired {
		t.Fatalf("acquire: acquired=%v err=%v", acquired, err)
	}
	lock.released = true

	_, err = RecoverLocalFileLock(path, "owner-a", false)
	var lockErr *LocalFileLockError
	if !errors.As(err, &lockErr) || lockErr.Kind != LocalFileInvalidInput {
		t.Fatalf("unconfirmed recovery: %#v", err)
	}
	_, err = RecoverLocalFileLock(path, "owner-b", true)
	if !errors.As(err, &lockErr) || lockErr.Kind != LocalFileCompromised {
		t.Fatalf("owner mismatch recovery: %#v", err)
	}
	recovered, err := RecoverLocalFileLock(path, "owner-a", true)
	if err != nil || !recovered {
		t.Fatalf("clean recovery: recovered=%v err=%v", recovered, err)
	}
}

func TestLocalFileLockRecoveryRejectsOversizedExpectedOwner(t *testing.T) {
	path := filepath.Join(t.TempDir(), "absent.lock")
	_, err := RecoverLocalFileLock(path, strings.Repeat("😀", 513), true)
	var lockErr *LocalFileLockError
	if !errors.As(err, &lockErr) || lockErr.Kind != LocalFileInvalidInput {
		t.Fatalf("oversized expected owner: %#v", err)
	}
}

func TestLocalFileLockRecoveryAbsentNoopAndDirtyFailsClosed(t *testing.T) {
	root := t.TempDir()
	absent := filepath.Join(root, "absent.lock")
	recovered, err := RecoverLocalFileLock(absent, "owner-a", true)
	if err != nil || recovered {
		t.Fatalf("absent recovery: recovered=%v err=%v", recovered, err)
	}

	path := filepath.Join(root, "dirty.lock")
	lock, acquired, err := TryAcquireLocalFileLock(path, "owner-a")
	if err != nil || !acquired {
		t.Fatalf("acquire: acquired=%v err=%v", acquired, err)
	}
	lock.released = true
	unexpected := filepath.Join(path, "unexpected")
	if err := os.WriteFile(unexpected, []byte("do not delete"), 0o600); err != nil {
		t.Fatalf("seed unexpected: %v", err)
	}
	_, err = RecoverLocalFileLock(path, "owner-a", true)
	var lockErr *LocalFileLockError
	if !errors.As(err, &lockErr) || lockErr.Kind != LocalFileCompromised {
		t.Fatalf("dirty recovery: %#v", err)
	}
	if _, statErr := os.Stat(unexpected); statErr != nil {
		t.Fatalf("unexpected entry was removed: %v", statErr)
	}
}
