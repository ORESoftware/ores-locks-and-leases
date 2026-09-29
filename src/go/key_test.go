package oreslocks

import (
	"strings"
	"testing"
)

func TestLockKeyIsNonEmptyAndLengthBounded(t *testing.T) {
	if _, err := NewLockKey(""); err == nil {
		t.Fatal("empty lock key unexpectedly accepted")
	}
	for _, invalid := range []string{" ", " key", "key ", "key\nother", "key\x00other", "key\x7fother"} {
		if _, err := NewLockKey(invalid); err == nil {
			t.Fatalf("invalid lock key %q unexpectedly accepted", invalid)
		}
	}
	if _, err := NewLockKey(strings.Repeat("a", MaxLockKeyBytes)); err != nil {
		t.Fatalf("maximum-size lock key rejected: %v", err)
	}
	if _, err := NewLockKey(string(make([]byte, MaxLockKeyBytes+1))); err == nil {
		t.Fatal("oversized lock key unexpectedly accepted")
	}
}
