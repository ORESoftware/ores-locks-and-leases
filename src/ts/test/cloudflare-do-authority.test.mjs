import assert from "node:assert/strict";
import test from "node:test";

import { LockLeaseAuthority } from "../../../managed/cloudflare-do/src/authority.js";

const MAX_SAFE_FENCING_TOKEN = "9007199254740991";
const MAX_U64_FENCING_TOKEN = "18446744073709551615";

function rows(items = []) {
  return { toArray: () => items };
}

class FakeSql {
  constructor({ legacy = false } = {}) {
    this.legacy = legacy;
    this.state = {
      holder: null,
      token: null,
      expires_ms: null,
      next_token: "0",
      request_id: null,
    };
  }

  exec(query, ...args) {
    const sql = query.replace(/\s+/g, " ").trim();
    if (sql.startsWith("CREATE TABLE IF NOT EXISTS lease_state")) return rows();
    if (sql === "PRAGMA table_info(lease_state)") {
      const columns = ["id", "holder", "token", "expires_ms", "next_token"];
      if (!this.legacy) columns.push("request_id");
      return rows(columns.map((name) => ({ name })));
    }
    if (sql === "ALTER TABLE lease_state ADD COLUMN request_id TEXT") {
      this.legacy = false;
      return rows();
    }
    if (sql.startsWith("INSERT OR IGNORE INTO lease_state")) return rows();
    if (sql.startsWith("SELECT holder, token, expires_ms, next_token, request_id FROM lease_state")) {
      return rows([{ ...this.state }]);
    }
    if (sql.startsWith("UPDATE lease_state SET holder = NULL")) {
      this.state.holder = null;
      this.state.token = null;
      this.state.expires_ms = null;
      this.state.request_id = null;
      return rows();
    }
    if (sql === "UPDATE lease_state SET request_id = ? WHERE id = 1") {
      [this.state.request_id] = args;
      return rows();
    }
    if (sql.startsWith("UPDATE lease_state SET holder = ?, token = ?, expires_ms = ?, next_token = ?, request_id = ?")) {
      [
        this.state.holder,
        this.state.token,
        this.state.expires_ms,
        this.state.next_token,
        this.state.request_id,
      ] = args;
      return rows();
    }
    if (sql === "UPDATE lease_state SET expires_ms = ? WHERE id = 1") {
      [this.state.expires_ms] = args;
      return rows();
    }
    throw new Error(`unexpected SQL in fake Durable Object storage: ${sql}`);
  }
}

class FakeStorage {
  constructor(options) {
    this.sql = new FakeSql(options);
    this.alarm = null;
  }

  transactionSync(fn) { return fn(); }
  async setAlarm(at) { this.alarm = at; }
  async deleteAlarm() { this.alarm = null; }
}

function authority(options) {
  const storage = new FakeStorage(options);
  return { authority: new LockLeaseAuthority({ storage }), storage };
}

test("RPC authority values preserve replay, explicit renewal, and fencing monotonicity", async (t) => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  t.after(() => { Date.now = originalNow; });

  const { authority: leases, storage } = authority({ legacy: true });
  assert.equal(storage.sql.legacy, false);

  const first = await leases.acquire({ holder: "worker-a", request_id: "attempt-1", ttl_ms: 1_000 });
  assert.equal(first.acquired, true);
  assert.equal(first.fencing_token, "1");
  assert.equal(first.replayed, false);

  now = 1_500;
  const replay = await leases.acquire({ holder: "worker-a", request_id: "attempt-1", ttl_ms: 50_000 });
  assert.equal(replay.acquired, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.lease_expires_ms, 2_000);
  assert.equal(storage.sql.state.expires_ms, 2_000);

  assert.deepEqual(
    await leases.renew({ holder: "worker-a", fencing_token: "1", ttl_ms: 1_000 }),
    { renewed: true, lease_expires_ms: 2_500, ttl_ms: 1_000 },
  );

  assert.deepEqual(
    await leases.release({ holder: "worker-a", fencing_token: "1" }),
    { released: true },
  );

  now = 3_000;
  const next = await leases.acquire({ holder: "worker-b", request_id: "attempt-2", ttl_ms: 1_000 });
  assert.equal(next.fencing_token, "2");
});

test("RPC authority advances safely past Number.MAX_SAFE_INTEGER using decimal text", async (t) => {
  const originalNow = Date.now;
  Date.now = () => 10_000;
  t.after(() => { Date.now = originalNow; });

  const { authority: leases, storage } = authority();
  storage.sql.state.next_token = MAX_SAFE_FENCING_TOKEN;
  const grant = await leases.acquire({ holder: "worker-wide", request_id: "attempt-wide", ttl_ms: 1_000 });
  assert.equal(grant.acquired, true);
  assert.equal(grant.fencing_token, "9007199254740992");
  assert.equal(storage.sql.state.next_token, "9007199254740992");
});

test("RPC authority fails closed only at uint64 exhaustion", async (t) => {
  const originalNow = Date.now;
  Date.now = () => 10_000;
  t.after(() => { Date.now = originalNow; });

  const { authority: leases, storage } = authority();
  storage.sql.state.next_token = MAX_U64_FENCING_TOKEN;
  assert.deepEqual(
    await leases.acquire({ holder: "worker-overflow", request_id: "attempt-overflow", ttl_ms: 1_000 }),
    { acquired: false, error: "fencing_token_exhausted" },
  );
  assert.equal(storage.sql.state.holder, null);
  assert.equal(storage.sql.state.next_token, MAX_U64_FENCING_TOKEN);
});
