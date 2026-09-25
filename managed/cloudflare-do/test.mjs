import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { LockLeaseAuthority } from "./src/authority.js";
import {
  MAX_BODY_BYTES,
  bearerMatches,
  internalBody,
  productionMode,
  readBoundedJson,
  validateInternalOperation,
  validatePublicOperation,
} from "./src/http-boundary.js";

const MAX_SAFE_FENCING_TOKEN = "9007199254740991";
const MAX_U64_FENCING_TOKEN = "18446744073709551615";
const ABOVE_MAX_U64_FENCING_TOKEN = "18446744073709551616";

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
  return { authority: new LockLeaseAuthority({ storage }), storage };
}

test("Durable Object authority replays without extending and renews only by token", async (t) => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  t.after(() => { Date.now = originalNow; });

  const { authority: leases, storage } = authority({ legacy: true });
  assert.equal(storage.sql.legacy, false);

  const first = await leases.acquire({ holder: "worker-a", request_id: "attempt-1", ttl_ms: 1_000 });
  assert.deepEqual(first, {
    acquired: true,
    fencing_token: "1",
    lease_expires_ms: 2_000,
    ttl_ms: 1_000,
    renewed: false,
    replayed: false,
  });

  now = 1_500;
  const replay = await leases.acquire({ holder: "worker-a", request_id: "attempt-1", ttl_ms: 50_000 });
  assert.equal(replay.acquired, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.fencing_token, "1");
  assert.equal(replay.lease_expires_ms, 2_000);
  assert.equal(storage.sql.state.expires_ms, 2_000, "replay cannot extend authority");

  const differentAttempt = await leases.acquire({
    holder: "worker-a",
    request_id: "attempt-2",
    ttl_ms: 1_000,
  });
  assert.equal(differentAttempt.acquired, false);
  assert.equal(differentAttempt.reason, "holder_active_different_request");

  const renewed = await leases.renew({ holder: "worker-a", fencing_token: "1", ttl_ms: 1_000 });
  assert.deepEqual(renewed, { renewed: true, lease_expires_ms: 2_500, ttl_ms: 1_000 });
  assert.equal(storage.alarm, 2_500);

  const staleRelease = await leases.release({ holder: "worker-a", fencing_token: "2" });
  assert.deepEqual(staleRelease, { released: false, reason: "not_owner" });
  assert.equal(storage.sql.state.holder, "worker-a");

  now = 2_500;
  await leases.alarm();
  assert.equal(storage.sql.state.holder, null);
  assert.equal(storage.sql.state.next_token, "1");

  now = 3_000;
  const second = await leases.acquire({ holder: "worker-b", request_id: "attempt-3", ttl_ms: 1_000 });
  assert.equal(second.fencing_token, "2");
});

test("Durable Object authority fails closed at the public cross-runtime fencing ceiling", async (t) => {
  const originalNow = Date.now;
  Date.now = () => 10_000;
  t.after(() => { Date.now = originalNow; });

  const { authority: exhaustedLeases, storage: exhaustedStorage } = authority();
  exhaustedStorage.sql.state.next_token = MAX_SAFE_FENCING_TOKEN;
  assert.deepEqual(
    await exhaustedLeases.acquire({ holder: "worker-overflow", request_id: "overflow", ttl_ms: 1_000 }),
    { acquired: false, error: "fencing_token_exhausted" },
  );
  assert.equal(exhaustedStorage.sql.state.holder, null);
  assert.equal(exhaustedStorage.sql.state.next_token, MAX_SAFE_FENCING_TOKEN);
});

test("HTTP boundary rejects unknown fields and invalid operation values", () => {
  assert.equal(
    validatePublicOperation("/v1/leases/acquire", {
      key: "zed-pkg/registry/publish",
      holder: "worker-a",
      ttl_ms: 1_000,
      surprise: true,
    }),
    "unknown_field",
  );
  assert.equal(
    validatePublicOperation("/v1/leases/acquire", {
      key: "x".repeat(513),
      holder: "worker-a",
      ttl_ms: 1_000,
    }),
    "invalid_key",
  );
  assert.equal(
    validatePublicOperation("/v1/leases/renew", {
      key: "shared-auth/session/rotate",
      holder: "worker-a",
      ttl_ms: 1_000,
      fencing_token: "9007199254740992",
    }),
    "invalid_fencing_token",
  );
  assert.equal(
    validatePublicOperation("/v1/leases/renew", {
      key: "shared-auth/session/rotate",
      holder: "worker-a",
      ttl_ms: 1_000,
      fencing_token: ABOVE_MAX_U64_FENCING_TOKEN,
    }),
    "invalid_fencing_token",
  );
  assert.equal(
    validateInternalOperation("/v1/leases/acquire", { holder: "worker-a", ttl_ms: 0 }),
    "invalid_ttl",
  );
});

test("HTTP boundary canonicalizes internal RPC bodies and strips public routing identity", () => {
  assert.deepEqual(
    internalBody("/v1/leases/acquire", {
      key: "fiducia-cloud/election/leader",
      holder: "worker-a",
      ttl_ms: 5_000,
      request_id: "attempt-9",
    }),
    { holder: "worker-a", ttl_ms: 5_000, request_id: "attempt-9" },
  );
  assert.deepEqual(
    internalBody("/v1/leases/renew", {
      key: "fiducia-cloud/election/leader",
      holder: "worker-a",
      ttl_ms: 5_000,
      fencing_token: 7,
    }),
    { holder: "worker-a", ttl_ms: 5_000, fencing_token: "7" },
  );
});

test("bounded JSON reader rejects bad lengths and oversized streams", async () => {
  const badLength = new Request("https://locks.example.test/v1/leases/acquire", {
    method: "POST",
    headers: { "content-length": "nan" },
    body: "{}",
  });
  assert.deepEqual(await readBoundedJson(badLength), {
    error: "invalid_content_length",
    status: 400,
  });

  const declaredTooLarge = new Request("https://locks.example.test/v1/leases/acquire", {
    method: "POST",
    headers: { "content-length": String(MAX_BODY_BYTES + 1) },
    body: "{}",
  });
  assert.deepEqual(await readBoundedJson(declaredTooLarge), {
    error: "body_too_large",
    status: 413,
  });

  const streamedTooLarge = new Request("https://locks.example.test/v1/leases/acquire", {
    method: "POST",
    body: "x".repeat(MAX_BODY_BYTES + 1),
  });
  assert.deepEqual(await readBoundedJson(streamedTooLarge), {
    error: "body_too_large",
    status: 413,
  });

  const valid = new Request("https://locks.example.test/v1/leases/acquire", {
    method: "POST",
    body: JSON.stringify({ holder: "worker-a" }),
  });
  assert.deepEqual(await readBoundedJson(valid), { body: { holder: "worker-a" } });
});

test("bearer comparison is scheme-case tolerant but value exact", async () => {
  const good = new Request("https://locks.example.test", {
    headers: { authorization: "bearer correct-secret" },
  });
  const bad = new Request("https://locks.example.test", {
    headers: { authorization: "Bearer wrong-secret" },
  });
  assert.equal(await bearerMatches(good, "correct-secret"), true);
  assert.equal(await bearerMatches(bad, "correct-secret"), false);
  assert.equal(await bearerMatches(good, ""), false);
});

test("production mode recognizes prod aliases and prevents dev-mode ambiguity", () => {
  assert.equal(productionMode({ ORES_LOCKS_ENVIRONMENT: "production" }), true);
  assert.equal(productionMode({ ORES_LOCKS_ENVIRONMENT: "PROD" }), true);
  assert.equal(productionMode({ ORES_LOCKS_ENVIRONMENT: "staging" }), false);
});

test("deployed wrapper is RPC-native while retaining the HTTP adapter", async () => {
  const source = await readFile(new URL("./src/index.js", import.meta.url), "utf8");
  assert.match(source, /class LockLeaseObject extends DurableObject/);
  assert.match(source, /env\.LOCKS\.getByName\(decoded\.body\.key\)/);
  assert.match(source, /stub\.acquire\(body\)/);
  assert.match(source, /stub\.renew\(body\)/);
  assert.match(source, /stub\.release\(body\)/);
  assert.match(source, /Backwards-compatible stub\.fetch adapter/);
  assert.match(source, /unsafe_configuration/);
  assert.match(source, /authority_rpc_failed/);
});