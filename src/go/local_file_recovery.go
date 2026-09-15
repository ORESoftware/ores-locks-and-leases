package oreslocks

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
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

// LocalFileLockInspectionReason is a stable machine-readable diagnostic code.
type LocalFileLockInspectionReason string

const (
	LocalFileOwnerMarkerMissing     LocalFileLockInspectionReason = "owner_marker_missing"
	LocalFilePathNotDirectory       LocalFileLockInspectionReason = "path_not_directory"
	LocalFileDirtyDirectory         LocalFileLockInspectionReason = "dirty_directory"
	LocalFileOwnerNotRegularFile    LocalFileLockInspectionReason = "owner_not_regular_file"
	LocalFileOwnerTooLarge          LocalFileLockInspectionReason = "owner_too_large"
	LocalFileOwnerInvalidUTF8       LocalFileLockInspectionReason = "owner_invalid_utf8"
	LocalFileOwnerIdentityChanged   LocalFileLockInspectionReason = "owner_identity_changed"
	LocalFilePermissionsWidened     LocalFileLockInspectionReason = "permissions_widened"
	LocalFileOwnerContractViolation LocalFileLockInspectionReason = "owner_contract_violation"
)

// LocalFileLockInspection is diagnostic evidence only; it never claims ownership.
type LocalFileLockInspection struct {
	State   LocalFileLockInspectionState
	Owner   string
	Reason  LocalFileLockInspectionReason
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
		return compromisedInspection(LocalFilePathNotDirectory, "lock path is not an unaliased directory"), nil
	}
	if err := validateLocalPOSIXPrivateMode(path, info, "lock directory", 0o022); err != nil {
		return compromisedInspection(LocalFilePermissionsWidened, err.Error()), nil
	}

	// Two names are enough to distinguish empty, pending publication, exactly
	// one published owner, and dirty state. Never enumerate an arbitrarily large
	// attacker-expanded directory.
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
	if len(entries) == 1 && entries[0] == localFileOwnerPendingName {
		return incompleteInspection("owner publication is incomplete; pending owner marker is not ownership authority"), nil
	}
	if len(entries) != 1 || entries[0] != localFileOwnerName {
		return compromisedInspection(LocalFileDirtyDirectory, "lock directory must contain exactly one published owner marker"), nil
	}

	ownerPath := filepath.Join(path, localFileOwnerName)
	owner, err := readBoundedLocalFileLockOwner(path, ownerPath)
	if err != nil {
		var localErr *LocalFileLockError
		if errors.As(err, &localErr) && localErr.Kind == LocalFileCompromised && errors.Is(localErr.Cause, os.ErrNotExist) {
			return incompleteInspection("owner token disappeared during inspection"), nil
		}
		if errors.As(err, &localErr) && localErr.Kind == LocalFileCompromised {
			return compromisedInspection(reasonFromLocalOwnerError(localErr.Message), localErr.Message), nil
		}
		return LocalFileLockInspection{}, err
	}
	if len(owner) == 0 {
		return compromisedInspection(LocalFileOwnerContractViolation, "owner token is empty"), nil
	}
	if !utf8.Valid(owner) {
		return compromisedInspection(LocalFileOwnerInvalidUTF8, "owner token is not valid UTF-8"), nil
	}
	if utf8.RuneCount(owner) > localFileOwnerMaxCodepoints {
		return compromisedInspection(LocalFileOwnerContractViolation, "owner token exceeds the portable 512-code-point contract bound"), nil
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
	if localFileHasMultipleLinks(pathInfo) {
		return nil, localFileError(LocalFileCompromised, lockPath, "owner token has multiple filesystem links; refusing aliased ownership state", nil)
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
	if !openedInfo.Mode().IsRegular() || !os.SameFile(pathInfo, openedInfo) || localFileHasMultipleLinks(openedInfo) {
		return nil, localFileError(LocalFileCompromised, lockPath, "owner token identity changed or became multiply linked while opening; refusing raced path-to-handle state", nil)
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
	return LocalFileLockInspection{
		State:   LocalFileLockIncomplete,
		Reason:  LocalFileOwnerMarkerMissing,
		Message: message,
	}
}

func compromisedInspection(reason LocalFileLockInspectionReason, message string) LocalFileLockInspection {
	return LocalFileLockInspection{State: LocalFileLockCompromised, Reason: reason, Message: message}
}

func reasonFromLocalOwnerError(message string) LocalFileLockInspectionReason {
	switch {
	case strings.Contains(message, "multiple filesystem links"), strings.Contains(message, "identity changed"):
		return LocalFileOwnerIdentityChanged
	case strings.Contains(message, "not an unaliased regular file"):
		return LocalFileOwnerNotRegularFile
	case strings.Contains(message, "2048-byte"):
		return LocalFileOwnerTooLarge
	case strings.Contains(message, "not valid UTF-8"):
		return LocalFileOwnerInvalidUTF8
	case strings.Contains(message, "permissions widened"):
		return LocalFilePermissionsWidened
	default:
		return LocalFileOwnerContractViolation
	}
}
