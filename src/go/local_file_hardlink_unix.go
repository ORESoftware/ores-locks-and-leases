//go:build linux || darwin

package oreslocks

import (
	"os"
	"syscall"
)

func localFileInfoHasMultipleHardLinks(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Nlink != 1
}
