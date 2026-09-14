package oreslocks

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync"
	"testing"
	"time"
)

type fiduciaRecordedCall struct {
	Path string
	Body map[string]any
}

func writeFiduciaOutput(w http.ResponseWriter, status int, output map[string]any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"result": map[string]any{"output": output}})
}

func decodeFiduciaBody(t *testing.T, r *http.Request) map[string]any {
	t.Helper()
	var body map[string]any
	decoder := json.NewDecoder(r.Body)
	decoder.UseNumber()
	if err := decoder.Decode(&body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	return body
}

func requireLockKind(t *testing.T, err error, kind Kind) *Error {
	t.Helper()
	lockErr, ok := err.(*Error)
	if !ok {
		t.Fatalf("expected *Error, got %T: %v", err, err)
	}
	if lockErr.Kind != kind {
		t.Fatalf("expected %s, got %s: %v", kind, lockErr.Kind, lockErr)
	}
	return lockErr
}

func TestFiduciaTimeoutCancelsExactQueuedRequest(t *testing.T) {
	var calls []fiduciaRecordedCall
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := decodeFiduciaBody(t, r)
		calls = append(calls, fiduciaRecordedCall{Path: r.URL.Path, Body: body})
		switch r.URL.Path {
		case "/v1/locks/acquire":
			writeFiduciaOutput(w, http.StatusOK, map[string]any{"acquired": false})
		case "/v1/locks/cancel":
			writeFiduciaOutput(w, http.StatusOK, map[string]any{"cancelled": true, "acquired": false})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer server.Close()

	lease := NewFiduciaBearer(server.URL, "test-token")
	key := LockKey("tenant/acme/jobs/rebuild")
	opts := AcquireOptions{
		TTL:           time.Minute,
		WaitTimeout:   5 * time.Millisecond,
		RetryInterval: 10 * time.Millisecond,
		Holder:        "worker-a",
		RequestID:     "attempt-42",
	}
	_, err := lease.Acquire(context.Background(), key, opts, true)
	lockErr := requireLockKind(t, err, KindTimeout)
	if !lockErr.Retryable() {
		t.Fatal("safe timeout after successful cancellation must remain retryable")
	}
	if len(calls) != 2 || calls[0].Path != "/v1/locks/acquire" || calls[1].Path != "/v1/locks/cancel" {
		t.Fatalf("unexpected calls: %#v", calls)
	}
	if calls[0].Body["request_id"] != "attempt-42" || calls[1].Body["request_id"] != "attempt-42" {
		t.Fatalf("request identity drift: %#v", calls)
	}
	if calls[0].Body["holder"] != calls[1].Body["holder"] {
		t.Fatalf("holder drift: %#v", calls)
	}
	if !reflect.DeepEqual(calls[1].Body["keys"], []any{"tenant/acme/jobs/rebuild"}) {
		t.Fatalf("cancel keys drift: %#v", calls[1].Body["keys"])
	}
}

func TestFiduciaCallerCancelReleasesRacedGrant(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var mu sync.Mutex
	var calls []fiduciaRecordedCall
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := decodeFiduciaBody(t, r)
		mu.Lock()
		calls = append(calls, fiduciaRecordedCall{Path: r.URL.Path, Body: body})
		mu.Unlock()
		switch r.URL.Path {
		case "/v1/locks/acquire":
			cancel()
			writeFiduciaOutput(w, http.StatusOK, map[string]any{"acquired": false})
		case "/v1/locks/cancel":
			writeFiduciaOutput(w, http.StatusOK, map[string]any{
				"cancelled": false,
				"acquired":  true,
				"grant": map[string]any{
					"holder":        "worker-a",
					"fencing_token": "41",
				},
			})
		case "/v1/locks/release":
			writeFiduciaOutput(w, http.StatusOK, map[string]any{"released": true})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer server.Close()

	lease := NewFiduciaBearer(server.URL, "test-token")
	_, err := lease.Acquire(ctx, LockKey("tenant/acme/jobs/rebuild"), AcquireOptions{
		TTL:           time.Minute,
		WaitTimeout:   time.Second,
		RetryInterval: 50 * time.Millisecond,
		Holder:        "worker-a",
		RequestID:     "attempt-42",
	}, true)
	lockErr := requireLockKind(t, err, KindTransport)
	if lockErr.Retryable() {
		t.Fatal("caller cancellation must not become an automatic retry signal")
	}

	mu.Lock()
	defer mu.Unlock()
	paths := make([]string, len(calls))
	for i, call := range calls {
		paths[i] = call.Path
	}
	if !reflect.DeepEqual(paths, []string{"/v1/locks/acquire", "/v1/locks/cancel", "/v1/locks/release"}) {
		t.Fatalf("unexpected calls: %#v", calls)
	}
	if calls[1].Body["request_id"] != "attempt-42" {
		t.Fatalf("cancel request_id drift: %#v", calls[1].Body)
	}
	if calls[2].Body["holder"] != "worker-a" || calls[2].Body["fencing_token"] != json.Number("41") {
		t.Fatalf("raced grant authority drift: %#v", calls[2].Body)
	}
}

func TestFiduciaRacedGrantReleaseNoopIsSafetyFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/locks/acquire":
			writeFiduciaOutput(w, http.StatusOK, map[string]any{"acquired": false})
		case "/v1/locks/cancel":
			writeFiduciaOutput(w, http.StatusOK, map[string]any{
				"cancelled": false,
				"acquired":  true,
				"grant": map[string]any{"holder": "worker-a", "fencing_token": "41"},
			})
		case "/v1/locks/release":
			writeFiduciaOutput(w, http.StatusOK, map[string]any{"released": false})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer server.Close()

	lease := NewFiduciaBearer(server.URL, "test-token")
	_, err := lease.Acquire(context.Background(), LockKey("tenant/acme/jobs/rebuild"), AcquireOptions{
		TTL: time.Minute, WaitTimeout: time.Millisecond, RetryInterval: 2 * time.Millisecond,
		Holder: "worker-a", RequestID: "attempt-42",
	}, true)
	lockErr := requireLockKind(t, err, KindTransport)
	if lockErr.Retryable() {
		t.Fatal("unsafe raced-grant cleanup must not be retryable")
	}
}

func TestFiduciaCancelTransportFailureNeverBecomesContentionOrTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/locks/acquire":
			writeFiduciaOutput(w, http.StatusOK, map[string]any{"acquired": false})
		case "/v1/locks/cancel":
			writeFiduciaOutput(w, http.StatusServiceUnavailable, map[string]any{"error": "unavailable"})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer server.Close()

	lease := NewFiduciaBearer(server.URL, "test-token")
	_, err := lease.Acquire(context.Background(), LockKey("tenant/acme/jobs/rebuild"), AcquireOptions{
		TTL: time.Minute, WaitTimeout: time.Millisecond, RetryInterval: 2 * time.Millisecond,
		Holder: "worker-a", RequestID: "attempt-42",
	}, true)
	lockErr := requireLockKind(t, err, KindTransport)
	if lockErr.Retryable() {
		t.Fatal("ambiguous cancellation must fail closed as non-retryable transport safety failure")
	}
}
