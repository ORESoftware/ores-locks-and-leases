package oreslocks

import (
	"errors"
	"os"
	"path/filepath"
)

// LocalFileLockInspectionState describes read-only portable-lock state.
type LocalFileLockInspectionState string

const (
	LocalFileLockAbsent      LocalFileLockInspectionState = "absent"
	LocalFileLockHeld        LocalFileLockInspectionState = "held"
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

	entries, err := os.ReadDir(path)
	if err != nil {
		return LocalFileLockInspection{}, localFileError(LocalFileIO, path, "list local lock directory failed", err)
	}
	if len(entries) != 1 || entries[0].Name() != localFileOwnerName {
		return compromisedInspection("lock directory must contain exactly one owner marker"), nil
	}

	ownerPath := filepath.Join(path, localFileOwnerName)
	ownerInfo, err := os.Lstat(ownerPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return compromisedInspection("owner token is missing"), nil
		}
		return LocalFileLockInspection{}, localFileError(LocalFileIO, path, "inspect local lock owner token failed", err)
	}
	if !ownerInfo.Mode().IsRegular() || localFileInfoIsAlias(ownerInfo) {
		return compromisedInspection("owner token is not an unaliased regular file"), nil
	}
	owner, err := os.ReadFile(ownerPath)
	if err != nil {
		return LocalFileLockInspection{}, localFileError(LocalFileIO, path, "read local lock owner token failed", err)
	}
	if len(owner) == 0 {
		return compromisedInspection("owner token is empty"), nil
	}
	return LocalFileLockInspection{State: LocalFileLockHeld, Owner: string(owner)}, nil
}

// RecoverLocalFileLock explicitly removes one clean portable lock after the
// operator independently confirms the former owner is inactive and local state
// is quiescent. An absent lock is an idempotent false/no-op result.
func RecoverLocalFileLock(path, expectedOwner string, confirmedInactive bool) (bool, error) {
	if !confirmedInactive {
		return false, localFileError(LocalFileInvalidInput, path, "explicit confirmed_inactive=true is required for recovery", nil)
	}
	if expectedOwner == "" {
		return false, localFileError(LocalFileInvalidInput, path, "expected owner must not be empty", nil)
	}

	inspection, err := InspectLocalFileLock(path)
	if err != nil {
		return false, err
	}
	switch inspection.State {
	case LocalFileLockAbsent:
		return false, nil
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
		if entries, readErr := os.ReadDir(path); readErr == nil && len(entries) > 0 {
			kind = LocalFileCompromised
		}
		return false, localFileError(kind, path, "remove recovered lock directory failed", err)
	}
	return true, nil
}

func compromisedInspection(message string) LocalFileLockInspection {
	return LocalFileLockInspection{State: LocalFileLockCompromised, Message: message}
}
