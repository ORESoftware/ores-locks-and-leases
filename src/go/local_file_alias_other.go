//go:build !windows

package oreslocks

import "os"

func localFileInfoIsPlatformAlias(_ os.FileInfo) bool {
	return false
}
