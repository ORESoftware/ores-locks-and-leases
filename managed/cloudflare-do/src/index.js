const MAX_LOCK_KEY_BYTES = 512;
const MAX_HOLDER_BYTES = 512;
const MAX_BODY_BYTES = 8 * 1024;
const MAX_TTL_MS = 86_400_000;
const MAX_U64 = (1n << 64n) - 1n;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const PUBLIC_FIELDS = {
  "/v1/leases/acquire": new Set(["key", "holder", "ttl_ms"]),
  "/v1/leases/renew": new Set(["key", "holder", "ttl_ms", "fencing_token"]),
  "/v1/leases/release": new Set(["key", "holder", "fencing_token"]),
};

const INTERNAL_FIELDS = {
  "/v1/leases/acquire": new Set(["holder", "ttl_ms"]),
  "/v1/leases/renew": new Set(["holder", "ttl_ms", "fencing_token"]),
  "/v1/leases/release": new Set(["holder", "fencing_token"]),
};

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

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

async function bearerMatches(request, expected) {
  if (typeof expected !== "string" || expected.length === 0) return false;
  const supplied = parseBearer(request);
  const [actualDigest, expectedDigest] = await Promise.all([sha256(supplied), sha256(expected)]);
  let difference = 0;
  for (let index = 0; index < expectedDigest.length; index += 1) {
    difference |= actualDigest[index] ^ expectedDigest[index];
  }
  return difference === 0;
}

function validKey(key) {
  if (typeof key !== "string") return false;
  const bytes = encoder.encode(key).length;
  return bytes > 0 && bytes <= MAX_LOCK_KEY_BYTES;
}

function validHolder(holder) {
  if (typeof holder !== "string") return false;
  const bytes = encoder.encode(holder).length;
  return bytes > 0 && bytes <= MAX_HOLDER_BYTES;
}

function validTtl(ttl) {
  return Number.isSafeInteger(ttl) && ttl > 0 && ttl <= MAX_TTL_MS;
}

function validToken(token) {
  return (
    typeof token === "string" &&
    /^[1-9][0-9]{0,19}$/.test(token) &&
    BigInt(token) <= MAX_U64
  );
}

function validCounter(token) {
  return (
    typeof token === "string" &&
    /^(0|[1-9][0-9]{0,19})$/.test(token) &&
    BigInt(token) <= MAX_U64
  );
}

function nextToken(current) {
  if (!validCounter(current)) throw new Error("corrupt fencing counter");
  const next = BigInt(current) + 1n;
  if (next > MAX_U64) throw new Error("unsigned-64 fencing token overflow");
  return next.toString();
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyFields(body, allowed) {
  return isPlainObject(body) && Object.keys(body).every((field) => allowed.has(field));
}

function validateOperation(path, body, fields, requireKey) {
  const allowed = fields[path];
  if (!allowed || !isPlainObject(body)) return "invalid_body";
  if (!hasOnlyFields(body, allowed)) return "unknown_field";
  if (requireKey && !validKey(body.key)) return "invalid_key";
  if (!validHolder(body.holder)) return "invalid_holder";
  if (path !== "/v1/leases/release" && !validTtl(body.ttl_ms)) return "invalid_ttl";
  if (path !== "/v1/leases/acquire" && !validToken(body.fencing_token)) {
    return "invalid_fencing_token";
  }
  return null;
}

async function readBoundedJson(request) {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      return { response: json({ error: "invalid_content_length" }, 400) };
    }
    if (parsed > MAX_BODY_BYTES) return { response: json({ error: "body_too_large" }, 413) };
  }

  if (request.body === null) return { response: json({ error: "invalid_json" }, 400) };

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        return { response: json({ error: "body_too_large" }, 413) };
      }
      chunks.push(value);
    }
  } catch {
    return { response: json({ error: "invalid_json" }, 400) };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return { body: JSON.parse(decoder.decode(bytes)) };
  } catch {
    return { response: json({ error: "invalid_json" }, 400) };
  }
}

function productionMode(env) {
  const mode = String(env.ORES_LOCKS_ENVIRONMENT ?? "").toLowerCase();
  return mode === "production" || mode === "prod";
}

function internalBody(path, body) {
  if (path === "/v1/leases/acquire") {
    return { holder: body.holder, ttl_ms: body.ttl_ms };
  }
  if (path === "/v1/leases/renew") {
    return { holder: body.holder, ttl_ms: body.ttl_ms, fencing_token: body.fencing_token };
  }
  return { holder: body.holder, fencing_token: body.fencing_token };
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
    const path = new URL(request.url).pathname;
    if (!INTERNAL_FIELDS[path]) return json({ error: "not_found" }, 404);
    const decoded = await readBoundedJson(request);
    if (decoded.response) return decoded.response;
    const error = validateOperation(path, decoded.body, INTERNAL_FIELDS, false);
    if (error) return json({ error }, 400);

    if (path === "/v1/leases/acquire") return this.acquire(decoded.body);
    if (path === "/v1/leases/renew") return this.renew(decoded.body);
    return this.release(decoded.body);
  }

  async acquire(body) {
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
    if (!PUBLIC_FIELDS[url.pathname]) return json({ error: "not_found" }, 404);
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

    const allowUnauthenticated = env.ALLOW_UNAUTHENTICATED === "true";
    if (productionMode(env) && allowUnauthenticated) {
      return json({ error: "unsafe_configuration" }, 503);
    }
    if (!env.ORES_LOCKS_API_TOKEN && !allowUnauthenticated) {
      return json({ error: "authority_not_configured" }, 503);
    }
    if (!allowUnauthenticated && !(await bearerMatches(request, env.ORES_LOCKS_API_TOKEN))) {
      return json({ error: "unauthorized" }, 401);
    }

    const decoded = await readBoundedJson(request);
    if (decoded.response) return decoded.response;
    const error = validateOperation(url.pathname, decoded.body, PUBLIC_FIELDS, true);
    if (error) return json({ error }, 400);

    const id = env.LOCKS.idFromName(decoded.body.key);
    const stub = env.LOCKS.get(id);
    return stub.fetch(`https://lock.internal${url.pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(internalBody(url.pathname, decoded.body)),
    });
  },
};
