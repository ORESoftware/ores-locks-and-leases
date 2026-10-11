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
	if _, err := NewLockKey("unicode-π"); err != nil {
		t.Fatalf("valid unicode lock key rejected: %v", err)
	}
	if _, err := NewLockKey(strings.Repeat("a", MaxLockKeyBytes)); err != nil {
		t.Fatalf("maximum-size lock key rejected: %v", err)
	}
	if _, err := NewLockKey(strings.Repeat("a", MaxLockKeyBytes+1)); err == nil {
		t.Fatal("oversized ASCII lock key unexpectedly accepted")
	}
	if _, err := NewLockKey(strings.Repeat("é", 257)); err == nil {
		t.Fatal("UTF-8 byte overflow unexpectedly accepted")
	}
}

func TestLockKeyComponentsAreInjective(t *testing.T) {
	key, err := NewLockKeyFromComponents("tenant/a", "job:b")
	if err != nil {
		t.Fatalf("compose structured lock key: %v", err)
	}
	if got, want := key.String(), "8:tenant/a5:job:b"; got != want {
		t.Fatalf("composed key = %q, want %q", got, want)
	}
	other, err := NewLockKeyFromComponents("tenant", "a", "job:b")
	if err != nil {
		t.Fatalf("compose comparison key: %v", err)
	}
	if key == other {
		t.Fatal("distinct component sequences aliased")
	}
	if _, err := NewLockKeyFromComponents(); err == nil {
		t.Fatal("empty component sequence unexpectedly accepted")
	}
}
