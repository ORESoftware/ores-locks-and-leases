const MAX_LOCK_KEY_BYTES = 512;
const MAX_HOLDER_BYTES = 512;
const MAX_REQUEST_ID_BYTES = 128;
const MAX_BODY_BYTES = 16_384;
const MAX_TTL_MS = 86_400_000;
// Keep the managed authority inside the exact JSON integer domain used by
// fiducia-cloud and browser/TypeScript consumers. Decimal text remains the wire
// representation for backwards compatibility, but values above this ceiling
// are never minted or accepted.
const MAX_FENCING_TOKEN = BigInt(Number.MAX_SAFE_INTEGER);
const encoder = new TextEncoder();
const CONTROL = /[\u0000-\u001f\u007f]/;

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

function validIdentity(value, maxBytes) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim().length > 0 &&
    !CONTROL.test(value) &&
    encoder.encode(value).length <= maxBytes
  );
}

function validKey(key) {
  return validIdentity(key, MAX_LOCK_KEY_BYTES);
}

function validHolder(holder) {
  return validIdentity(holder, MAX_HOLDER_BYTES);
}

function validRequestId(requestId) {
  return requestId === undefined || requestId === null || validIdentity(requestId, MAX_REQUEST_ID_BYTES);
}

function validTtl(ttl) {
  return Number.isSafeInteger(ttl) && ttl > 0 && ttl <= MAX_TTL_MS;
}

function canonicalToken(token) {
  if (typeof token === "number") {
    if (!Number.isSafeInteger(token) || token <= 0) return null;
    return String(token);
  }
  if (typeof token !== "string" || !/^[1-9][0-9]*$/.test(token)) return null;
  const value = BigInt(token);
  if (value > MAX_FENCING_TOKEN) return null;
  return value.toString();
}

function nextToken(current) {
  if (typeof current !== "string" || !/^(0|[1-9][0-9]*)$/.test(current)) {
    throw new Error("corrupt fencing counter");
  }
  const next = BigInt(current) + 1n;
  if (next > MAX_FENCING_TOKEN) {
    throw new Error("safe-integer fencing token exhausted");
  }
  return next.toString();
}

async function readJson(request) {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const bytes = Number(declared);
    if (Number.isFinite(bytes) && bytes > MAX_BODY_BYTES) {
      return { response: json({ error: "body_too_large" }, 413) };
    }
  }

  let text;
  try {
    text = await request.text();
  } catch {
    return { response: json({ error: "invalid_body" }, 400) };
  }
  if (encoder.encode(text).length > MAX_BODY_BYTES) {
    return { response: json({ error: "body_too_large" }, 413) };
  }
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { response: json({ error: "invalid_json" }, 400) };
  }
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
        next_token TEXT NOT NULL,
        request_id TEXT
      )
    `);
    // Existing deployments predate request_id. Migrate object-local SQLite
    // lazily and idempotently; Durable Object restarts may re-run constructors.
    const columns = this.sql.exec("PRAGMA table_info(lease_state)").toArray();
    if (!columns.some((column) => column.name === "request_id")) {
      this.sql.exec("ALTER TABLE lease_state ADD COLUMN request_id TEXT");
    }
    this.sql.exec(`
      INSERT OR IGNORE INTO lease_state (id, holder, token, expires_ms, next_token, request_id)
      VALUES (1, NULL, NULL, NULL, '0', NULL)
    `);
  }

  row() {
    return this.sql.exec(
      "SELECT holder, token, expires_ms, next_token, request_id FROM lease_state WHERE id = 1",
    ).toArray()[0];
  }

  clearLease() {
    this.sql.exec(
      "UPDATE lease_state SET holder = NULL, token = NULL, expires_ms = NULL, request_id = NULL WHERE id = 1",
    );
  }

  async fetch(request) {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const parsed = await readJson(request);
    if (parsed.response) return parsed.response;
    const body = parsed.body;
    const path = new URL(request.url).pathname;
    if (!validHolder(body?.holder)) return json({ error: "invalid_holder" }, 400);
    if (!validRequestId(body?.request_id)) return json({ error: "invalid_request_id" }, 400);

    if (path === "/v1/leases/acquire") return this.acquire(body);
    if (path === "/v1/leases/renew") return this.renew(body);
    if (path === "/v1/leases/release") return this.release(body);
    return json({ error: "not_found" }, 404);
  }

  async acquire(body) {
    if (!validTtl(body?.ttl_ms)) return json({ error: "invalid_ttl" }, 400);
    const now = Date.now();
    let outcome;
    try {
      outcome = this.ctx.storage.transactionSync(() => {
        const row = this.row();
        if (row.holder !== null && row.expires_ms !== null && row.expires_ms > now) {
          if (row.holder !== body.holder) {
            return { acquired: false, reason: "contention", lease_expires_ms: row.expires_ms };
          }
          // Durable-Object-style single-writer retry semantics: an ambiguous
          // acquisition can be retried by the same holder without minting a new
          // token or extending authority. A conflicting explicit request id is
          // rejected rather than silently aliasing two logical attempts.
          if (body.request_id && row.request_id && body.request_id !== row.request_id) {
            return {
              acquired: false,
              reason: "holder_active_different_request",
              lease_expires_ms: row.expires_ms,
            };
          }
          if (body.request_id && !row.request_id) {
            this.sql.exec("UPDATE lease_state SET request_id = ? WHERE id = 1", body.request_id);
          }
          return {
            acquired: true,
            fencing_token: row.token,
            lease_expires_ms: row.expires_ms,
            ttl_ms: body.ttl_ms,
            renewed: false,
            replayed: true,
          };
        }

        if (row.expires_ms !== null && row.expires_ms <= now) this.clearLease();
        const fencingToken = nextToken(row.next_token);
        const expires = now + body.ttl_ms;
        this.sql.exec(
          "UPDATE lease_state SET holder = ?, token = ?, expires_ms = ?, next_token = ?, request_id = ? WHERE id = 1",
          body.holder,
          fencingToken,
          expires,
          fencingToken,
          body.request_id ?? null,
        );
        return {
          acquired: true,
          fencing_token: fencingToken,
          lease_expires_ms: expires,
          ttl_ms: body.ttl_ms,
          renewed: false,
          replayed: false,
        };
      });
    } catch (error) {
      if (String(error).includes("fencing token exhausted")) {
        return json({ acquired: false, error: "fencing_token_exhausted" }, 503);
      }
      throw error;
    }

    // The alarm is cleanup, not authority. Every acquire/renew/release checks the
    // persisted expiry synchronously, so delayed or retried alarms cannot extend
    // a lease. Cloudflare may deliver an alarm more than once; alarm() is therefore
    // deliberately idempotent.
    if (outcome.acquired) await this.ctx.storage.setAlarm(outcome.lease_expires_ms);
    return json(outcome);
  }

  async renew(body) {
    if (!validTtl(body?.ttl_ms)) return json({ error: "invalid_ttl" }, 400);
    const token = canonicalToken(body?.fencing_token);
    if (token === null) return json({ error: "invalid_fencing_token" }, 400);
    const now = Date.now();
    const outcome = this.ctx.storage.transactionSync(() => {
      const row = this.row();
      if (
        row.holder !== body.holder ||
        row.token !== token ||
        row.expires_ms === null ||
        row.expires_ms <= now
      ) {
        const expired = row.expires_ms !== null && row.expires_ms <= now;
        if (expired) this.clearLease();
        return { renewed: false, reason: expired ? "expired" : "not_owner" };
      }
      const expires = now + body.ttl_ms;
      this.sql.exec("UPDATE lease_state SET expires_ms = ? WHERE id = 1", expires);
      return { renewed: true, lease_expires_ms: expires, ttl_ms: body.ttl_ms };
    });

    if (outcome.renewed) await this.ctx.storage.setAlarm(outcome.lease_expires_ms);
    return json(outcome);
  }

  async release(body) {
    const token = canonicalToken(body?.fencing_token);
    if (token === null) return json({ error: "invalid_fencing_token" }, 400);
    const now = Date.now();
    const outcome = this.ctx.storage.transactionSync(() => {
      const row = this.row();
      if (row.expires_ms !== null && row.expires_ms <= now) {
        this.clearLease();
        return { released: false, cleared_expired: true };
      }
      if (row.holder !== body.holder || row.token !== token) {
        return { released: false, cleared_expired: false };
      }
      this.clearLease();
      return { released: true, cleared_expired: false };
    });
    if (outcome.released || outcome.cleared_expired) await this.ctx.storage.deleteAlarm();
    return json({ released: outcome.released });
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
    if (url.pathname === "/healthz") {
      return json({
        ok: true,
        authority: "cloudflare_durable_object",
        fencing_token_max: Number.MAX_SAFE_INTEGER,
      });
    }
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

    const parsed = await readJson(request);
    if (parsed.response) return parsed.response;
    const body = parsed.body;
    if (!validKey(body?.key)) return json({ error: "invalid_key" }, 400);
    if (!validHolder(body?.holder)) return json({ error: "invalid_holder" }, 400);
    if (!validRequestId(body?.request_id)) return json({ error: "invalid_request_id" }, 400);

    const id = env.LOCKS.idFromName(body.key);
    const stub = env.LOCKS.get(id);
    return stub.fetch(`https://lock.internal${url.pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  },
};
