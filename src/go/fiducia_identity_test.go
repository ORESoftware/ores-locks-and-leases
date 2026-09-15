package oreslocks

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestRequestIDPeerBounds(t *testing.T) {
	for _, tc := range []struct {
		name string
		id   string
		want bool
	}{
		{name: "empty", id: "", want: false},
		{name: "ascii", id: "attempt-42", want: true},
		{name: "256 unicode code points", id: strings.Repeat("🦀", 256), want: true},
		{name: "257 unicode code points", id: strings.Repeat("🦀", 257), want: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := validRequestID(tc.id); got != tc.want {
				t.Fatalf("validRequestID(%q) = %v, want %v", tc.id, got, tc.want)
			}
		})
	}
}

func TestFiduciaWireIntegersShareExactJSONAuthorityDomain(t *testing.T) {
	const max = "9007199254740991"
	const overflow = "9007199254740992"

	for _, tc := range []struct {
		name  string
		value any
		want  uint64
		ok    bool
	}{
		{name: "json max", value: json.Number(max), want: maxSafeFiduciaWireInteger, ok: true},
		{name: "json overflow", value: json.Number(overflow), ok: false},
		{name: "string max", value: max, want: maxSafeFiduciaWireInteger, ok: true},
		{name: "string overflow", value: overflow, ok: false},
		{name: "float max", value: float64(maxSafeFiduciaWireInteger), want: maxSafeFiduciaWireInteger, ok: true},
		{name: "negative", value: json.Number("-1"), ok: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := outUint(map[string]any{"value": tc.value}, "value")
			if ok != tc.ok || (ok && got != tc.want) {
				t.Fatalf("outUint(%v) = (%d, %v), want (%d, %v)", tc.value, got, ok, tc.want, tc.ok)
			}
		})
	}
}
