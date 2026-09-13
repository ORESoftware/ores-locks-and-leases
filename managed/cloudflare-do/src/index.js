const MAX_LOCK_KEY_BYTES = 512;
const MAX_TTL_MS = 86_400_000;
const MAX_U64 = (1n << 64n) - 1n;
const encoder = new TextEncoder();

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function parseBearer(request) {
  const auth = request.headers.get("authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : "";
}

function validKey(key) {
  return typeof key === "string" && encoder.encode(key).length <= MAX_LOCK_KEY_BYTES;
}

function validHolder(holder) {
  return typeof holder === "string" && holder.length > 0 && encoder.encode(holder).length <= 512;
}

function validTtl(ttl) {
  return Number.isSafeInteger(ttl) && ttl > 0 && ttl <= MAX_TTL_MS;
}

function validToken(token) {
  return typeof token === "string" && /^\d+$/.test(token) && BigInt(token) <= MAX_U64;
}

function nextToken(current) {
  if (typeof current !== "string" || !/^\d+$/.test(current)) {
    throw new Error("corrupt fencing counter");
  }
  const next = BigInt(current) + 1n;
  if (next > MAX_U64) throw new Error("unsigned-64 fencing token overflow");
  return next.toString();
}

export class LockLeaseObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS lease_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        holder TEXT,
        token TEXT,
        expires_ms INTEGER,
        next_token TEXT NOT NULL
      )
    `);
    this.sql.exec(`
      INSERT OR IGNORE INTO lease_state (id, holder, token, expires_ms, next_token)
      VALUES (1, NULL, NULL, NULL, '0')
    `);
  }

  row() {
    return this.sql.exec(
      "SELECT holder, token, expires_ms, next_token FROM lease_state WHERE id = 1",
    ).toArray()[0];
  }

  clearLease() {
    this.sql.exec(
      "UPDATE lease_state SET holder = NULL, token = NULL, expires_ms = NULL WHERE id = 1",
    );
  }

  async fetch(request) {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    const path = new URL(request.url).pathname;
    if (!validHolder(body?.holder)) return json({ error: "invalid_holder" }, 400);

    if (path === "/v1/leases/acquire") return this.acquire(body);
    if (path === "/v1/leases/renew") return this.renew(body);
    if (path === "/v1/leases/release") return this.release(body);
    return json({ error: "not_found" }, 404);
  }

  async acquire(body) {
    if (!validTtl(body?.ttl_ms)) return json({ error: "invalid_ttl" }, 400);
    const now = Date.now();
    const outcome = this.ctx.storage.transactionSync(() => {
      const row = this.row();
      if (row.holder !== null && row.expires_ms !== null && row.expires_ms > now) {
        return { acquired: false, lease_expires_ms: row.expires_ms };
      }

      const fencingToken = nextToken(row.next_token);
      const expires = now + body.ttl_ms;
      this.sql.exec(
        "UPDATE lease_state SET holder = ?, token = ?, expires_ms = ?, next_token = ? WHERE id = 1",
        body.holder,
        fencingToken,
        expires,
        fencingToken,
      );
      return { acquired: true, fencing_token: fencingToken, lease_expires_ms: expires };
    });

    if (outcome.acquired) await this.ctx.storage.setAlarm(outcome.lease_expires_ms);
    return json(outcome);
  }

  async renew(body) {
    if (!validTtl(body?.ttl_ms)) return json({ error: "invalid_ttl" }, 400);
    if (!validToken(body?.fencing_token)) return json({ error: "invalid_fencing_token" }, 400);
    const now = Date.now();
    const outcome = this.ctx.storage.transactionSync(() => {
      const row = this.row();
      if (
        row.holder !== body.holder ||
        row.token !== body.fencing_token ||
        row.expires_ms === null ||
        row.expires_ms <= now
      ) {
        if (row.expires_ms !== null && row.expires_ms <= now) this.clearLease();
        return { renewed: false };
      }
      const expires = now + body.ttl_ms;
      this.sql.exec("UPDATE lease_state SET expires_ms = ? WHERE id = 1", expires);
      return { renewed: true, lease_expires_ms: expires };
    });

    if (outcome.renewed) await this.ctx.storage.setAlarm(outcome.lease_expires_ms);
    return json(outcome);
  }

  async release(body) {
    if (!validToken(body?.fencing_token)) return json({ error: "invalid_fencing_token" }, 400);
    const now = Date.now();
    const released = this.ctx.storage.transactionSync(() => {
      const row = this.row();
      if (row.expires_ms !== null && row.expires_ms <= now) {
        this.clearLease();
        return false;
      }
      if (row.holder !== body.holder || row.token !== body.fencing_token) return false;
      this.clearLease();
      return true;
    });
    if (released) await this.ctx.storage.deleteAlarm();
    return json({ released });
  }

  async alarm() {
    const now = Date.now();
    const nextAlarm = this.ctx.storage.transactionSync(() => {
      const row = this.row();
      if (row.expires_ms === null) return null;
      if (row.expires_ms <= now) {
        this.clearLease();
        return null;
      }
      return row.expires_ms;
    });
    if (nextAlarm !== null) await this.ctx.storage.setAlarm(nextAlarm);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return json({ ok: true, authority: "cloudflare_durable_object" });
    if (!["/v1/leases/acquire", "/v1/leases/renew", "/v1/leases/release"].includes(url.pathname)) {
      return json({ error: "not_found" }, 404);
    }
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

    const allowUnauthenticated = env.ALLOW_UNAUTHENTICATED === "true";
    if (!env.ORES_LOCKS_API_TOKEN && !allowUnauthenticated) {
      return json({ error: "authority_not_configured" }, 503);
    }
    if (!allowUnauthenticated && parseBearer(request) !== env.ORES_LOCKS_API_TOKEN) {
      return json({ error: "unauthorized" }, 401);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    if (!validKey(body?.key)) return json({ error: "invalid_key" }, 400);

    const id = env.LOCKS.idFromName(body.key);
    const stub = env.LOCKS.get(id);
    return stub.fetch(`https://lock.internal${url.pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  },
};
