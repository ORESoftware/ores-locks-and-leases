package oreslocks

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestFiduciaLeaseCurrentWireContract(t *testing.T) {
	type call struct {
		path string
		body map[string]any
	}
	calls := make([]call, 0, 4)
	acquires := 0

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode request: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		calls = append(calls, call{path: r.URL.Path, body: body})

		var output map[string]any
		switch r.URL.Path {
		case "/v1/locks/acquire":
			acquires++
			if acquires == 1 {
				output = map[string]any{"acquired": false}
			} else {
				output = map[string]any{"acquired": true, "fencing_token": 17, "lease_expires_ms": 1_700_000_000_000}
			}
		case "/v1/locks/renew":
			output = map[string]any{"renewed": true, "lease_expires_ms": 1_700_000_010_000}
		case "/v1/locks/release":
			output = map[string]any{"released": true}
		default:
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"result": map[string]any{"output": output}})
	}))
	defer server.Close()

	lease := NewFiduciaBearer(server.URL, "test-only").AllowCleartextInternal()
	opts := DefaultAcquireOptions()
	opts.Holder = "svc-wire-test"
	opts.WaitTimeout = 100 * time.Millisecond
	opts.RetryInterval = time.Millisecond

	grant, err := lease.Acquire(context.Background(), "t/fiducia-wire", opts, true)
	if err != nil {
		t.Fatal(err)
	}
	if grant.FencingToken != 17 {
		t.Fatalf("fencing token %d, want 17", grant.FencingToken)
	}
	if len(calls) != 3 {
		t.Fatalf("calls after acquire = %d, want 3: %+v", len(calls), calls)
	}
	if calls[0].path != "/v1/locks/acquire" || calls[1].path != "/v1/locks/acquire" {
		t.Fatalf("acquire paths: %+v", calls)
	}
	if calls[0].body["wait"] != true || calls[0].body["wait_timeout_ms"] != float64(100) {
		t.Fatalf("blocking acquire missing wait contract: %#v", calls[0].body)
	}
	requestID, _ := calls[0].body["request_id"].(string)
	if requestID == "" || calls[1].body["request_id"] != requestID {
		t.Fatalf("polls must share one request_id: %#v %#v", calls[0].body, calls[1].body)
	}
	if requestID == calls[0].body["holder"] {
		t.Fatal("request identity and holder identity must be distinct")
	}

	// A retry-discovered grant is renewed before application work can see it.
	if calls[2].path != "/v1/locks/renew" {
		t.Fatalf("third call = %q, want renew", calls[2].path)
	}
	keys, ok := calls[2].body["keys"].([]any)
	if !ok || len(keys) != 1 || keys[0] != "t/fiducia-wire" {
		t.Fatalf("renew keys = %#v", calls[2].body["keys"])
	}
	if _, legacy := calls[2].body["key"]; legacy {
		t.Fatalf("renew sent legacy singular key: %#v", calls[2].body)
	}

	released, err := lease.Release(context.Background(), grant)
	if err != nil || !released {
		t.Fatalf("release = %v, %v", released, err)
	}
	if len(calls) != 4 || calls[3].path != "/v1/locks/release" {
		t.Fatalf("release calls: %+v", calls)
	}
	if _, legacy := calls[3].body["key"]; legacy {
		t.Fatalf("release sent legacy member key: %#v", calls[3].body)
	}
	if calls[3].body["holder"] != "svc-wire-test" || calls[3].body["fencing_token"] != float64(17) {
		t.Fatalf("release identity = %#v", calls[3].body)
	}
}
