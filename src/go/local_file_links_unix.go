//go:build unix

package oreslocks

import (
	"os"
	"syscall"
)

func localFileHasMultipleLinks(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Nlink != 1
}
