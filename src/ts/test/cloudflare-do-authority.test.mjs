import assert from "node:assert/strict";
import test from "node:test";

import { LockLeaseObject } from "../../../managed/cloudflare-do/src/index.js";

const MAX_SAFE_FENCING_TOKEN = "9007199254740991";

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
      this.state.request_id = null;
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
    this.deletedAlarms = 0;
  }

  transactionSync(fn) {
    return fn();
  }

  async setAlarm(at) {
    this.alarm = at;
  }

  async deleteAlarm() {
    this.alarm = null;
    this.deletedAlarms += 1;
  }
}

function authority(options) {
  const storage = new FakeStorage(options);
  return {
    object: new LockLeaseObject({ storage }, {}),
    storage,
  };
}

async function post(object, path, body) {
  const response = await object.fetch(new Request(`https://lock.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { response, body: await response.json() };
}

test("Durable Object authority replays without extending, renews explicitly, and recovers from alarms/restarts", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const { object, storage } = authority({ legacy: true });
    assert.equal(storage.sql.legacy, false, "constructor migrates pre-request_id object storage");

    let result = await post(object, "/v1/leases/acquire", {
      holder: "worker-a",
      request_id: "attempt-1",
      ttl_ms: 1_000,
    });
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body, {
      acquired: true,
      fencing_token: "1",
      lease_expires_ms: 2_000,
      ttl_ms: 1_000,
      renewed: false,
      replayed: false,
    });
    assert.equal(storage.alarm, 2_000);

    now = 1_500;
    result = await post(object, "/v1/leases/acquire", {
      holder: "worker-a",
      request_id: "attempt-1",
      ttl_ms: 50_000,
    });
    assert.equal(result.body.acquired, true);
    assert.equal(result.body.replayed, true);
    assert.equal(result.body.fencing_token, "1");
    assert.equal(result.body.lease_expires_ms, 2_000);
    assert.equal("ttl_ms" in result.body, false, "replay must not imply that requested TTL was granted");
    assert.equal(storage.sql.state.next_token, "1");
    assert.equal(storage.sql.state.expires_ms, 2_000, "acquire replay must not extend authority");

    result = await post(object, "/v1/leases/acquire", {
      holder: "worker-a",
      request_id: "different-logical-attempt",
      ttl_ms: 1_000,
    });
    assert.equal(result.body.acquired, false);
    assert.equal(result.body.reason, "holder_active_different_request");
    assert.equal(storage.sql.state.next_token, "1");

    result = await post(object, "/v1/leases/renew", {
      holder: "worker-a",
      fencing_token: "1",
      ttl_ms: 1_000,
    });
    assert.deepEqual(result.body, {
      renewed: true,
      lease_expires_ms: 2_500,
      ttl_ms: 1_000,
    });
    assert.equal(storage.alarm, 2_500);

    now = 2_000;
    await object.alarm();
    assert.equal(storage.sql.state.holder, "worker-a", "early/retried alarm cannot revoke a live grant");
    assert.equal(storage.alarm, 2_500, "early alarm is rescheduled to persisted expiry");

    now = 2_500;
    await object.alarm();
    assert.equal(storage.sql.state.holder, null);
    assert.equal(storage.sql.state.token, null);
    assert.equal(storage.sql.state.next_token, "1", "cleanup never resets the fencing watermark");

    now = 3_000;
    result = await post(object, "/v1/leases/acquire", {
      holder: "worker-b",
      request_id: "attempt-2",
      ttl_ms: 1_000,
    });
    assert.equal(result.body.fencing_token, "2", "post-expiry acquisition receives a strictly newer fence");

    result = await post(object, "/v1/leases/release", {
      holder: "worker-a",
      fencing_token: "1",
    });
    assert.equal(result.body.released, false, "stale holder/token cannot release a newer grant");
    assert.equal(storage.sql.state.holder, "worker-b");
  } finally {
    Date.now = originalNow;
  }
});

test("Durable Object authority fails closed when the exact-JSON fencing domain is exhausted", async () => {
  const originalNow = Date.now;
  Date.now = () => 10_000;
  try {
    const { object, storage } = authority();
    storage.sql.state.next_token = MAX_SAFE_FENCING_TOKEN;

    const result = await post(object, "/v1/leases/acquire", {
      holder: "worker-overflow",
      request_id: "attempt-overflow",
      ttl_ms: 1_000,
    });
    assert.equal(result.response.status, 503);
    assert.deepEqual(result.body, {
      acquired: false,
      error: "fencing_token_exhausted",
    });
    assert.equal(storage.sql.state.holder, null);
    assert.equal(storage.sql.state.next_token, MAX_SAFE_FENCING_TOKEN);
  } finally {
    Date.now = originalNow;
  }
});
