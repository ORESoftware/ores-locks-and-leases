import test from "node:test";
import assert from "node:assert/strict";

import worker, { LockLeaseObject } from "./src/index.js";

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
    };
  }

  exec(sql, ...args) {
    const statement = sql.replace(/\s+/g, " ").trim();
    if (statement.startsWith("CREATE TABLE IF NOT EXISTS lease_state")) return rows();
    if (statement.startsWith("INSERT OR IGNORE INTO lease_state")) return rows();
    if (statement.startsWith("SELECT holder, token, expires_ms, next_token")) {
      return rows([{ ...this.state }]);
    }
    if (statement.startsWith("UPDATE lease_state SET holder = NULL")) {
      this.state.holder = null;
      this.state.token = null;
      this.state.expires_ms = null;
      return rows();
    }
    if (statement.startsWith("UPDATE lease_state SET holder = ?, token = ?, expires_ms = ?, next_token = ?")) {
      const [holder, token, expires, nextToken] = args;
      this.state.holder = holder;
      this.state.token = token;
      this.state.expires_ms = expires;
      this.state.next_token = nextToken;
      return rows();
    }
    if (statement.startsWith("UPDATE lease_state SET expires_ms = ?")) {
      this.state.expires_ms = args[0];
      return rows();
    }
    throw new Error(`unexpected SQL in Durable Object test: ${statement}`);
  }
}

class FakeStorage {
  constructor() {
    this.sql = new FakeSql();
    this.alarm = null;
  }

  transactionSync(callback) {
    return callback();
  }

  async setAlarm(timestamp) {
    this.alarm = timestamp;
  }

  async deleteAlarm() {
    this.alarm = null;
  }
}

async function body(response) {
  return response.json();
}

test("Durable Object fencing tokens survive release and expiry", async (t) => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  t.after(() => {
    Date.now = originalNow;
  });

  const storage = new FakeStorage();
  const authority = new LockLeaseObject({ storage }, {});

  const first = await body(await authority.acquire({ holder: "worker-a", ttl_ms: 1_000 }));
  assert.deepEqual(first, {
    acquired: true,
    fencing_token: "1",
    lease_expires_ms: 2_000,
  });
  assert.equal(storage.alarm, 2_000);

  const contended = await body(await authority.acquire({ holder: "worker-b", ttl_ms: 1_000 }));
  assert.deepEqual(contended, { acquired: false, lease_expires_ms: 2_000 });

  const staleRenew = await body(await authority.renew({
    holder: "worker-a",
    fencing_token: "2",
    ttl_ms: 1_000,
  }));
  assert.deepEqual(staleRenew, { renewed: false });

  const renewed = await body(await authority.renew({
    holder: "worker-a",
    fencing_token: "1",
    ttl_ms: 2_000,
  }));
  assert.deepEqual(renewed, { renewed: true, lease_expires_ms: 3_000 });
  assert.equal(storage.alarm, 3_000);

  assert.deepEqual(
    await body(await authority.release({ holder: "worker-a", fencing_token: "1" })),
    { released: true },
  );
  assert.equal(storage.alarm, null);

  const second = await body(await authority.acquire({ holder: "worker-b", ttl_ms: 500 }));
  assert.equal(second.fencing_token, "2");
  assert.deepEqual(
    await body(await authority.release({ holder: "worker-a", fencing_token: "1" })),
    { released: false },
  );

  now = 2_000;
  const third = await body(await authority.acquire({ holder: "worker-c", ttl_ms: 500 }));
  assert.equal(third.fencing_token, "3", "expiry must not reuse a fencing token");

  now = 2_600;
  await authority.alarm();
  assert.equal(storage.sql.state.holder, null);
  assert.equal(storage.sql.state.token, null);
  assert.equal(storage.sql.state.next_token, "3", "reaping must preserve the fencing watermark");
});

test("public Worker fails closed and shards each non-empty lock key to one object", async () => {
  const names = [];
  const forwarded = [];
  const env = {
    ORES_LOCKS_API_TOKEN: "test-secret",
    ALLOW_UNAUTHENTICATED: "false",
    LOCKS: {
      idFromName(name) {
        names.push(name);
        return `id:${name}`;
      },
      get(id) {
        return {
          async fetch(url, init) {
            forwarded.push({ id, url, body: JSON.parse(init.body) });
            return new Response(JSON.stringify({ acquired: true, fencing_token: "9" }), {
              headers: { "content-type": "application/json" },
            });
          },
        };
      },
    },
  };

  const unauthorized = await worker.fetch(new Request("https://locks.example/v1/leases/acquire", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "tenant/resource", holder: "worker-a", ttl_ms: 1_000 }),
  }), env);
  assert.equal(unauthorized.status, 401);

  const emptyKey = await worker.fetch(new Request("https://locks.example/v1/leases/acquire", {
    method: "POST",
    headers: {
      authorization: "Bearer test-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify({ key: "", holder: "worker-a", ttl_ms: 1_000 }),
  }), env);
  assert.equal(emptyKey.status, 400);
  assert.deepEqual(await emptyKey.json(), { error: "invalid_key" });

  const response = await worker.fetch(new Request("https://locks.example/v1/leases/acquire", {
    method: "POST",
    headers: {
      authorization: "Bearer test-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify({ key: "tenant/resource", holder: "worker-a", ttl_ms: 1_000 }),
  }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { acquired: true, fencing_token: "9" });
  assert.deepEqual(names, ["tenant/resource"]);
  assert.deepEqual(forwarded, [{
    id: "id:tenant/resource",
    url: "https://lock.internal/v1/leases/acquire",
    body: { key: "tenant/resource", holder: "worker-a", ttl_ms: 1_000 },
  }]);
});

test("public Worker refuses production traffic when the authority token is absent", async () => {
  const env = {
    ALLOW_UNAUTHENTICATED: "false",
    LOCKS: {
      idFromName() {
        throw new Error("must not shard an unauthenticated request");
      },
    },
  };
  const response = await worker.fetch(new Request("https://locks.example/v1/leases/acquire", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "tenant/resource", holder: "worker-a", ttl_ms: 1_000 }),
  }), env);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "authority_not_configured" });
});
