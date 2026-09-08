package oreslocks

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type adversarialFenceCorpus struct {
	InvalidFields []struct {
		Name          string `json:"name"`
		Field         string `json:"field"`
		Value         string `json:"value"`
		ExpectedError string `json:"expectedError"`
	} `json:"invalidFields"`
	WrongTypeCases []struct {
		Field         string          `json:"field"`
		Value         json.RawMessage `json:"value"`
		ExpectedError string          `json:"expectedError"`
	} `json:"wrongTypeCases"`
}

func loadAdversarialFenceCorpus(t *testing.T) adversarialFenceCorpus {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "conformance", "cases", "fence-decision.json"))
	if err != nil {
		t.Fatal(err)
	}
	var corpus adversarialFenceCorpus
	if err := json.Unmarshal(data, &corpus); err != nil {
		t.Fatal(err)
	}
	return corpus
}

func validFencedWriteJSON(t *testing.T, overrides map[string]any) []byte {
	t.Helper()
	value := map[string]any{
		"tenantScope":   "tenant/acme",
		"resourceKey":   "example/jobs/rebuild",
		"fencingToken":  MaxFencingTokenText,
		"operationId":   "operation-0001",
		"payloadSha256": strings.Repeat("a", 64),
		"holder":        "worker-a",
		"leaseId":       "lease-a",
	}
	for key, override := range overrides {
		value[key] = override
	}
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func requireFenceCode(t *testing.T, data []byte, code string) {
	t.Helper()
	_, err := DecodeFencedWriteRequestJSON(data)
	if err == nil {
		t.Fatalf("expected fencing validation code %q", code)
	}
	if got := FenceValidationCode(err); got != code {
		t.Fatalf("validation code = %q, want %q: %v", got, code, err)
	}
}

func TestDecodeFencedWriteRequestJSONPreservesUint64Maximum(t *testing.T) {
	request, err := DecodeFencedWriteRequestJSON(validFencedWriteJSON(t, nil))
	if err != nil {
		t.Fatal(err)
	}
	if request.FencingToken.String() != MaxFencingTokenText ||
		request.FencingToken.Uint64() != ^uint64(0) {
		t.Fatalf("token lost precision: %#v", request.FencingToken)
	}
}

func TestDecodeFencedWriteRequestJSONRejectsGeneratedWrongRuntimeTypes(t *testing.T) {
	for _, tc := range loadAdversarialFenceCorpus(t).WrongTypeCases {
		t.Run(tc.Field, func(t *testing.T) {
			var value any
			if err := json.Unmarshal(tc.Value, &value); err != nil {
				t.Fatal(err)
			}
			requireFenceCode(
				t,
				validFencedWriteJSON(t, map[string]any{tc.Field: value}),
				tc.ExpectedError,
			)
		})
	}
}

func TestDecodeFencedWriteRequestJSONRejectsShapeAmbiguity(t *testing.T) {
	valid := string(validFencedWriteJSON(t, nil))
	for name, data := range map[string][]byte{
		"null":          []byte("null"),
		"array":         []byte("[]"),
		"trailing":      []byte(valid + " {}"),
		"unknown field": []byte(strings.TrimSuffix(valid, "}") + `,"authority":"forged"}`),
		"duplicate":     []byte(`{"tenantScope":"tenant/acme","tenantScope":"tenant/other","resourceKey":"example/jobs/rebuild","fencingToken":"1","operationId":"op-1","payloadSha256":"` + strings.Repeat("a", 64) + `"}`),
		"invalid utf8":  append([]byte(`{"tenantScope":"`), 0xff),
	} {
		t.Run(name, func(t *testing.T) {
			code := FenceValidationInvalidType
			if name == "unknown field" || name == "duplicate" {
				code = FenceValidationUnexpectedField
			}
			requireFenceCode(t, data, code)
		})
	}
}

func TestDecodeFencedWriteRequestJSONUsesGeneratedUTF8ByteLimits(t *testing.T) {
	accepted := map[string]any{
		"tenantScope":  strings.Repeat("é", 128),
		"resourceKey":  strings.Repeat("é", 256),
		"operationId":  strings.Repeat("é", 64),
		"holder":       strings.Repeat("é", 128),
		"leaseId":      strings.Repeat("é", 128),
		"fencingToken": "1",
	}
	if _, err := DecodeFencedWriteRequestJSON(validFencedWriteJSON(t, accepted)); err != nil {
		t.Fatalf("exact UTF-8 byte ceilings rejected: %v", err)
	}

	for _, tc := range loadAdversarialFenceCorpus(t).InvalidFields {
		t.Run(tc.Name, func(t *testing.T) {
			requireFenceCode(
				t,
				validFencedWriteJSON(t, map[string]any{tc.Field: tc.Value}),
				tc.ExpectedError,
			)
		})
	}
}

func TestDecodeFencedWriteRequestJSONBoundsBodyBeforeDecode(t *testing.T) {
	requireFenceCode(
		t,
		[]byte(strings.Repeat(" ", MaxFencedWriteJSONBytes+1)),
		FenceValidationInvalidType,
	)
}
