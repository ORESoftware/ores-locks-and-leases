const MAX_HOLDER_BYTES = 512;
const MAX_REQUEST_ID_BYTES = 128;
const MAX_TTL_MS = 86_400_000;
const MAX_FENCING_TOKEN = BigInt(Number.MAX_SAFE_INTEGER);
const encoder = new TextEncoder();
const CONTROL = /[\u0000-\u001f\u007f]/;

export function validIdentity(value, maxBytes) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim().length > 0 &&
    !CONTROL.test(value) &&
    encoder.encode(value).length <= maxBytes
  );
}

export function validHolder(holder) {
  return validIdentity(holder, MAX_HOLDER_BYTES);
}

export function validRequestId(requestId) {
  return requestId === undefined || requestId === null || validIdentity(requestId, MAX_REQUEST_ID_BYTES);
}

export function validTtl(ttl) {
  return Number.isSafeInteger(ttl) && ttl > 0 && ttl <= MAX_TTL_MS;
}

export function canonicalToken(token) {
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
  if (next > MAX_FENCING_TOKEN) throw new Error("safe-integer fencing token exhausted");
  return next.toString();
}

/** Pure lease state machine; the deployed Durable Object wrapper exposes it by RPC. */
export class LockLeaseAuthority {
  constructor(ctx) {
    this.ctx = ctx;
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

  async acquire(body) {
    if (!validHolder(body?.holder)) return { acquired: false, error: "invalid_holder" };
    if (!validRequestId(body?.request_id)) return { acquired: false, error: "invalid_request_id" };
    if (!validTtl(body?.ttl_ms)) return { acquired: false, error: "invalid_ttl" };

    const now = Date.now();
    let outcome;
    try {
      outcome = this.ctx.storage.transactionSync(() => {
        const row = this.row();
        if (row.holder !== null && row.expires_ms !== null && row.expires_ms > now) {
          if (row.holder !== body.holder) {
            return { acquired: false, reason: "contention", lease_expires_ms: row.expires_ms };
          }
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
        return { acquired: false, error: "fencing_token_exhausted" };
      }
      throw error;
    }

    if (outcome.acquired) await this.ctx.storage.setAlarm(outcome.lease_expires_ms);
    return outcome;
  }

  async renew(body) {
    if (!validHolder(body?.holder)) return { renewed: false, error: "invalid_holder" };
    if (!validTtl(body?.ttl_ms)) return { renewed: false, error: "invalid_ttl" };
    const token = canonicalToken(body?.fencing_token);
    if (token === null) return { renewed: false, error: "invalid_fencing_token" };

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
    return outcome;
  }

  async release(body) {
    if (!validHolder(body?.holder)) return { released: false, error: "invalid_holder" };
    const token = canonicalToken(body?.fencing_token);
    if (token === null) return { released: false, error: "invalid_fencing_token" };

    const now = Date.now();
    const outcome = this.ctx.storage.transactionSync(() => {
      const row = this.row();
      if (row.expires_ms !== null && row.expires_ms <= now) {
        this.clearLease();
        return { released: false, reason: "expired", cleared_expired: true };
      }
      if (row.holder !== body.holder || row.token !== token) {
        return { released: false, reason: "not_owner", cleared_expired: false };
      }
      this.clearLease();
      return { released: true, cleared_expired: false };
    });

    if (outcome.released || outcome.cleared_expired) await this.ctx.storage.deleteAlarm();
    if (outcome.released) return { released: true };
    return { released: false, reason: outcome.reason };
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
