import assert from "node:assert/strict";
import test from "node:test";

import { LockLeaseAuthority } from "../../../managed/cloudflare-do/src/authority.js";

function rows(items = []) { return { toArray: () => items }; }

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
      return rows(["id", "holder", "token", "expires_ms", "next_token", "request_id"].map((name) => ({name})));
    }
    if (sql.startsWith("INSERT OR IGNORE INTO lease_state")) return rows();
    if (sql.startsWith("SELECT holder, token, expires_ms, next_token, request_id FROM lease_state")) {
      return rows([{...this.state}]);
    }
    if (sql.startsWith("UPDATE lease_state SET holder = NULL")) {
      Object.assign(this.state, {holder: null, token: null, expires_ms: null, request_id: null});
      return rows();
    }
    if (sql === "UPDATE lease_state SET request_id = ? WHERE id = 1") {
      [this.state.request_id] = args; return rows();
    }
    if (sql.startsWith("UPDATE lease_state SET holder = ?, token = ?, expires_ms = ?, next_token = ?, request_id = ?")) {
      [this.state.holder, this.state.token, this.state.expires_ms, this.state.next_token, this.state.request_id] = args;
      return rows();
    }
    if (sql === "UPDATE lease_state SET expires_ms = ? WHERE id = 1") {
      [this.state.expires_ms] = args; return rows();
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }
}

class FakeStorage {
  constructor() { this.sql = new FakeSql(); this.alarm = null; }
  transactionSync(fn) { return fn(); }
  async setAlarm(at) { this.alarm = at; }
  async deleteAlarm() { this.alarm = null; }
}

function makeAuthority() {
  const storage = new FakeStorage();
  return {storage, authority: new LockLeaseAuthority({storage})};
}

test("corrupt persisted fencing watermark fails closed without minting authority", async () => {
  const {storage, authority} = makeAuthority();
  storage.sql.state.next_token = "01";
  await assert.rejects(
    authority.acquire({holder: "a", request_id: "r1", ttl_ms: 1000}),
    /corrupt fencing counter/,
  );
  assert.equal(storage.sql.state.holder, null);
  assert.equal(storage.sql.state.token, null);
  assert.equal(storage.sql.state.next_token, "01");
});

test("renew and release reject malformed, non-positive, or out-of-domain token authority", async () => {
  const {authority} = makeAuthority();
  for (const fencing_token of [
    undefined,
    null,
    0,
    -1,
    1.5,
    true,
    "0",
    "01",
    "+1",
    "1.0",
    " 1",
    9_007_199_254_740_992,
    "18446744073709551616",
  ]) {
    assert.deepEqual(
      await authority.renew({holder: "a", fencing_token, ttl_ms: 1000}),
      {renewed: false, error: "invalid_fencing_token"},
      `renew admitted ${String(fencing_token)}`,
    );
    assert.deepEqual(
      await authority.release({holder: "a", fencing_token}),
      {released: false, error: "invalid_fencing_token"},
      `release admitted ${String(fencing_token)}`,
    );
  }
});

test("renew and release preserve full-width decimal token authority", async (t) => {
  const originalNow = Date.now;
  let now = 10_000;
  Date.now = () => now;
  t.after(() => { Date.now = originalNow; });

  const {storage, authority} = makeAuthority();
  storage.sql.state.next_token = "9007199254740991";

  const grant = await authority.acquire({holder: "wide", request_id: "wide-1", ttl_ms: 1000});
  assert.equal(grant.fencing_token, "9007199254740992");

  now = 10_100;
  assert.deepEqual(
    await authority.renew({holder: "wide", fencing_token: "9007199254740992", ttl_ms: 1000}),
    {renewed: true, lease_expires_ms: 11_100, ttl_ms: 1000},
  );
  assert.deepEqual(
    await authority.release({holder: "wide", fencing_token: "9007199254740992"}),
    {released: true},
  );
});

test("superseded owner cannot renew or release successor authority", async (t) => {
  const originalNow = Date.now;
  let now = 10_000;
  Date.now = () => now;
  t.after(() => { Date.now = originalNow; });

  const {authority} = makeAuthority();
  const a = await authority.acquire({holder: "a", request_id: "a1", ttl_ms: 1000});
  assert.equal(a.fencing_token, "1");
  assert.deepEqual(await authority.release({holder: "a", fencing_token: "1"}), {released: true});

  now = 11_000;
  const b = await authority.acquire({holder: "b", request_id: "b1", ttl_ms: 1000});
  assert.equal(b.fencing_token, "2");

  assert.deepEqual(
    await authority.renew({holder: "a", fencing_token: "1", ttl_ms: 5000}),
    {renewed: false, reason: "not_owner"},
  );
  assert.deepEqual(
    await authority.release({holder: "a", fencing_token: "1"}),
    {released: false, reason: "not_owner"},
  );

  // The failed stale operations must not disturb B's grant.
  assert.deepEqual(
    await authority.renew({holder: "b", fencing_token: "2", ttl_ms: 1000}),
    {renewed: true, lease_expires_ms: 12_000, ttl_ms: 1000},
  );
});
