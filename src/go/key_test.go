package oreslocks

import "testing"

func TestLockKeyIsNonEmptyAndLengthBounded(t *testing.T) {
	if _, err := NewLockKey(""); err == nil {
		t.Fatal("empty lock key unexpectedly accepted")
	}
	if _, err := NewLockKey(string(make([]byte, MaxLockKeyBytes))); err != nil {
		t.Fatalf("maximum-size lock key rejected: %v", err)
	}
	if _, err := NewLockKey(string(make([]byte, MaxLockKeyBytes+1))); err == nil {
		t.Fatal("oversized lock key unexpectedly accepted")
	}
}
