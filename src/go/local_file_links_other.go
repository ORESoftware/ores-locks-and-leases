//go:build !(aix || darwin || dragonfly || freebsd || linux || netbsd || openbsd || solaris)

package oreslocks

import "os"

// The portable Go layer only enforces hard-link count when the target exposes
// a stable link count through the Unix Stat_t surface. Other platforms still
// retain path/handle identity and alias checks.
func localFileHasMultipleLinks(info os.FileInfo) bool {
	return false
}
