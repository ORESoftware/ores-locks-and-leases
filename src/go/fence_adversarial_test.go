package oreslocks

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

type adversarialFenceCorpus struct {
	Schema     string `json:"schema"`
	Generator  string `json:"generator"`
	Seed       string `json:"seed"`
	TokenCases []struct {
		Name     string `json:"name"`
		Value    string `json:"value"`
		Expected struct {
			OK        bool   `json:"ok"`
			Canonical string `json:"canonical"`
			Error     string `json:"error"`
		} `json:"expected"`
	} `json:"tokenCases"`
	RequestCases []struct {
		Name     string          `json:"name"`
		Incoming json.RawMessage `json:"incoming"`
		Expected struct {
			OK    bool   `json:"ok"`
			Error string `json:"error"`
		} `json:"expected"`
	} `json:"requestCases"`
	DecisionCases []struct {
		Name          string           `json:"name"`
		Current       *json.RawMessage `json:"current"`
		Incoming      json.RawMessage  `json:"incoming"`
		Expected      *FenceDecision   `json:"expected"`
		ExpectedError string           `json:"expectedError"`
	} `json:"decisionCases"`
}

func loadAdversarialFenceCorpus(t *testing.T) adversarialFenceCorpus {
	t.Helper()
	path := os.Getenv("ORES_FENCE_ADVERSARIAL_CORPUS")
	if path == "" {
		path = filepath.Join("..", "..", "conformance", "cases", "fence-adversarial.json")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var corpus adversarialFenceCorpus
	if err := json.Unmarshal(data, &corpus); err != nil {
		t.Fatal(err)
	}
	if corpus.Schema != "ores.locks.fence-adversarial/v1" ||
		corpus.Generator != "splitmix64-v1" ||
		corpus.Seed != "0x4f5245534c4f434b" {
		t.Fatalf("unexpected corpus identity: %#v", corpus)
	}
	return corpus
}

func TestFenceAdversarialTokens(t *testing.T) {
	for _, tc := range loadAdversarialFenceCorpus(t).TokenCases {
		t.Run(tc.Name, func(t *testing.T) {
			token, err := ParseFencingTokenText(tc.Value)
			if tc.Expected.OK {
				if err != nil {
					t.Fatal(err)
				}
				if token.String() != tc.Expected.Canonical {
					t.Fatalf("canonical token = %q, want %q", token.String(), tc.Expected.Canonical)
				}
				return
			}
			if err == nil {
				t.Fatalf("invalid token accepted: %q", tc.Value)
			}
			if code := FenceValidationCode(err); code != tc.Expected.Error {
				t.Fatalf("validation code = %q, want %q", code, tc.Expected.Error)
			}
		})
	}
}

func TestFenceAdversarialRequests(t *testing.T) {
	for _, tc := range loadAdversarialFenceCorpus(t).RequestCases {
		t.Run(tc.Name, func(t *testing.T) {
			var request FencedWriteRequest
			err := json.Unmarshal(tc.Incoming, &request)
			if tc.Expected.OK {
				if err != nil {
					t.Fatal(err)
				}
				if err := request.Validate(); err != nil {
					t.Fatal(err)
				}
				return
			}
			if err == nil {
				t.Fatal("invalid adversarial request accepted")
			}
			if code := FenceValidationCode(err); code != tc.Expected.Error {
				t.Fatalf("validation code = %q, want %q: %v", code, tc.Expected.Error, err)
			}
		})
	}
}

func TestFenceAdversarialDecisions(t *testing.T) {
	for _, tc := range loadAdversarialFenceCorpus(t).DecisionCases {
		t.Run(tc.Name, func(t *testing.T) {
			var incoming FencedWriteRequest
			if err := json.Unmarshal(tc.Incoming, &incoming); err != nil {
				t.Fatal(err)
			}
			var current *FenceWatermark
			if tc.Current != nil && string(*tc.Current) != "null" {
				var request FencedWriteRequest
				if err := json.Unmarshal(*tc.Current, &request); err != nil {
					t.Fatal(err)
				}
				watermark := WatermarkFromRequest(request)
				current = &watermark
			}

			decision, err := EvaluateFence(current, incoming)
			if tc.ExpectedError != "" {
				if err == nil {
					t.Fatalf("expected validation error %q", tc.ExpectedError)
				}
				if code := FenceValidationCode(err); code != tc.ExpectedError {
					t.Fatalf("validation code = %q, want %q", code, tc.ExpectedError)
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

func TestFencedWriteJSONRejectsUnknownWrongAndTrailingInput(t *testing.T) {
	valid := []byte(`{"tenantScope":"tenant/acme","resourceKey":"example/jobs/rebuild","fencingToken":"1","operationId":"op-1","payloadSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`)
	for name, data := range map[string][]byte{
		"unknown":  append(valid[:len(valid)-1], []byte(`,"authority":"forged"}`)...),
		"number":   []byte(`{"tenantScope":"tenant/acme","resourceKey":"example/jobs/rebuild","fencingToken":1,"operationId":"op-1","payloadSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`),
		"trailing": append(append([]byte{}, valid...), []byte(` {}`)...),
	} {
		t.Run(name, func(t *testing.T) {
			var request FencedWriteRequest
			if err := json.Unmarshal(data, &request); err == nil {
				t.Fatal("hostile JSON unexpectedly accepted")
			}
		})
	}
}
