package oreslocks

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"unicode/utf8"
)

// LocalFileLockInspectionState describes read-only portable-lock state.
type LocalFileLockInspectionState string

const (
	LocalFileLockAbsent      LocalFileLockInspectionState = "absent"
	LocalFileLockHeld        LocalFileLockInspectionState = "held"
	LocalFileLockIncomplete  LocalFileLockInspectionState = "incomplete"
	LocalFileLockCompromised LocalFileLockInspectionState = "compromised"
)

// LocalFileLockInspection is diagnostic evidence only; it never claims ownership.
type LocalFileLockInspection struct {
	State   LocalFileLockInspectionState
	Owner   string
	Message string
}

// InspectLocalFileLock reports portable-lock shape without mutating it.
func InspectLocalFileLock(path string) (LocalFileLockInspection, error) {
	if err := validateLocalPath(path); err != nil {
		return LocalFileLockInspection{}, err
	}
	info, err := os.Lstat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return LocalFileLockInspection{State: LocalFileLockAbsent}, nil
		}
		return LocalFileLockInspection{}, localFileError(LocalFileIO, path, "inspect local lock path failed", err)
	}
	if !info.IsDir() || localFileInfoIsAlias(info) {
		return compromisedInspection("lock path is not an unaliased directory"), nil
	}
	if err := validateLocalPOSIXPrivateMode(path, info, "lock directory", 0o022); err != nil {
		return compromisedInspection(err.Error()), nil
	}

	// Two names are enough to distinguish empty, exactly-owner, and dirty.
	// Never enumerate an arbitrarily large attacker-expanded directory.
	dir, err := os.Open(path)
	if err != nil {
		return LocalFileLockInspection{}, localFileError(LocalFileIO, path, "open local lock directory failed", err)
	}
	entries, readErr := dir.Readdirnames(2)
	closeErr := dir.Close()
	if readErr != nil && !errors.Is(readErr, io.EOF) {
		return LocalFileLockInspection{}, localFileError(LocalFileIO, path, "list local lock directory failed", readErr)
	}
	if closeErr != nil {
		return LocalFileLockInspection{}, localFileError(LocalFileIO, path, "close local lock directory failed", closeErr)
	}
	if len(entries) == 0 {
		return incompleteInspection("lock directory has no owner marker; acquisition or release may have crashed mid-transition"), nil
	}
	if len(entries) != 1 || entries[0] != localFileOwnerName {
		return compromisedInspection("lock directory must contain exactly one owner marker"), nil
	}

	ownerPath := filepath.Join(path, localFileOwnerName)
	owner, err := readBoundedLocalFileLockOwner(path, ownerPath)
	if err != nil {
		var localErr *LocalFileLockError
		if errors.As(err, &localErr) && localErr.Kind == LocalFileCompromised && errors.Is(localErr.Cause, os.ErrNotExist) {
			return incompleteInspection("owner token disappeared during inspection"), nil
		}
		if errors.As(err, &localErr) && localErr.Kind == LocalFileCompromised {
			return compromisedInspection(localErr.Message), nil
		}
		return LocalFileLockInspection{}, err
	}
	if len(owner) == 0 {
		return compromisedInspection("owner token is empty"), nil
	}
	if !utf8.Valid(owner) {
		return compromisedInspection("owner token is not valid UTF-8"), nil
	}
	if utf8.RuneCount(owner) > localFileOwnerMaxCodepoints {
		return compromisedInspection("owner token exceeds the portable 512-code-point contract bound"), nil
	}
	return LocalFileLockInspection{State: LocalFileLockHeld, Owner: string(owner)}, nil
}

// readBoundedLocalFileLockOwner validates both the path identity and the
// already-open handle identity, then reads no more than the derived storage
// ceiling plus one byte. It is shared by inspection and normal release.
func readBoundedLocalFileLockOwner(lockPath, ownerPath string) ([]byte, error) {
	pathInfo, err := os.Lstat(ownerPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, localFileError(LocalFileCompromised, lockPath, "owner token is missing", err)
		}
		return nil, localFileError(LocalFileIO, lockPath, "inspect local lock owner token failed", err)
	}
	if !pathInfo.Mode().IsRegular() || localFileInfoIsAlias(pathInfo) {
		return nil, localFileError(LocalFileCompromised, lockPath, "owner token is not an unaliased regular file", nil)
	}
	if localFileInfoHasMultipleHardLinks(pathInfo) {
		return nil, localFileError(LocalFileCompromised, lockPath, "owner token has multiple hard links; refusing aliased ownership state", nil)
	}
	if err := validateLocalPOSIXPrivateMode(lockPath, pathInfo, "owner token", 0o077); err != nil {
		return nil, err
	}
	if pathInfo.Size() > int64(localFileOwnerMaxUTF8Bytes) {
		return nil, localFileError(LocalFileCompromised, lockPath, "owner token exceeds the portable 2048-byte UTF-8 storage bound", nil)
	}

	ownerFile, err := os.Open(ownerPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, localFileError(LocalFileCompromised, lockPath, "owner token is missing", err)
		}
		return nil, localFileError(LocalFileIO, lockPath, "open local lock owner token failed", err)
	}
	defer ownerFile.Close()
	openedInfo, err := ownerFile.Stat()
	if err != nil {
		return nil, localFileError(LocalFileIO, lockPath, "stat opened local lock owner token failed", err)
	}
	if !openedInfo.Mode().IsRegular() || !os.SameFile(pathInfo, openedInfo) {
		return nil, localFileError(LocalFileCompromised, lockPath, "owner token identity changed while opening; refusing raced path-to-handle state", nil)
	}
	if localFileInfoHasMultipleHardLinks(openedInfo) {
		return nil, localFileError(LocalFileCompromised, lockPath, "opened owner token has multiple hard links; refusing aliased ownership state", nil)
	}
	if err := validateLocalPOSIXPrivateMode(lockPath, openedInfo, "opened owner token", 0o077); err != nil {
		return nil, err
	}
	if openedInfo.Size() > int64(localFileOwnerMaxUTF8Bytes) {
		return nil, localFileError(LocalFileCompromised, lockPath, "owner token exceeds the portable 2048-byte UTF-8 storage bound", nil)
	}

	owner, readErr := io.ReadAll(io.LimitReader(ownerFile, localFileOwnerMaxUTF8Bytes+1))
	if readErr != nil {
		return nil, localFileError(LocalFileIO, lockPath, "read local lock owner token failed", readErr)
	}
	if len(owner) > localFileOwnerMaxUTF8Bytes {
		return nil, localFileError(LocalFileCompromised, lockPath, "owner token exceeds the portable 2048-byte UTF-8 storage bound", nil)
	}
	if !utf8.Valid(owner) {
		return nil, localFileError(LocalFileCompromised, lockPath, "owner token is not valid UTF-8", nil)
	}
	return owner, nil
}

// RecoverLocalFileLock explicitly removes one clean portable lock after the
// operator independently confirms the former owner is inactive and local state
// is quiescent. An absent lock is an idempotent false/no-op result. Incomplete
// ownerless crash-window state is never auto-recovered because owner identity
// can no longer be authenticated.
func RecoverLocalFileLock(path, expectedOwner string, confirmedInactive bool) (bool, error) {
	if err := validateLocalPath(path); err != nil {
		return false, err
	}
	if !confirmedInactive {
		return false, localFileError(LocalFileInvalidInput, path, "explicit confirmed_inactive=true is required for recovery", nil)
	}
	if err := validateLocalOwner(path, expectedOwner); err != nil {
		return false, err
	}

	inspection, err := InspectLocalFileLock(path)
	if err != nil {
		return false, err
	}
	switch inspection.State {
	case LocalFileLockAbsent:
		return false, nil
	case LocalFileLockIncomplete:
		return false, localFileError(LocalFileCompromised, path, "incomplete lock state has no owner identity; refusing automatic recovery", nil)
	case LocalFileLockCompromised:
		return false, localFileError(LocalFileCompromised, path, inspection.Message, nil)
	}
	if inspection.Owner != expectedOwner {
		return false, localFileError(LocalFileCompromised, path, "owner token does not match expected recovery owner", nil)
	}

	finalInspection, err := InspectLocalFileLock(path)
	if err != nil {
		return false, err
	}
	if finalInspection.State != LocalFileLockHeld || finalInspection.Owner != expectedOwner {
		return false, localFileError(LocalFileCompromised, path, "local lock changed during recovery; refusing deletion", nil)
	}

	ownerPath := filepath.Join(path, localFileOwnerName)
	if err := os.Remove(ownerPath); err != nil {
		return false, localFileError(LocalFileIO, path, "remove recovered owner token failed", err)
	}
	if err := os.Remove(path); err != nil {
		kind := LocalFileIO
		if dir, openErr := os.Open(path); openErr == nil {
			names, readErr := dir.Readdirnames(1)
			_ = dir.Close()
			if readErr == nil && len(names) > 0 {
				kind = LocalFileCompromised
			}
		}
		return false, localFileError(kind, path, "remove recovered lock directory failed", err)
	}
	return true, nil
}

func incompleteInspection(message string) LocalFileLockInspection {
	return LocalFileLockInspection{State: LocalFileLockIncomplete, Message: message}
}

func compromisedInspection(message string) LocalFileLockInspection {
	return LocalFileLockInspection{State: LocalFileLockCompromised, Message: message}
}
