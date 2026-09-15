//go:build !linux && !darwin

package oreslocks

import "os"

func localFileInfoHasMultipleHardLinks(_ os.FileInfo) bool {
	return false
}
