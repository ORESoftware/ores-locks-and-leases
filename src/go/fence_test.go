package oreslocks

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

type fenceCorpus struct {
	Cases []struct {
		Name          string             `json:"name"`
		Current       *FenceWatermark    `json:"current"`
		Incoming      FencedWriteRequest `json:"incoming"`
		Expected      *FenceDecision     `json:"expected"`
		ExpectedError string             `json:"expectedError"`
	} `json:"cases"`
	InvalidTokens []string `json:"invalidTokens"`
}

func loadFenceCorpus(t *testing.T) fenceCorpus {
	t.Helper()
	path := filepath.Join("..", "..", "conformance", "cases", "fence-decision.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var corpus fenceCorpus
	if err := json.Unmarshal(data, &corpus); err != nil {
		t.Fatal(err)
	}
	return corpus
}

func TestFenceDecisionsMatchSharedCorpus(t *testing.T) {
	for _, tc := range loadFenceCorpus(t).Cases {
		t.Run(tc.Name, func(t *testing.T) {
			decision, err := EvaluateFence(tc.Current, tc.Incoming)
			if tc.ExpectedError != "" {
				if err == nil {
					t.Fatalf("expected validation error %q", tc.ExpectedError)
				}
				if got := FenceValidationCode(err); got != tc.ExpectedError {
					t.Fatalf("validation code = %q, want %q: %v", got, tc.ExpectedError, err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if tc.Expected == nil {
				t.Fatal("missing expected decision")
			}
			if decision.Kind != tc.Expected.Kind ||
				decision.ShouldApply != tc.Expected.ShouldApply ||
				decision.IncomingToken != tc.Expected.IncomingToken ||
				decision.CurrentToken != tc.Expected.CurrentToken {
				t.Fatalf("decision = %#v, want %#v", decision, *tc.Expected)
			}
			switch {
			case decision.PreviousToken == nil && tc.Expected.PreviousToken == nil:
			case decision.PreviousToken == nil || tc.Expected.PreviousToken == nil:
				t.Fatalf("previous token = %#v, want %#v", decision.PreviousToken, tc.Expected.PreviousToken)
			case *decision.PreviousToken != *tc.Expected.PreviousToken:
				t.Fatalf("previous token = %q, want %q", decision.PreviousToken.String(), tc.Expected.PreviousToken.String())
			}
		})
	}
}

func TestInvalidFenceTokensFailClosed(t *testing.T) {
	for _, value := range loadFenceCorpus(t).InvalidTokens {
		if _, err := ParseFencingTokenText(value); err == nil {
			t.Errorf("invalid token unexpectedly accepted: %q", value)
		}
	}
}

func TestWatermarkFromRequest(t *testing.T) {
	token, err := ParseFencingTokenText(MaxFencingTokenText)
	if err != nil {
		t.Fatal(err)
	}
	key, err := NewLockKey("example/jobs/rebuild")
	if err != nil {
		t.Fatal(err)
	}
	request, err := NewFencedWriteRequest(
		"tenant/acme",
		key,
		token,
		"op-max",
		"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		"worker-a",
		"lease-max",
	)
	if err != nil {
		t.Fatal(err)
	}
	watermark := WatermarkFromRequest(request)
	if watermark.FencingToken.Uint64() != ^uint64(0) {
		t.Fatalf("token = %d", watermark.FencingToken.Uint64())
	}
}
