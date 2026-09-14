package oreslocks

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// FiduciaLease is a Lease over the fiducia-cloud node HTTP protocol, using
// only net/http. Blocking acquisition keeps one stable request_id across polls
// and explicit cancellation so timeout/caller cancellation can reconcile a
// raced grant before returning.
type FiduciaLease struct {
	base       string
	http       *http.Client
	internal   string // x-fiducia-internal-auth
	orgID      string // x-fiducia-org-id
	bearer     string // Authorization: Bearer
	allowClear bool
}

const fiduciaCancelCleanupTimeout = 5 * time.Second

// NewFiduciaInternal is the trusted internal hop straight to a fiducia-node.
func NewFiduciaInternal(baseURL, internalSecret, orgID string) *FiduciaLease {
	return &FiduciaLease{base: strings.TrimRight(baseURL, "/"), http: noRedirectClient(), internal: internalSecret, orgID: orgID}
}

// NewFiduciaBearer is a public edge or load-balancer endpoint authenticated
// with an API key.
func NewFiduciaBearer(baseURL, apiKey string) *FiduciaLease {
	return &FiduciaLease{base: strings.TrimRight(baseURL, "/"), http: noRedirectClient(), bearer: apiKey}
}

// WithHTTPClient swaps the transport (tests, custom TLS). Redirects must stay
// disabled: a coordination endpoint never redirects, and following one would
// replay credentials to an attacker-controlled Location.
func (f *FiduciaLease) WithHTTPClient(c *http.Client) *FiduciaLease { f.http = c; return f }

// AllowCleartextInternal opts in to sending the internal secret over http://
// to a host that is not recognizably local. Only for topologies where the
// whole path is trusted.
func (f *FiduciaLease) AllowCleartextInternal() *FiduciaLease { f.allowClear = true; return f }

func noRedirectClient() *http.Client {
	return &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func (f *FiduciaLease) cleartextRefusal() error {
	if f.internal == "" && f.bearer == "" {
		return nil
	}
	if !strings.HasPrefix(f.base, "http://") || f.allowClear {
		return nil
	}
	host := strings.TrimPrefix(f.base, "http://")
	if i := strings.IndexAny(host, ":/"); i >= 0 {
		host = host[:i]
	}
	switch {
	case host == "localhost", host == "127.0.0.1", host == "::1", strings.HasSuffix(host, ".svc"), strings.HasSuffix(host, ".cluster.local"), strings.HasSuffix(host, ".internal"), strings.HasSuffix(host, ".local"):
		return nil
	}
	return fmt.Errorf("fiducia: refusing to send a credential over cleartext http to %q; use https or AllowCleartextInternal()", host)
}

type fiduciaHTTPError struct {
	status int
	body   []byte
}

func (e *fiduciaHTTPError) Error() string {
	return fmt.Sprintf("fiducia: HTTP %d: %s", e.status, bytes.TrimSpace(e.body))
}

// post sends body and returns result.output, or a fiduciaHTTPError on a
// non-2xx status.
func (f *FiduciaLease) post(ctx context.Context, path string, body map[string]any) (map[string]any, error) {
	if err := f.cleartextRefusal(); err != nil {
		return nil, err
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, f.base+path, bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if f.internal != "" {
		req.Header.Set("x-fiducia-internal-auth", f.internal)
	}
	if f.orgID != "" {
		req.Header.Set("x-fiducia-org-id", f.orgID)
	}
	if f.bearer != "" {
		req.Header.Set("Authorization", "Bearer "+f.bearer)
	}
	resp, err := f.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	payload, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		return nil, &fiduciaHTTPError{status: resp.StatusCode, body: payload}
	}
	var parsed struct {
		Result struct {
			Output map[string]any `json:"output"`
		} `json:"result"`
	}
	if len(payload) > 0 {
		decoder := json.NewDecoder(bytes.NewReader(payload))
		decoder.UseNumber()
		if err := decoder.Decode(&parsed); err != nil {
			return nil, fmt.Errorf("fiducia: malformed response: %w", err)
		}
	}
	if parsed.Result.Output == nil {
		return map[string]any{}, nil
	}
	return parsed.Result.Output, nil
}

func outBool(out map[string]any, name string) bool {
	v, _ := out[name].(bool)
	return v
}

func outUint(out map[string]any, name string) (uint64, bool) {
	switch v := out[name].(type) {
	case float64:
		// A float can only be accepted when it is known to be an exact JSON
		// integer. Network responses use json.Number; this case supports test
		// doubles and callers constructing an output map directly.
		if v < 0 || v > 9_007_199_254_740_991 || math.Trunc(v) != v {
			return 0, false
		}
		return uint64(v), true
	case json.Number:
		n, err := strconv.ParseUint(string(v), 10, 64)
		if err != nil {
			return 0, false
		}
		return n, true
	case string:
		n, err := strconv.ParseUint(v, 10, 64)
		if err != nil {
			return 0, false
		}
		return n, true
	}
	return 0, false
}

func transportErr(key LockKey, err error) *Error {
	return newError(KindTransport, key, "", err.Error(), err)
}

func generatedIdentity(prefix string) string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%s%d", prefix, time.Now().UnixNano())
	}
	return prefix + hex.EncodeToString(b[:])
}

// GeneratedHolder is an unguessable holder identity. Holder names
// participate in queue identity and cancellation authority, so a pid/counter
// is not enough.
func GeneratedHolder() string {
	return generatedIdentity("ores-locks-")
}

// GeneratedRequestID is the stable logical identity reused by all polls and
// cancellation for one acquisition attempt.
func GeneratedRequestID() string {
	return generatedIdentity("ores-lock-request-")
}

func mapValue(value any) (map[string]any, bool) {
	mapped, ok := value.(map[string]any)
	return mapped, ok
}

// cancelQueuedAcquire establishes a safe terminal state for one logical
// queued acquisition. If promotion won the cancellation race, release the
// exact raced grant before reporting cancellation to the caller.
func (f *FiduciaLease) cancelQueuedAcquire(key LockKey, holder, requestID string) error {
	ctx, cancel := context.WithTimeout(context.Background(), fiduciaCancelCleanupTimeout)
	defer cancel()

	out, err := f.post(ctx, "/v1/locks/cancel", map[string]any{
		"keys":       []string{string(key)},
		"holder":     holder,
		"request_id": requestID,
	})
	if err != nil {
		return fmt.Errorf("fiducia: cancel transport/safety failure: %w", err)
	}
	if outBool(out, "cancelled") && !outBool(out, "acquired") {
		return nil
	}
	if !outBool(out, "acquired") {
		return errors.New("fiducia: cancel did not establish a safe terminal acquisition state")
	}

	grant, ok := mapValue(out["grant"])
	if !ok {
		return errors.New("fiducia: cancel reported a raced grant without grant authority")
	}
	racedHolder, ok := grant["holder"].(string)
	if !ok || racedHolder != holder {
		return errors.New("fiducia: cancel returned mismatched raced-grant holder authority")
	}
	token, ok := outUint(grant, "fencing_token")
	if !ok || token == 0 {
		return errors.New("fiducia: cancel returned malformed raced-grant fencing authority")
	}

	released, err := f.post(ctx, "/v1/locks/release", map[string]any{
		"key":           string(key),
		"holder":        holder,
		"fencing_token": token,
	})
	if err != nil {
		return fmt.Errorf("fiducia: raced-grant release failed: %w", err)
	}
	if !outBool(released, "released") {
		return errors.New("fiducia: raced grant release was a no-op; ownership safety is unknown")
	}
	return nil
}

// Acquire implements Lease.
func (f *FiduciaLease) Acquire(ctx context.Context, key LockKey, opts AcquireOptions, wait bool) (LeaseGrant, error) {
	holder := opts.Holder
	if holder == "" {
		holder = GeneratedHolder()
	}
	requestID := opts.RequestID
	if requestID == "" {
		requestID = GeneratedRequestID()
	}
	ttlMs := opts.TTL.Milliseconds()
	started := time.Now()
	attempted := false

	for {
		if err := ctx.Err(); err != nil {
			if !attempted {
				return LeaseGrant{}, transportErr(key, err)
			}
			if cleanupErr := f.cancelQueuedAcquire(key, holder, requestID); cleanupErr != nil {
				return LeaseGrant{}, transportErr(key, cleanupErr)
			}
			return LeaseGrant{}, transportErr(key, err)
		}

		body := map[string]any{
			"key":        string(key),
			"holder":     holder,
			"ttl_ms":     ttlMs,
			"request_id": requestID,
		}
		if wait {
			body["wait_timeout_ms"] = opts.WaitTimeout.Milliseconds()
		}
		attempted = true
		out, err := f.post(ctx, "/v1/locks/acquire", body)
		if err != nil {
			// Cancellation can race the in-flight acquire after the server has
			// admitted the request but before the response reaches this client.
			// Reconcile the stable request identity before returning so a raced
			// promoted grant cannot be abandoned silently.
			if ctxErr := ctx.Err(); ctxErr != nil {
				if cleanupErr := f.cancelQueuedAcquire(key, holder, requestID); cleanupErr != nil {
					return LeaseGrant{}, transportErr(key, cleanupErr)
				}
				return LeaseGrant{}, transportErr(key, ctxErr)
			}
			return LeaseGrant{}, transportErr(key, err)
		}
		if outBool(out, "acquired") {
			token, ok := outUint(out, "fencing_token")
			if !ok || token == 0 {
				return LeaseGrant{}, transportErr(key, errors.New("fiducia: acquired without a positive fencing token"))
			}
			grant := LeaseGrant{Key: key, Holder: holder, FencingToken: token, TTLMs: ttlMs}
			if exp, ok := outUint(out, "lease_expires_ms"); ok {
				grant.LeaseExpiresMs = int64(exp)
			}
			return grant, nil
		}
		if !wait {
			return LeaseGrant{}, contention(key, StepFiduciaTryAcquire)
		}
		waited := time.Since(started)
		if waited+opts.RetryInterval > opts.WaitTimeout {
			if cleanupErr := f.cancelQueuedAcquire(key, holder, requestID); cleanupErr != nil {
				return LeaseGrant{}, transportErr(key, cleanupErr)
			}
			return LeaseGrant{}, timeout(key, StepFiduciaAcquire, waited.Milliseconds())
		}
		select {
		case <-ctx.Done():
			if cleanupErr := f.cancelQueuedAcquire(key, holder, requestID); cleanupErr != nil {
				return LeaseGrant{}, transportErr(key, cleanupErr)
			}
			return LeaseGrant{}, transportErr(key, ctx.Err())
		case <-time.After(opts.RetryInterval):
		}
	}
}

// Renew implements Lease. renewed=false is lost fenced authority: fiducia
// has already reaped the grant and may have promoted another holder.
func (f *FiduciaLease) Renew(ctx context.Context, grant LeaseGrant, ttl time.Duration) (LeaseGrant, error) {
	ttlMs := ttl.Milliseconds()
	out, err := f.post(ctx, "/v1/locks/renew", map[string]any{"key": string(grant.Key), "holder": grant.Holder, "fencing_token": grant.FencingToken, "ttl_ms": ttlMs})
	if err != nil {
		return grant, transportErr(grant.Key, err)
	}
	if !outBool(out, "renewed") {
		return grant, newError(KindLostLease, grant.Key, "", "fiducia: lock renewal lost fenced authority", nil)
	}
	renewed := grant
	renewed.TTLMs = ttlMs
	if exp, ok := outUint(out, "lease_expires_ms"); ok {
		renewed.LeaseExpiresMs = int64(exp)
	}
	return renewed, nil
}

// Release implements Lease.
func (f *FiduciaLease) Release(ctx context.Context, grant LeaseGrant) (bool, error) {
	out, err := f.post(ctx, "/v1/locks/release", map[string]any{"key": string(grant.Key), "holder": grant.Holder, "fencing_token": grant.FencingToken})
	if err != nil {
		return false, transportErr(grant.Key, err)
	}
	return outBool(out, "released"), nil
}
