package oreslocks

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLocalFileReleaseBoundsPersistedOwner(t *testing.T) {
	for _, tc := range []struct {
		name string
		data []byte
	}{
		{name: "oversized", data: []byte(string(make([]byte, 0)))},
		{name: "invalid-utf8", data: []byte{0xff}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "install.lock")
			lock, acquired, err := TryAcquireLocalFileLock(path, "owner-a")
			if err != nil || !acquired {
				t.Fatalf("acquire: acquired=%v err=%v", acquired, err)
			}
			data := tc.data
			if tc.name == "oversized" {
				data = make([]byte, localFileOwnerMaxUTF8Bytes+1)
				for i := range data {
					data[i] = 'a'
				}
			}
			if err := os.WriteFile(filepath.Join(path, localFileOwnerName), data, 0o600); err != nil {
				t.Fatal(err)
			}
			err = lock.Release()
			var localErr *LocalFileLockError
			if err == nil || !errorsAsLocalFile(err, &localErr) || localErr.Kind != LocalFileCompromised {
				t.Fatalf("expected compromised release, got %v", err)
			}
		})
	}
}

func errorsAsLocalFile(err error, target **LocalFileLockError) bool {
	local, ok := err.(*LocalFileLockError)
	if !ok {
		return false
	}
	*target = local
	return true
}
