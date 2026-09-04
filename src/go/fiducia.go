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
	"net/http"
	"strings"
	"time"
)

// FiduciaLease is a Lease over the fiducia-cloud node HTTP protocol, using
// only net/http. It speaks the same three endpoints the official clients do
// (/v1/locks/acquire, /v1/locks/renew, /v1/locks/release) with the same
// headers, so a service that already holds a *fiducia.Client can keep it for
// everything else and hand this adapter the same base URL and credentials.
//
// The node never holds a request open: acquire returns at once with
// acquired=false when the key is held, so the client owns the wait. This
// adapter polls at opts.RetryInterval until the grant arrives or
// opts.WaitTimeout elapses.
type FiduciaLease struct {
	base       string
	http       *http.Client
	internal   string // x-fiducia-internal-auth
	orgID      string // x-fiducia-org-id
	bearer     string // Authorization: Bearer
	allowClear bool
}

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
		if err := json.Unmarshal(payload, &parsed); err != nil {
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
		if v < 0 {
			return 0, false
		}
		return uint64(v), true
	case json.Number:
		n, err := v.Int64()
		if err != nil || n < 0 {
			return 0, false
		}
		return uint64(n), true
	}
	return 0, false
}

func transportErr(key LockKey, err error) *Error {
	return newError(KindTransport, key, "", err.Error(), err)
}

// GeneratedHolder is an unguessable holder identity. Holder names
// participate in queue identity and cancellation authority, so a pid/counter
// is not enough.
func GeneratedHolder() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("ores-locks-%d", time.Now().UnixNano())
	}
	return "ores-locks-" + hex.EncodeToString(b[:])
}

// Acquire implements Lease.
func (f *FiduciaLease) Acquire(ctx context.Context, key LockKey, opts AcquireOptions, wait bool) (LeaseGrant, error) {
	holder := opts.Holder
	if holder == "" {
		holder = GeneratedHolder()
	}
	ttlMs := opts.TTL.Milliseconds()
	started := time.Now()
	for {
		out, err := f.post(ctx, "/v1/locks/acquire", map[string]any{"key": string(key), "holder": holder, "ttl_ms": ttlMs})
		if err != nil {
			return LeaseGrant{}, transportErr(key, err)
		}
		if outBool(out, "acquired") {
			token, ok := outUint(out, "fencing_token")
			if !ok {
				return LeaseGrant{}, transportErr(key, errors.New("fiducia: acquired without a fencing token"))
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
			return LeaseGrant{}, timeout(key, StepFiduciaAcquire, waited.Milliseconds())
		}
		select {
		case <-ctx.Done():
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
