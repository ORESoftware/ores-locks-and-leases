// Package oreslocks composes a fiducia-cloud lease around a Postgres advisory
// lock, each layer individually switchable, with fencing tokens threaded
// through to the guarded work. It is the Go slice of
// ORESoftware/ores-locks-and-leases; the Rust, TypeScript, Dart and Gleam
// slices are held to the same conformance/cases/*.json.
//
// Layer order is fixed: fiducia is acquired first and released last, the
// advisory lock sits inside it, and the caller's work is innermost.
package oreslocks

import (
	"fmt"
	"hash/fnv"
)

// MaxLockKeyBytes is the longest key the contract admits.
const MaxLockKeyBytes = 512

// LockKey is a caller-chosen lock identity. Convention: <org>/<domain>/<name>.
type LockKey string

// NewLockKey validates the contract's length bound.
func NewLockKey(key string) (LockKey, error) {
	if len(key) > MaxLockKeyBytes {
		return "", fmt.Errorf("lock key is %d bytes; the contract allows at most %d", len(key), MaxLockKeyBytes)
	}
	return LockKey(key), nil
}

// AdvisoryKey is the bigint a Postgres advisory-lock function receives.
type AdvisoryKey = int64

// FNV1a64 hashes the UTF-8 bytes of key with 64-bit FNV-1a.
func FNV1a64(key string) uint64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte(key))
	return h.Sum64()
}

// Advisory derives the bigint every runtime locks for key: FNV-1a 64
// reinterpreted as a two's-complement int64. Vectors:
// conformance/cases/advisory-key.json.
func Advisory(key string) AdvisoryKey {
	return int64(FNV1a64(key))
}

// Advisory is the receiver form of the package-level function.
func (k LockKey) Advisory() AdvisoryKey { return Advisory(string(k)) }

func (k LockKey) String() string { return string(k) }
