import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_ACQUIRE_OPTIONS,
  FiduciaLease,
  LAYERS_BOTH,
  LAYERS_FIDUCIA_ONLY,
  LAYERS_NONE,
  LAYERS_PG_ONLY,
  LockError,
  advisoryKey,
  cleartextRefusal,
  fnv1a64,
  lockKey,
  plan,
  withLease,
  withSessionLock,
  withXactLock,
} from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const cases = (name) => JSON.parse(readFileSync(join(here, "..", "..", "..", "conformance", "cases", name), "utf8")).cases;

// --- conformance ------------------------------------------------------------

test("advisory-key vectors", () => {
  const vectors = cases("advisory-key.json");
  assert.ok(vectors.length >= 8);
  for (const c of vectors) {
    assert.equal(fnv1a64(c.key), BigInt(c.fnv1a64_unsigned), `fnv1a64(${JSON.stringify(c.key)})`);
    assert.equal(advisoryKey(c.key), BigInt(c.advisory_key), `advisoryKey(${JSON.stringify(c.key)})`);
  }
});

test("lock-plan matrix", () => {
  const matrix = cases("lock-plan.json");
  assert.equal(matrix.length, 11);
  for (const c of matrix) {
    assert.deepEqual(plan(c.layers, c.pgScope, c.wait).steps, c.expect.steps, c.name);
  }
});

test("lock keys are length-bounded in bytes", () => {
  assert.equal(lockKey("a".repeat(512)), "a".repeat(512));
  assert.throws(() => lockKey("é".repeat(300)), RangeError);
});

// --- fakes ------------------------------------------------------------------

function fakeLease({ held = false, lapseOnRelease = false } = {}) {
  const lease = {
    held,
    next: 0n,
    log: [],
    async acquire(key, opts, wait) {
      lease.log.push(wait ? "fiducia.acquire" : "fiducia.try_acquire");
      if (lease.held) throw wait ? LockError.timeout(key, "fiducia.acquire", opts.waitTimeoutMs) : LockError.contention(key, "fiducia.try_acquire");
      lease.held = true;
      lease.next += 1n;
      return { key, holder: "fake", fencingToken: lease.next, ttlMs: opts.ttlMs };
    },
    async renew(grant, ttlMs) {
      return { ...grant, ttlMs };
    },
    async release() {
      lease.log.push("fiducia.release");
      lease.held = false;
      return !lapseOnRelease;
    },
  };
  return lease;
}

/** A node-postgres-shaped pool that records statements; try-locks answer `acquired`. */
function fakePool({ acquired = true, unlocked = true } = {}) {
  const pool = {
    log: [],
    released: [],
    async connect() {
      pool.log.push("CONNECT");
      return {
        async query(text) {
          pool.log.push(text);
          if (text.startsWith("SELECT pg_try_advisory")) return { rows: [{ pg_try: acquired }] };
          if (text.startsWith("SELECT pg_advisory_unlock")) return { rows: [{ pg_advisory_unlock: unlocked }] };
          return { rows: [] };
        },
        release(err) {
          pool.released.push(err ?? false);
        },
      };
    },
  };
  return pool;
}

const key = lockKey("t/unit");

// --- withLease --------------------------------------------------------------

test("withLease: disabled layer is a pass-through", async () => {
  const lease = fakeLease();
  const value = await withLease(key, false, true, DEFAULT_ACQUIRE_OPTIONS, lease, async (g) => g.grant === undefined);
  assert.equal(value, true);
  assert.deepEqual(lease.log, []);
});

test("withLease: enabled without an authority is invalid_plan", async () => {
  await assert.rejects(
    withLease(key, true, true, DEFAULT_ACQUIRE_OPTIONS, undefined, async () => 1),
    (err) => err instanceof LockError && err.kind === "invalid_plan",
  );
});

test("withLease: acquire → work → release with a fencing token", async () => {
  const lease = fakeLease();
  const token = await withLease(key, true, true, DEFAULT_ACQUIRE_OPTIONS, lease, async (g) => g.grant.fencingToken);
  assert.equal(token, 1n);
  assert.deepEqual(lease.log, ["fiducia.acquire", "fiducia.release"]);
  assert.equal(lease.held, false);
});

test("withLease: work failure still releases and is reported as work", async () => {
  const lease = fakeLease();
  await assert.rejects(
    withLease(key, true, false, DEFAULT_ACQUIRE_OPTIONS, lease, async () => {
      throw new Error("kaboom");
    }),
    (err) => err instanceof LockError && err.kind === "work" && err.step === "work" && err.message === "kaboom",
  );
  assert.equal(lease.held, false);
});

test("withLease: contention without wait, timeout with wait, lost_lease on lapse", async () => {
  const busy = fakeLease({ held: true });
  await assert.rejects(withLease(key, true, false, DEFAULT_ACQUIRE_OPTIONS, busy, async () => 1), (e) => e.kind === "contention" && e.retryable);
  await assert.rejects(withLease(key, true, true, DEFAULT_ACQUIRE_OPTIONS, busy, async () => 1), (e) => e.kind === "timeout");
  const lapsing = fakeLease({ lapseOnRelease: true });
  await assert.rejects(withLease(key, true, true, DEFAULT_ACQUIRE_OPTIONS, lapsing, async () => 1), (e) => e.kind === "lost_lease" && e.step === "fiducia.release");
});

// --- withXactLock -----------------------------------------------------------

test("withXactLock: both layers, fiducia wraps the transaction", async () => {
  const lease = fakeLease();
  const pool = fakePool();
  const value = await withXactLock(key, LAYERS_BOTH, true, DEFAULT_ACQUIRE_OPTIONS, lease, pool, async (g) => {
    assert.ok(g.client, "client present");
    assert.equal(g.grant.fencingToken, 1n);
    pool.log.push("WORK");
    return "done";
  });
  assert.equal(value, "done");
  assert.deepEqual(pool.log, ["CONNECT", "BEGIN", "SELECT pg_advisory_xact_lock($1)", "WORK", "COMMIT"]);
  assert.deepEqual(lease.log, ["fiducia.acquire", "fiducia.release"]);
  assert.deepEqual(pool.released, [false]);
});

test("withXactLock: work failure rolls back, releases the lease, returns the client as errored", async () => {
  const lease = fakeLease();
  const pool = fakePool();
  await assert.rejects(
    withXactLock(key, LAYERS_BOTH, false, DEFAULT_ACQUIRE_OPTIONS, lease, pool, async () => {
      throw new Error("nope");
    }),
    (e) => e.kind === "work",
  );
  assert.equal(pool.log.at(-1), "ROLLBACK");
  assert.equal(pool.log[2], "SELECT pg_try_advisory_xact_lock($1)");
  assert.equal(lease.held, false);
  assert.deepEqual(pool.released, [true]);
});

test("withXactLock: pg contention releases the lease and never runs work", async () => {
  const lease = fakeLease();
  const pool = fakePool({ acquired: false });
  await assert.rejects(
    withXactLock(key, LAYERS_BOTH, false, DEFAULT_ACQUIRE_OPTIONS, lease, pool, async () => assert.fail("work ran")),
    (e) => e.kind === "contention" && e.step === "pg.try_advisory_xact_lock",
  );
  assert.equal(pool.log.at(-1), "ROLLBACK");
  assert.equal(lease.held, false);
});

test("withXactLock: neither layer is a pass-through; missing inputs are invalid_plan", async () => {
  assert.equal(await withXactLock(key, LAYERS_NONE, true, DEFAULT_ACQUIRE_OPTIONS, undefined, undefined, async (g) => g.client === undefined && g.grant === undefined), true);
  await assert.rejects(withXactLock(key, LAYERS_PG_ONLY, true, DEFAULT_ACQUIRE_OPTIONS, undefined, undefined, async () => 1), (e) => e.kind === "invalid_plan");
  await assert.rejects(withXactLock(key, LAYERS_FIDUCIA_ONLY, true, DEFAULT_ACQUIRE_OPTIONS, undefined, fakePool(), async () => 1), (e) => e.kind === "invalid_plan");
});

// --- withSessionLock --------------------------------------------------------

test("withSessionLock: no transaction, lock → work → unlock on one client", async () => {
  const pool = fakePool();
  await withSessionLock(key, LAYERS_PG_ONLY, false, DEFAULT_ACQUIRE_OPTIONS, undefined, pool, async (g) => {
    assert.ok(g.client);
    pool.log.push("WORK");
  });
  assert.deepEqual(pool.log, ["CONNECT", "SELECT pg_try_advisory_lock($1)", "WORK", "SELECT pg_advisory_unlock($1)"]);
  assert.ok(!pool.log.includes("BEGIN"));
});

test("withSessionLock: unlock mismatch is a database error at pg.advisory_unlock", async () => {
  const pool = fakePool({ unlocked: false });
  await assert.rejects(
    withSessionLock(key, LAYERS_PG_ONLY, true, DEFAULT_ACQUIRE_OPTIONS, undefined, pool, async () => 1),
    (e) => e.kind === "database" && e.step === "pg.advisory_unlock",
  );
});

// --- fiducia over a fake fetch ---------------------------------------------

function fakeNode() {
  const node = { holder: "", token: 0, requests: [], headers: undefined };
  node.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    node.requests.push(path);
    node.headers = init.headers;
    const body = JSON.parse(init.body);
    let output;
    if (path === "/v1/locks/acquire") {
      if (!node.holder) {
        node.holder = body.holder;
        node.token += 1;
        output = { acquired: true, fencing_token: node.token, lease_expires_ms: 123456 };
      } else output = { acquired: false };
    } else if (path === "/v1/locks/renew") {
      output = { renewed: body.holder === node.holder, lease_expires_ms: 234567 };
    } else if (path === "/v1/locks/release") {
      const released = body.holder === node.holder && body.fencing_token === node.token;
      if (released) node.holder = "";
      output = { released };
    } else return { status: 404, text: async () => "" };
    return { status: 200, text: async () => JSON.stringify({ result: { output } }) };
  };
  return node;
}

test("FiduciaLease speaks the node protocol", async () => {
  const node = fakeNode();
  const lease = new FiduciaLease({ baseUrl: "http://fiducia.internal:8090/", internal: { secret: "s", orgId: "org-1" }, fetch: node.fetch });
  const opts = { ...DEFAULT_ACQUIRE_OPTIONS, holder: "svc-a" };
  const grant = await lease.acquire(key, opts, true);
  assert.equal(grant.fencingToken, 1n);
  assert.equal(grant.leaseExpiresMs, 123456);
  assert.equal(node.headers["x-fiducia-internal-auth"], "s");
  assert.equal(node.headers["x-fiducia-org-id"], "org-1");

  const other = { ...opts, holder: "svc-b" };
  await assert.rejects(lease.acquire(key, other, false), (e) => e.kind === "contention");
  await assert.rejects(lease.acquire(key, { ...other, waitTimeoutMs: 30, retryIntervalMs: 10 }, true), (e) => e.kind === "timeout");

  const renewed = await lease.renew(grant, 5000);
  assert.equal(renewed.leaseExpiresMs, 234567);
  await assert.rejects(lease.renew({ ...grant, holder: "someone-else" }, 1000), (e) => e.kind === "lost_lease");

  assert.equal(await lease.release(grant), true);
  assert.equal(await lease.release(grant), false);
});

test("FiduciaLease refuses credentials over cleartext to non-local hosts", async () => {
  assert.ok(cleartextRefusal("http://fiducia.example.com", true, false));
  assert.equal(cleartextRefusal("http://localhost:8090", true, false), undefined);
  assert.equal(cleartextRefusal("http://fiducia-node.fiducia.svc", true, false), undefined);
  assert.equal(cleartextRefusal("https://fiducia.example.com", true, false), undefined);
  const lease = new FiduciaLease({ baseUrl: "http://fiducia.example.com", apiKey: "k", fetch: async () => assert.fail("must not send") });
  await assert.rejects(lease.acquire(key, DEFAULT_ACQUIRE_OPTIONS, false), (e) => e.kind === "transport");
});
