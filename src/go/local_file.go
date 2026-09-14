package oreslocks

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const localFileOwnerName = "owner"

// LocalFileLockErrorKind classifies failures from the portable single-host
// filesystem backend.
type LocalFileLockErrorKind string

const (
	LocalFileContention   LocalFileLockErrorKind = "contention"
	LocalFileTimeout      LocalFileLockErrorKind = "timeout"
	LocalFileCompromised  LocalFileLockErrorKind = "compromised"
	LocalFileIO           LocalFileLockErrorKind = "io"
	LocalFileInvalidInput LocalFileLockErrorKind = "invalid_input"
)

// LocalFileLockError is a structured failure from the portable local backend.
type LocalFileLockError struct {
	Kind    LocalFileLockErrorKind
	Path    string
	Message string
	Cause   error
}

func (e *LocalFileLockError) Error() string {
	return fmt.Sprintf("local filesystem lock %s at %q: %s", e.Kind, e.Path, e.Message)
}

func (e *LocalFileLockError) Unwrap() error { return e.Cause }

// LocalFileLockOptions configures AcquireLocalFileLock.
type LocalFileLockOptions struct {
	Wait          bool
	WaitTimeout   time.Duration
	RetryInterval time.Duration
}

// DefaultLocalFileLockOptions returns the cross-runtime convenience defaults.
func DefaultLocalFileLockOptions() LocalFileLockOptions {
	return LocalFileLockOptions{
		Wait:          true,
		WaitTimeout:   30 * time.Second,
		RetryInterval: 50 * time.Millisecond,
	}
}

// LocalFileLock is a held portable filesystem lock. Atomic directory creation
// is the admission authority; the owner file is diagnostics plus an owner-safe
// release token and is never a stale PID authority.
type LocalFileLock struct {
	path     string
	owner    string
	mu       sync.Mutex
	released bool
}

func (l *LocalFileLock) Path() string  { return l.path }
func (l *LocalFileLock) Owner() string { return l.owner }

// TryAcquireLocalFileLock makes one immediate atomic attempt. acquired=false
// with a nil error means ordinary contention.
func TryAcquireLocalFileLock(path, owner string) (lock *LocalFileLock, acquired bool, err error) {
	if owner == "" {
		return nil, false, localFileError(LocalFileInvalidInput, path, "owner token must not be empty", nil)
	}

	parent := filepath.Dir(path)
	if parent != "." && parent != "" {
		if err := os.MkdirAll(parent, 0o700); err != nil {
			return nil, false, localFileError(LocalFileIO, path, "create lock parent failed", err)
		}
	}

	if err := os.Mkdir(path, 0o700); err != nil {
		if errors.Is(err, os.ErrExist) {
			info, inspectErr := os.Lstat(path)
			if inspectErr != nil {
				return nil, false, localFileError(LocalFileIO, path, "inspect contended local lock path failed", inspectErr)
			}
			if info.IsDir() {
				return nil, false, nil
			}
			return nil, false, localFileError(LocalFileCompromised, path, "lock path already exists but is not a directory", err)
		}
		return nil, false, localFileError(LocalFileIO, path, "atomically create local lock directory failed", err)
	}

	ownerPath := filepath.Join(path, localFileOwnerName)
	if err := os.WriteFile(ownerPath, []byte(owner), 0o600); err != nil {
		_ = os.Remove(path)
		return nil, false, localFileError(LocalFileIO, path, "write local lock owner token failed", err)
	}

	return &LocalFileLock{path: path, owner: owner}, true, nil
}

// AcquireLocalFileLock acquires with optional finite waiting. This portable
// backend retries mkdir; zed-pkg's native Rust lock should keep one
// kernel-backed blocking request instead.
func AcquireLocalFileLock(path, owner string, options LocalFileLockOptions) (*LocalFileLock, error) {
	if owner == "" {
		return nil, localFileError(LocalFileInvalidInput, path, "owner token must not be empty", nil)
	}
	if options.WaitTimeout < 0 {
		return nil, localFileError(LocalFileInvalidInput, path, "wait timeout must not be negative", nil)
	}
	if options.Wait && options.RetryInterval <= 0 {
		return nil, localFileError(LocalFileInvalidInput, path, "retry interval must be greater than zero when waiting", nil)
	}

	started := time.Now()
	for {
		lock, acquired, err := TryAcquireLocalFileLock(path, owner)
		if err != nil {
			return nil, err
		}
		if acquired {
			return lock, nil
		}
		if !options.Wait {
			return nil, localFileError(LocalFileContention, path, "lock is already held by another owner", nil)
		}

		elapsed := time.Since(started)
		if elapsed >= options.WaitTimeout {
			return nil, localFileError(
				LocalFileTimeout,
				path,
				fmt.Sprintf("timed out after %d ms waiting for local lock", options.WaitTimeout.Milliseconds()),
				nil,
			)
		}

		remaining := options.WaitTimeout - elapsed
		delay := options.RetryInterval
		if delay > remaining {
			delay = remaining
		}
		time.Sleep(delay)
	}
}

// Release verifies the owner token before removing the now-empty lock
// directory. It is idempotent after a successful release.
func (l *LocalFileLock) Release() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.released {
		return nil
	}

	ownerPath := filepath.Join(l.path, localFileOwnerName)
	observed, err := os.ReadFile(ownerPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return localFileError(LocalFileCompromised, l.path, "owner token is missing; refusing to treat externally altered lock state as a successful release", err)
		}
		return localFileError(LocalFileIO, l.path, "read local lock owner token failed", err)
	}
	if string(observed) != l.owner {
		return localFileError(
			LocalFileCompromised,
			l.path,
			"owner token changed; refusing to remove a lock that may belong to another acquisition",
			nil,
		)
	}

	if err := os.Remove(ownerPath); err != nil {
		return localFileError(LocalFileIO, l.path, "remove local lock owner token failed", err)
	}
	if err := os.Remove(l.path); err != nil {
		kind := LocalFileIO
		// Do not depend on platform-specific errno values here. If the directory
		// is still readable and contains an unexpected entry, ownership has been
		// compromised and recursive cleanup would be unsafe.
		if entries, readErr := os.ReadDir(l.path); readErr == nil && len(entries) > 0 {
			kind = LocalFileCompromised
		}
		return localFileError(kind, l.path, "remove local lock directory failed", err)
	}
	l.released = true
	return nil
}

// LocalFileLockExists is diagnostics only; callers must still acquire before
// treating themselves as owner.
func LocalFileLockExists(path string) (bool, error) {
	info, err := os.Stat(path)
	if err == nil {
		return info.IsDir(), nil
	}
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return false, localFileError(LocalFileIO, path, "inspect local lock path failed", err)
}

func localFileError(kind LocalFileLockErrorKind, path, message string, cause error) *LocalFileLockError {
	return &LocalFileLockError{Kind: kind, Path: path, Message: message, Cause: cause}
}
