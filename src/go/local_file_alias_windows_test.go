//go:build windows

package oreslocks

import (
	"os"
	"syscall"
	"testing"
	"time"
)

type syntheticWindowsFileInfo struct {
	attributes uint32
}

func (syntheticWindowsFileInfo) Name() string       { return "synthetic" }
func (syntheticWindowsFileInfo) Size() int64        { return 0 }
func (syntheticWindowsFileInfo) Mode() os.FileMode  { return os.ModeDir }
func (syntheticWindowsFileInfo) ModTime() time.Time { return time.Time{} }
func (syntheticWindowsFileInfo) IsDir() bool        { return true }
func (f syntheticWindowsFileInfo) Sys() any {
	return &syscall.Win32FileAttributeData{FileAttributes: f.attributes}
}

func TestLocalFileLockDetectsWindowsReparsePoint(t *testing.T) {
	reparse := syntheticWindowsFileInfo{attributes: syscall.FILE_ATTRIBUTE_REPARSE_POINT}
	if !localFileInfoIsPlatformAlias(reparse) {
		t.Fatal("Windows reparse point must be treated as an alias")
	}
	plain := syntheticWindowsFileInfo{}
	if localFileInfoIsPlatformAlias(plain) {
		t.Fatal("plain Windows directory metadata must not be treated as an alias")
	}
}
