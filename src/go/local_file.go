package oreslocks

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const localFileOwnerName = "owner"
const localFileOwnerPendingName = "owner.pending"
const localFileOwnerMaxCodepoints = 512
const localFileOwnerMaxUTF8Bytes = localFileOwnerMaxCodepoints * 4

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

// GeneratedLocalFileLockOwner returns a fresh OS-CSPRNG-backed owner identity.
// It deliberately has no PID/time fallback because a weak fallback would turn
// an entropy failure into an ownership-identity failure.
func GeneratedLocalFileLockOwner() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", fmt.Errorf("generate local lock owner identity: %w", err)
	}
	return "ores-locks-" + hex.EncodeToString(raw[:]), nil
}

// LocalFileLock is a held portable filesystem lock. Atomic directory creation
// is the admission authority; the owner file is diagnostics plus an owner-safe
// release token and is never a stale PID authority.
type LocalFileLock struct {
	path       string
	owner      string
	mu         sync.Mutex
	released   bool
	releaseErr error
}

func (l *LocalFileLock) Path() string  { return l.path }
func (l *LocalFileLock) Owner() string { return l.owner }

// TryAcquireLocalFileLock makes one immediate atomic attempt. acquired=false
// with a nil error means ordinary contention.
func TryAcquireLocalFileLock(path, owner string) (lock *LocalFileLock, acquired bool, err error) {
	if err := validateLocalPath(path); err != nil {
		return nil, false, err
	}
	if err := validateLocalOwner(path, owner); err != nil {
		return nil, false, err
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

	created := false
	for transitionAttempt := 0; transitionAttempt < 2; transitionAttempt++ {
		mkdirErr := os.Mkdir(path, 0o700)
		if mkdirErr == nil {
			created = true
			break
		}
		if !errors.Is(mkdirErr, os.ErrExist) {
			return nil, false, localFileError(LocalFileIO, path, "atomically create local lock directory failed", mkdirErr)
		}

		info, inspectErr := os.Lstat(path)
		if inspectErr != nil {
			if errors.Is(inspectErr, os.ErrNotExist) {
				if transitionAttempt == 0 {
					continue
				}
				return nil, false, nil
			}
			return nil, false, localFileError(LocalFileIO, path, "inspect contended local lock path failed", inspectErr)
		}
		if info.IsDir() && !localFileInfoIsAlias(info) {
			if err := validateLocalPOSIXPrivateMode(path, info, "lock directory", 0o022); err != nil {
				return nil, false, err
			}
			return nil, false, nil
		}
		return nil, false, localFileError(LocalFileCompromised, path, "lock path already exists but is not an unaliased directory", mkdirErr)
	}
	if !created {
		return nil, false, nil
	}

	ownerPath := filepath.Join(path, localFileOwnerName)
	pendingPath := filepath.Join(path, localFileOwnerPendingName)
	ownerFile, openErr := os.OpenFile(pendingPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if openErr != nil {
		_ = os.Remove(path)
		kind := LocalFileIO
		if errors.Is(openErr, os.ErrExist) {
			kind = LocalFileCompromised
		}
		return nil, false, localFileError(kind, path, "create pending local lock owner token failed", openErr)
	}
	n, writeErr := ownerFile.WriteString(owner)
	if writeErr == nil && n != len(owner) {
		writeErr = io.ErrShortWrite
	}
	syncErr := error(nil)
	if writeErr == nil {
		syncErr = ownerFile.Sync()
	}
	closeErr := ownerFile.Close()
	if writeErr != nil || syncErr != nil || closeErr != nil {
		_ = os.Remove(pendingPath)
		_ = os.Remove(path)
		if writeErr != nil {
			return nil, false, localFileError(LocalFileIO, path, "write pending local lock owner token failed", writeErr)
		}
		if syncErr != nil {
			return nil, false, localFileError(LocalFileIO, path, "sync pending local lock owner token failed", syncErr)
		}
		return nil, false, localFileError(LocalFileIO, path, "close pending local lock owner token failed", closeErr)
	}
	if _, statErr := os.Lstat(ownerPath); statErr == nil {
		_ = os.Remove(pendingPath)
		_ = os.Remove(path)
		return nil, false, localFileError(LocalFileCompromised, path, "published owner target already exists before atomic publication", nil)
	} else if !errors.Is(statErr, os.ErrNotExist) {
		_ = os.Remove(pendingPath)
		_ = os.Remove(path)
		return nil, false, localFileError(LocalFileIO, path, "inspect owner publication target failed", statErr)
	}
	if renameErr := os.Rename(pendingPath, ownerPath); renameErr != nil {
		_ = os.Remove(pendingPath)
		_ = os.Remove(path)
		return nil, false, localFileError(LocalFileIO, path, "atomically publish local lock owner token failed", renameErr)
	}

	return &LocalFileLock{path: path, owner: owner}, true, nil
}

// AcquireLocalFileLock acquires with optional finite waiting. The wait budget
// is end-to-end: time spent in filesystem attempts counts toward WaitTimeout.
// This portable backend retries mkdir; zed-pkg's native Rust lock should keep
// one kernel-backed blocking request instead.
func AcquireLocalFileLock(path, owner string, options LocalFileLockOptions) (*LocalFileLock, error) {
	if err := validateLocalPath(path); err != nil {
		return nil, err
	}
	if err := validateLocalOwner(path, owner); err != nil {
		return nil, err
	}
	if err := validateLocalOptions(path, options); err != nil {
		return nil, err
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
// directory. It is idempotent after a successful release. If owner removal
// succeeds but directory removal fails, the original destructive-transition
// error is retained and returned by every later Release call.
func (l *LocalFileLock) Release() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.released {
		return nil
	}
	if l.releaseErr != nil {
		return l.releaseErr
	}
	if err := validateLocalRealDirectory(l.path, l.path, "lock directory"); err != nil {
		return err
	}

	ownerPath := filepath.Join(l.path, localFileOwnerName)
	observed, err := readBoundedLocalFileLockOwner(l.path, ownerPath)
	if err != nil {
		return err
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
		if dir, openErr := os.Open(l.path); openErr == nil {
			names, readErr := dir.Readdirnames(1)
			_ = dir.Close()
			if readErr == nil && len(names) > 0 {
				kind = LocalFileCompromised
			}
		}
		wrapped := localFileError(kind, l.path, "remove local lock directory failed", err)
		l.releaseErr = wrapped
		return wrapped
	}
	l.released = true
	return nil
}

// LocalFileLockExists is a compatibility diagnostic. It returns true only for
// a structurally healthy held lock, false only when absent, and fails closed on
// incomplete or compromised state. Prefer InspectLocalFileLock for new code.
func LocalFileLockExists(path string) (bool, error) {
	if err := validateLocalPath(path); err != nil {
		return false, err
	}
	inspection, err := InspectLocalFileLock(path)
	if err != nil {
		return false, err
	}
	switch inspection.State {
	case LocalFileLockAbsent:
		return false, nil
	case LocalFileLockHeld:
		return true, nil
	case LocalFileLockIncomplete:
		return false, localFileError(LocalFileCompromised, path, "local lock is incomplete; boolean existence cannot certify ownership", nil)
	default:
		return false, localFileError(LocalFileCompromised, path, inspection.Message, nil)
	}
}

func validateLocalPath(path string) error {
	if path == "" {
		return localFileError(LocalFileInvalidInput, path, "local lock path must not be empty", nil)
	}
	if strings.IndexByte(path, 0) >= 0 {
		return localFileError(LocalFileInvalidInput, path, "local lock path must not contain NUL bytes", nil)
	}
	if !utf8.ValidString(path) {
		return localFileError(LocalFileInvalidInput, path, "local lock path must be valid UTF-8 Unicode scalar data", nil)
	}
	return nil
}

func validateLocalOwner(path, owner string) error {
	if owner == "" {
		return localFileError(LocalFileInvalidInput, path, "owner token must not be empty", nil)
	}
	if !utf8.ValidString(owner) {
		return localFileError(LocalFileInvalidInput, path, "owner token must be valid UTF-8 Unicode scalar data", nil)
	}
	if utf8.RuneCountInString(owner) > localFileOwnerMaxCodepoints {
		return localFileError(LocalFileInvalidInput, path, "owner token must not exceed 512 Unicode code points", nil)
	}
	return nil
}

func validateLocalOptions(path string, options LocalFileLockOptions) error {
	if options.WaitTimeout < 0 {
		return localFileError(LocalFileInvalidInput, path, "wait timeout must not be negative", nil)
	}
	if options.RetryInterval < 0 {
		return localFileError(LocalFileInvalidInput, path, "retry interval must not be negative", nil)
	}
	if options.Wait && options.RetryInterval == 0 {
		return localFileError(LocalFileInvalidInput, path, "retry interval must be greater than zero when waiting", nil)
	}
	return nil
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
	return validateLocalPOSIXPrivateMode(lockPath, info, label, 0o022)
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
	return validateLocalPOSIXPrivateMode(lockPath, info, label, 0o077)
}

func validateLocalPOSIXPrivateMode(lockPath string, info os.FileInfo, label string, forbidden os.FileMode) error {
	if runtime.GOOS == "windows" {
		return nil
	}
	if info.Mode().Perm()&forbidden != 0 {
		return localFileError(LocalFileCompromised, lockPath, label+" permissions widened beyond the portable private-state policy", nil)
	}
	return nil
}

func localFileInfoIsAlias(info os.FileInfo) bool {
	return info.Mode()&os.ModeSymlink != 0 || localFileInfoIsPlatformAlias(info)
}

func localFileError(kind LocalFileLockErrorKind, path, message string, cause error) *LocalFileLockError {
	return &LocalFileLockError{Kind: kind, Path: path, Message: message, Cause: cause}
}
