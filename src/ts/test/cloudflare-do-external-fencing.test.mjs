import assert from "node:assert/strict";
import test from "node:test";

import { LockLeaseAuthority } from "../../../managed/cloudflare-do/src/authority.js";

function rows(items = []) {
  return { toArray: () => items };
}

class FakeSql {
  constructor() {
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
      return rows(["id", "holder", "token", "expires_ms", "next_token", "request_id"].map((name) => ({ name })));
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
  constructor() {
    this.sql = new FakeSql();
    this.alarm = null;
  }

  transactionSync(fn) { return fn(); }
  async setAlarm(at) { this.alarm = at; }
  async deleteAlarm() { this.alarm = null; }
}

function durableAuthority(storage) {
  return new LockLeaseAuthority({ storage });
}

function applyExternalWrite(watermark, request) {
  const incoming = BigInt(request.fencing_token);
  const current = BigInt(watermark.fencing_token);

  if (incoming < current) return "stale";
  if (incoming === current) {
    return request.operation_id === watermark.operation_id && request.payload_sha256 === watermark.payload_sha256
      ? "replay"
      : "token_reuse";
  }

  watermark.fencing_token = request.fencing_token;
  watermark.operation_id = request.operation_id;
  watermark.payload_sha256 = request.payload_sha256;
  return "advanced";
}

test("Durable Object authority persists its fence across instance replacement and external writes reject zombies", async (t) => {
  const originalNow = Date.now;
  let now = 10_000;
  Date.now = () => now;
  t.after(() => { Date.now = originalNow; });

  const storage = new FakeStorage();
  const incarnationA = durableAuthority(storage);
  const grantA = await incarnationA.acquire({
    holder: "worker-a",
    request_id: "acquire-a",
    ttl_ms: 1_000,
  });
  assert.equal(grantA.acquired, true);
  assert.equal(grantA.fencing_token, "1");
  assert.deepEqual(
    await incarnationA.release({ holder: "worker-a", fencing_token: grantA.fencing_token }),
    { released: true },
  );

  // Simulate Cloudflare replacing the in-memory Durable Object instance while
  // retaining its durable SQLite storage. The new instance must continue from
  // the persisted next_token watermark; process memory is not authority.
  now = 11_000;
  const incarnationB = durableAuthority(storage);
  const grantB = await incarnationB.acquire({
    holder: "worker-b",
    request_id: "acquire-b",
    ttl_ms: 1_000,
  });
  assert.equal(grantB.acquired, true);
  assert.equal(grantB.fencing_token, "2");
  assert.ok(BigInt(grantB.fencing_token) > BigInt(grantA.fencing_token));

  // The external datastore is a separate authority boundary. It persists the
  // largest token it accepted and rejects a delayed write from incarnation A.
  const externalWatermark = {
    fencing_token: "0",
    operation_id: "",
    payload_sha256: "",
  };
  const currentWrite = {
    fencing_token: grantB.fencing_token,
    operation_id: "op-b",
    payload_sha256: "b".repeat(64),
  };
  assert.equal(applyExternalWrite(externalWatermark, currentWrite), "advanced");
  assert.equal(applyExternalWrite(externalWatermark, currentWrite), "replay");

  const zombieWrite = {
    fencing_token: grantA.fencing_token,
    operation_id: "op-a-zombie",
    payload_sha256: "a".repeat(64),
  };
  assert.equal(applyExternalWrite(externalWatermark, zombieWrite), "stale");

  // Equal-token reuse for different work is not a retry; fail closed.
  assert.equal(
    applyExternalWrite(externalWatermark, {
      ...currentWrite,
      operation_id: "different-operation",
    }),
    "token_reuse",
  );
});
