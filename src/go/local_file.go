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
		if err := validateLocalRealDirectory(path, parent, "lock parent"); err != nil {
			return nil, false, err
		}
	}

	if err := os.Mkdir(path, 0o700); err != nil {
		if errors.Is(err, os.ErrExist) {
			info, inspectErr := os.Lstat(path)
			if inspectErr != nil {
				return nil, false, localFileError(LocalFileIO, path, "inspect contended local lock path failed", inspectErr)
			}
			if info.IsDir() && !localFileInfoIsAlias(info) {
				return nil, false, nil
			}
			return nil, false, localFileError(LocalFileCompromised, path, "lock path already exists but is not an unaliased directory", err)
		}
		return nil, false, localFileError(LocalFileIO, path, "atomically create local lock directory failed", err)
	}

	ownerPath := filepath.Join(path, localFileOwnerName)
	ownerFile, openErr := os.OpenFile(ownerPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if openErr != nil {
		_ = os.Remove(path)
		kind := LocalFileIO
		if errors.Is(openErr, os.ErrExist) {
			kind = LocalFileCompromised
		}
		return nil, false, localFileError(kind, path, "create local lock owner token failed", openErr)
	}
	_, writeErr := ownerFile.WriteString(owner)
	closeErr := ownerFile.Close()
	if writeErr != nil || closeErr != nil {
		_ = os.Remove(ownerPath)
		_ = os.Remove(path)
		if writeErr != nil {
			return nil, false, localFileError(LocalFileIO, path, "write local lock owner token failed", writeErr)
		}
		return nil, false, localFileError(LocalFileIO, path, "close local lock owner token failed", closeErr)
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
	if err := validateLocalRealDirectory(l.path, l.path, "lock directory"); err != nil {
		return err
	}

	ownerPath := filepath.Join(l.path, localFileOwnerName)
	if err := validateLocalRegularFile(l.path, ownerPath, "owner token"); err != nil {
		return err
	}
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
	info, err := os.Lstat(path)
	if err == nil {
		if info.IsDir() && !localFileInfoIsAlias(info) {
			return true, nil
		}
		return false, localFileError(LocalFileCompromised, path, "lock path exists but is not an unaliased directory", nil)
	}
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return false, localFileError(LocalFileIO, path, "inspect local lock path failed", err)
}

func validateLocalRealDirectory(lockPath, path, label string) error {
	info, err := os.Lstat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return localFileError(LocalFileCompromised, lockPath, label+" is missing", err)
		}
		return localFileError(LocalFileIO, lockPath, "inspect "+label+" failed", err)
	}
	if !info.IsDir() || localFileInfoIsAlias(info) {
		return localFileError(LocalFileCompromised, lockPath, label+" is not an unaliased directory", nil)
	}
	return nil
}

func validateLocalRegularFile(lockPath, path, label string) error {
	info, err := os.Lstat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return localFileError(LocalFileCompromised, lockPath, label+" is missing", err)
		}
		return localFileError(LocalFileIO, lockPath, "inspect "+label+" failed", err)
	}
	if !info.Mode().IsRegular() || localFileInfoIsAlias(info) {
		return localFileError(LocalFileCompromised, lockPath, label+" is not an unaliased regular file", nil)
	}
	return nil
}

func localFileInfoIsAlias(info os.FileInfo) bool {
	return info.Mode()&os.ModeSymlink != 0
}

func localFileError(kind LocalFileLockErrorKind, path, message string, cause error) *LocalFileLockError {
	return &LocalFileLockError{Kind: kind, Path: path, Message: message, Cause: cause}
}
