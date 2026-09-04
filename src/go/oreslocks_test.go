package oreslocks

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// --- conformance ------------------------------------------------------------

func readCase(t *testing.T, name string, into any) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "conformance", "cases", name))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, into); err != nil {
		t.Fatal(err)
	}
}

func TestAdvisoryKeyVectors(t *testing.T) {
	var doc struct {
		Cases []struct {
			Key      string `json:"key"`
			Unsigned string `json:"fnv1a64_unsigned"`
			Signed   string `json:"advisory_key"`
		} `json:"cases"`
	}
	readCase(t, "advisory-key.json", &doc)
	if len(doc.Cases) < 8 {
		t.Fatalf("expected >= 8 cases, got %d", len(doc.Cases))
	}
	for _, c := range doc.Cases {
		u, _ := strconv.ParseUint(c.Unsigned, 10, 64)
		s, _ := strconv.ParseInt(c.Signed, 10, 64)
		if got := FNV1a64(c.Key); got != u {
			t.Errorf("FNV1a64(%q) = %d, want %d", c.Key, got, u)
		}
		if got := Advisory(c.Key); got != s {
			t.Errorf("Advisory(%q) = %d, want %d", c.Key, got, s)
		}
	}
}

func TestLockPlanMatrix(t *testing.T) {
	var doc struct {
		Cases []struct {
			Name   string `json:"name"`
			Layers struct {
				Fiducia    bool `json:"fiducia"`
				PgAdvisory bool `json:"pgAdvisory"`
			} `json:"layers"`
			PgScope string `json:"pgScope"`
			Wait    bool   `json:"wait"`
			Expect  struct {
				Steps []Step `json:"steps"`
			} `json:"expect"`
		} `json:"cases"`
	}
	readCase(t, "lock-plan.json", &doc)
	if len(doc.Cases) != 11 {
		t.Fatalf("expected 11 cases, got %d", len(doc.Cases))
	}
	for _, c := range doc.Cases {
		got := MakePlan(Layers{Fiducia: c.Layers.Fiducia, PgAdvisory: c.Layers.PgAdvisory}, PgScope(c.PgScope), c.Wait).Steps
		if len(got) != len(c.Expect.Steps) {
			t.Errorf("%s: %v != %v", c.Name, got, c.Expect.Steps)
			continue
		}
		for i := range got {
			if got[i] != c.Expect.Steps[i] {
				t.Errorf("%s: step %d %q != %q", c.Name, i, got[i], c.Expect.Steps[i])
			}
		}
	}
}

// --- fake lease -------------------------------------------------------------

type fakeLease struct {
	mu             sync.Mutex
	held           bool
	next           uint64
	lapseOnRelease bool
	failRelease    bool
	log            []Step
}

func (f *fakeLease) Acquire(_ context.Context, key LockKey, opts AcquireOptions, wait bool) (LeaseGrant, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if wait {
		f.log = append(f.log, StepFiduciaAcquire)
	} else {
		f.log = append(f.log, StepFiduciaTryAcquire)
	}
	if f.held {
		if wait {
			return LeaseGrant{}, timeout(key, StepFiduciaAcquire, opts.WaitTimeout.Milliseconds())
		}
		return LeaseGrant{}, contention(key, StepFiduciaTryAcquire)
	}
	f.held = true
	f.next++
	return LeaseGrant{Key: key, Holder: "fake", FencingToken: f.next, TTLMs: opts.TTL.Milliseconds()}, nil
}

func (f *fakeLease) Renew(_ context.Context, g LeaseGrant, ttl time.Duration) (LeaseGrant, error) {
	g.TTLMs = ttl.Milliseconds()
	return g, nil
}

func (f *fakeLease) Release(_ context.Context, grant LeaseGrant) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.log = append(f.log, StepFiduciaRelease)
	if f.failRelease {
		return false, transportErr(grant.Key, errors.New("release transport failed; ownership is unknown"))
	}
	f.held = false
	return !f.lapseOnRelease, nil
}

func TestWithLeaseOrderingAndFencing(t *testing.T) {
	lease := &fakeLease{}
	var seen uint64
	err := WithLease(context.Background(), "t/lease", true, true, DefaultAcquireOptions(), lease, func(_ context.Context, g Guarded) error {
		seen, _ = g.FencingToken()
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if seen != 1 {
		t.Fatalf("fencing token %d", seen)
	}
	if len(lease.log) != 2 || lease.log[0] != StepFiduciaAcquire || lease.log[1] != StepFiduciaRelease {
		t.Fatalf("log %v", lease.log)
	}
}

func TestWithLeaseFailures(t *testing.T) {
	var le *Error

	// Disabled layer: pass-through with no grant.
	if err := WithLease(context.Background(), "t/x", false, true, DefaultAcquireOptions(), nil, func(_ context.Context, g Guarded) error {
		if g.Grant != nil {
			t.Fatal("grant present on a disabled layer")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	// Enabled without an authority.
	err := WithLease(context.Background(), "t/x", true, true, DefaultAcquireOptions(), nil, func(context.Context, Guarded) error { return nil })
	if !errors.As(err, &le) || le.Kind != KindInvalidPlan {
		t.Fatalf("want invalid_plan, got %v", err)
	}

	// Work failure still releases and is reported as work.
	lease := &fakeLease{}
	err = WithLease(context.Background(), "t/x", true, false, DefaultAcquireOptions(), lease, func(context.Context, Guarded) error { return errors.New("kaboom") })
	if !errors.As(err, &le) || le.Kind != KindWork || le.Step != StepWork || le.Message != "kaboom" || lease.held {
		t.Fatalf("want work error with release, got %v held=%v", err, lease.held)
	}

	// Contention vs timeout.
	lease = &fakeLease{held: true}
	err = WithLease(context.Background(), "t/x", true, false, DefaultAcquireOptions(), lease, func(context.Context, Guarded) error { return nil })
	if !errors.As(err, &le) || le.Kind != KindContention || !le.Retryable() {
		t.Fatalf("want contention, got %v", err)
	}
	err = WithLease(context.Background(), "t/x", true, true, DefaultAcquireOptions(), lease, func(context.Context, Guarded) error { return nil })
	if !errors.As(err, &le) || le.Kind != KindTimeout {
		t.Fatalf("want timeout, got %v", err)
	}

	// Lapsed lease is lost_lease even when the work succeeded.
	lease = &fakeLease{lapseOnRelease: true}
	err = WithLease(context.Background(), "t/x", true, true, DefaultAcquireOptions(), lease, func(context.Context, Guarded) error { return nil })
	if !errors.As(err, &le) || le.Kind != KindLostLease || le.Step != StepFiduciaRelease {
		t.Fatalf("want lost_lease at release, got %v", err)
	}

	// Cleanup failure wins over work failure, retaining the work diagnostic.
	lease = &fakeLease{failRelease: true}
	err = WithLease(context.Background(), "t/x", true, true, DefaultAcquireOptions(), lease, func(context.Context, Guarded) error { return errors.New("work exploded") })
	if !errors.As(err, &le) || le.Kind != KindTransport || le.Step != StepFiduciaRelease || !strings.Contains(le.Message, "work exploded") || !lease.held {
		t.Fatalf("want transport cleanup error with work context, got %v held=%v", err, lease.held)
	}

	// A confirmed lapse also wins over work failure: fenced authority is gone.
	lease = &fakeLease{lapseOnRelease: true}
	err = WithLease(context.Background(), "t/x", true, true, DefaultAcquireOptions(), lease, func(context.Context, Guarded) error { return errors.New("work exploded") })
	if !errors.As(err, &le) || le.Kind != KindLostLease || le.Step != StepFiduciaRelease || !strings.Contains(le.Message, "work exploded") {
		t.Fatalf("want lost_lease cleanup error with work context, got %v", err)
	}
}

// --- fake database/sql driver ----------------------------------------------

// recDriver records every statement and transaction verb so the routines'
// ordering can be asserted without a live Postgres. try-lock statements
// answer with the driver's `acquired` flag.
type recDriver struct {
	mu       sync.Mutex
	log      []string
	acquired bool
	unlocked bool
}

func (d *recDriver) record(s string)                  { d.mu.Lock(); d.log = append(d.log, s); d.mu.Unlock() }
func (d *recDriver) Open(string) (driver.Conn, error) { return &recConn{d: d}, nil }

type recConn struct{ d *recDriver }

func (c *recConn) Prepare(string) (driver.Stmt, error) { return nil, errors.New("unused") }
func (c *recConn) Close() error                        { c.d.record("CLOSE"); return nil }
func (c *recConn) Begin() (driver.Tx, error)           { c.d.record("BEGIN"); return recTx{d: c.d}, nil }
func (c *recConn) ExecContext(_ context.Context, q string, _ []driver.NamedValue) (driver.Result, error) {
	c.d.record(q)
	return driver.RowsAffected(0), nil
}
func (c *recConn) QueryContext(_ context.Context, q string, _ []driver.NamedValue) (driver.Rows, error) {
	c.d.record(q)
	v := c.d.acquired
	if q == "SELECT pg_advisory_unlock($1)" {
		v = c.d.unlocked
	}
	return &boolRows{v: v}, nil
}

type recTx struct{ d *recDriver }

func (t recTx) Commit() error   { t.d.record("COMMIT"); return nil }
func (t recTx) Rollback() error { t.d.record("ROLLBACK"); return nil }

type boolRows struct {
	v    bool
	done bool
}

func (r *boolRows) Columns() []string { return []string{"b"} }
func (r *boolRows) Close() error      { return nil }
func (r *boolRows) Next(dest []driver.Value) error {
	if r.done {
		return io.EOF
	}
	r.done = true
	dest[0] = r.v
	return nil
}

var registerOnce sync.Once
var drivers = map[string]*recDriver{}
var driversMu sync.Mutex

func openRec(t *testing.T, acquired, unlocked bool) (*sql.DB, *recDriver) {
	t.Helper()
	d := &recDriver{acquired: acquired, unlocked: unlocked}
	name := "rec-" + t.Name()
	driversMu.Lock()
	drivers[name] = d
	driversMu.Unlock()
	registerOnce.Do(func() { sql.Register("rec", byNameDriver{}) })
	db, err := sql.Open("rec", name)
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	return db, d
}

type byNameDriver struct{}

func (byNameDriver) Open(name string) (driver.Conn, error) {
	driversMu.Lock()
	d := drivers[name]
	driversMu.Unlock()
	return d.Open(name)
}

func TestWithXactLockBothLayersOrdering(t *testing.T) {
	db, d := openRec(t, true, true)
	defer db.Close()
	lease := &fakeLease{}
	err := WithXactLock(context.Background(), "t/xact", LayersBoth, true, DefaultAcquireOptions(), lease, db, func(_ context.Context, g XactGuarded) error {
		if g.Tx == nil {
			t.Fatal("no transaction")
		}
		if tok, ok := g.FencingToken(); !ok || tok != 1 {
			t.Fatalf("fencing token %d %v", tok, ok)
		}
		d.record("WORK")
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"BEGIN", "SELECT pg_advisory_xact_lock($1)", "WORK", "COMMIT"}
	if len(d.log) != len(want) {
		t.Fatalf("log %v", d.log)
	}
	for i := range want {
		if d.log[i] != want[i] {
			t.Fatalf("log %v", d.log)
		}
	}
	if lease.log[0] != StepFiduciaAcquire || lease.log[len(lease.log)-1] != StepFiduciaRelease {
		t.Fatalf("fiducia must wrap: %v", lease.log)
	}
}

func TestWithXactLockRollsBackAndReleasesOnWorkFailure(t *testing.T) {
	db, d := openRec(t, true, true)
	defer db.Close()
	lease := &fakeLease{}
	err := WithXactLock(context.Background(), "t/xact", LayersBoth, false, DefaultAcquireOptions(), lease, db, func(context.Context, XactGuarded) error {
		return errors.New("nope")
	})
	var le *Error
	if !errors.As(err, &le) || le.Kind != KindWork {
		t.Fatalf("want work, got %v", err)
	}
	if d.log[len(d.log)-1] != "ROLLBACK" || d.log[1] != "SELECT pg_try_advisory_xact_lock($1)" {
		t.Fatalf("log %v", d.log)
	}
	if lease.held {
		t.Fatal("lease not released")
	}
}

func TestWithXactLockContentionReleasesTheLease(t *testing.T) {
	db, d := openRec(t, false, true)
	defer db.Close()
	lease := &fakeLease{}
	err := WithXactLock(context.Background(), "t/xact", LayersBoth, false, DefaultAcquireOptions(), lease, db, func(context.Context, XactGuarded) error {
		t.Fatal("work must not run")
		return nil
	})
	var le *Error
	if !errors.As(err, &le) || le.Kind != KindContention || le.Step != StepPgTryAdvisoryXactLock {
		t.Fatalf("want pg contention, got %v", err)
	}
	if d.log[len(d.log)-1] != "ROLLBACK" || lease.held {
		t.Fatalf("log %v held=%v", d.log, lease.held)
	}
}

func TestWithSessionLockOpensNoTransaction(t *testing.T) {
	db, d := openRec(t, true, true)
	defer db.Close()
	err := WithSessionLock(context.Background(), "t/sess", LayersPgOnly, false, DefaultAcquireOptions(), nil, db, func(_ context.Context, g SessionGuarded) error {
		if g.Conn == nil {
			t.Fatal("no dedicated connection")
		}
		d.record("WORK")
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"SELECT pg_try_advisory_lock($1)", "WORK", "SELECT pg_advisory_unlock($1)"}
	for i := range want {
		if d.log[i] != want[i] {
			t.Fatalf("log %v", d.log)
		}
	}
	for _, s := range d.log {
		if s == "BEGIN" {
			t.Fatal("session scope opened a transaction")
		}
	}
}

func TestWithSessionLockUnlockMismatchIsDatabaseError(t *testing.T) {
	db, _ := openRec(t, true, false)
	defer db.Close()
	err := WithSessionLock(context.Background(), "t/sess", LayersPgOnly, true, DefaultAcquireOptions(), nil, db, func(context.Context, SessionGuarded) error { return nil })
	var le *Error
	if !errors.As(err, &le) || le.Kind != KindDatabase || le.Step != StepPgAdvisoryUnlock {
		t.Fatalf("want database at unlock, got %v", err)
	}
}

func TestSessionUnlockFailureWinsOverWorkFailure(t *testing.T) {
	db, recorder := openRec(t, true, false)
	defer db.Close()
	err := WithSessionLock(context.Background(), "t/session-cleanup", LayersPgOnly, true, DefaultAcquireOptions(), nil, db, func(context.Context, SessionGuarded) error {
		return errors.New("work exploded")
	})
	var lockErr *Error
	if !errors.As(err, &lockErr) || lockErr.Kind != KindDatabase || lockErr.Step != StepPgAdvisoryUnlock || !strings.Contains(lockErr.Message, "work exploded") {
		t.Fatalf("want unlock cleanup error with work context, got %v", err)
	}
	closed := false
	for _, step := range recorder.log {
		closed = closed || step == "CLOSE"
	}
	if !closed {
		t.Fatalf("uncertain session was returned to the pool instead of discarded: %v", recorder.log)
	}
}

func TestInvalidPlans(t *testing.T) {
	var le *Error
	err := WithXactLock(context.Background(), "t/x", LayersPgOnly, true, DefaultAcquireOptions(), nil, nil, func(context.Context, XactGuarded) error { return nil })
	if !errors.As(err, &le) || le.Kind != KindInvalidPlan {
		t.Fatalf("want invalid_plan, got %v", err)
	}
	err = WithSessionLock(context.Background(), "t/x", LayersFiduciaOnly, true, DefaultAcquireOptions(), nil, nil, func(context.Context, SessionGuarded) error { return nil })
	if !errors.As(err, &le) || le.Kind != KindInvalidPlan {
		t.Fatalf("want invalid_plan, got %v", err)
	}
	// Neither layer: pass-through, no db or lease needed.
	ran := false
	if err := WithXactLock(context.Background(), "t/x", LayersNone, true, DefaultAcquireOptions(), nil, nil, func(context.Context, XactGuarded) error { ran = true; return nil }); err != nil || !ran {
		t.Fatalf("pass-through failed: %v ran=%v", err, ran)
	}
}

// --- fiducia over httptest --------------------------------------------------

type fakeNode struct {
	mu       sync.Mutex
	holder   string
	token    uint64
	requests []string
	headers  http.Header
}

func (n *fakeNode) handle(w http.ResponseWriter, r *http.Request) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.requests = append(n.requests, r.URL.Path)
	n.headers = r.Header.Clone()
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	out := map[string]any{}
	switch r.URL.Path {
	case "/v1/locks/acquire":
		if n.holder == "" {
			n.holder = body["holder"].(string)
			n.token++
			out = map[string]any{"acquired": true, "fencing_token": n.token, "lease_expires_ms": 123456}
		} else {
			out = map[string]any{"acquired": false}
		}
	case "/v1/locks/renew":
		out = map[string]any{"renewed": body["holder"] == n.holder, "lease_expires_ms": 234567}
	case "/v1/locks/release":
		released := body["holder"] == n.holder && uint64(body["fencing_token"].(float64)) == n.token
		if released {
			n.holder = ""
		}
		out = map[string]any{"released": released}
	default:
		w.WriteHeader(404)
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"result": map[string]any{"output": out}})
}

func TestFiduciaLeaseProtocol(t *testing.T) {
	node := &fakeNode{}
	srv := httptest.NewServer(http.HandlerFunc(node.handle))
	defer srv.Close()
	lease := NewFiduciaInternal(srv.URL, "secret", "org-1").AllowCleartextInternal()
	opts := DefaultAcquireOptions()
	opts.Holder = "svc-a"

	g, err := lease.Acquire(context.Background(), "t/f", opts, true)
	if err != nil {
		t.Fatal(err)
	}
	if g.FencingToken != 1 || g.LeaseExpiresMs != 123456 || g.Holder != "svc-a" {
		t.Fatalf("grant %+v", g)
	}
	if node.headers.Get("x-fiducia-internal-auth") != "secret" || node.headers.Get("x-fiducia-org-id") != "org-1" {
		t.Fatalf("headers %v", node.headers)
	}

	// Second holder: contention without wait, timeout with a tiny budget.
	other := opts
	other.Holder = "svc-b"
	_, err = lease.Acquire(context.Background(), "t/f", other, false)
	var le *Error
	if !errors.As(err, &le) || le.Kind != KindContention {
		t.Fatalf("want contention, got %v", err)
	}
	other.WaitTimeout = 30 * time.Millisecond
	other.RetryInterval = 10 * time.Millisecond
	_, err = lease.Acquire(context.Background(), "t/f", other, true)
	if !errors.As(err, &le) || le.Kind != KindTimeout {
		t.Fatalf("want timeout, got %v", err)
	}

	renewed, err := lease.Renew(context.Background(), g, 5*time.Second)
	if err != nil || renewed.LeaseExpiresMs != 234567 || renewed.TTLMs != 5000 {
		t.Fatalf("renew %+v %v", renewed, err)
	}
	stale := g
	stale.Holder = "someone-else"
	if _, err := lease.Renew(context.Background(), stale, time.Second); !errors.As(err, &le) || le.Kind != KindLostLease {
		t.Fatalf("want lost_lease, got %v", err)
	}

	ok, err := lease.Release(context.Background(), g)
	if err != nil || !ok {
		t.Fatalf("release %v %v", ok, err)
	}
	ok, err = lease.Release(context.Background(), g)
	if err != nil || ok {
		t.Fatalf("second release must be a no-op: %v %v", ok, err)
	}
}

func TestFiduciaHTTPAdapterPreservesFullUint64Tokens(t *testing.T) {
	const token = uint64(9_007_199_254_740_993)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = io.WriteString(w, `{"result":{"output":{"acquired":true,"fencing_token":9007199254740993,"lease_expires_ms":1700000000000}}}`)
	}))
	defer server.Close()

	lease := NewFiduciaBearer(server.URL, "test-key")
	grant, err := lease.Acquire(context.Background(), "t/full-u64", DefaultAcquireOptions(), false)
	if err != nil {
		t.Fatal(err)
	}
	if grant.FencingToken != token {
		t.Fatalf("fencing token %d, want %d", grant.FencingToken, token)
	}
}

func TestFiduciaCleartextRefusal(t *testing.T) {
	lease := NewFiduciaBearer("http://fiducia.example.com", "key")
	_, err := lease.Acquire(context.Background(), "t/f", DefaultAcquireOptions(), false)
	var le *Error
	if !errors.As(err, &le) || le.Kind != KindTransport {
		t.Fatalf("want transport refusal, got %v", err)
	}
	if err := NewFiduciaBearer("http://localhost:8090", "key").cleartextRefusal(); err != nil {
		t.Fatalf("localhost must be allowed: %v", err)
	}
}
