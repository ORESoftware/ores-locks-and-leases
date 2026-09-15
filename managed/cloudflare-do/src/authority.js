const MAX_HOLDER_BYTES = 512;
const MAX_REQUEST_ID_CHARS = 256;
const MAX_TTL_MS = 86_400_000;
const MAX_FENCING_TOKEN = BigInt(Number.MAX_SAFE_INTEGER);
export const REPLAY_RETENTION_MS = 10 * 60 * 1000;
export const MAX_REPLAY_RECORDS = 256;
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
  if (requestId === undefined || requestId === null) return true;
  return (
    typeof requestId === "string" &&
    requestId.length > 0 &&
    requestId.trim().length > 0 &&
    !CONTROL.test(requestId) &&
    Array.from(requestId).length <= MAX_REQUEST_ID_CHARS
  );
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
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS acquire_replay (
        request_id TEXT PRIMARY KEY,
        holder TEXT NOT NULL,
        ttl_ms INTEGER NOT NULL,
        token TEXT NOT NULL,
        lease_expires_ms INTEGER NOT NULL,
        retain_until_ms INTEGER NOT NULL
      )
    `);
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS acquire_replay_retention ON acquire_replay(retain_until_ms)",
    );
  }

  row() {
    return this.sql.exec(
      "SELECT holder, token, expires_ms, next_token, request_id FROM lease_state WHERE id = 1",
    ).toArray()[0];
  }

  replayRow(requestId) {
    return this.sql.exec(
      "SELECT request_id, holder, ttl_ms, token, lease_expires_ms, retain_until_ms FROM acquire_replay WHERE request_id = ?",
      requestId,
    ).toArray()[0] ?? null;
  }

  earliestReplayExpiry(now) {
    const row = this.sql.exec(
      "SELECT MIN(retain_until_ms) AS retain_until_ms FROM acquire_replay WHERE retain_until_ms > ?",
      now,
    ).toArray()[0];
    return Number.isSafeInteger(row?.retain_until_ms) ? row.retain_until_ms : null;
  }

  pruneReplay(now) {
    this.sql.exec("DELETE FROM acquire_replay WHERE retain_until_ms <= ?", now);
    this.sql.exec(
      `DELETE FROM acquire_replay
       WHERE request_id IN (
         SELECT request_id FROM acquire_replay
         ORDER BY retain_until_ms DESC, request_id DESC
         LIMIT -1 OFFSET ?
       )`,
      MAX_REPLAY_RECORDS,
    );
  }

  recordReplay(body, token, leaseExpiresMs) {
    if (!body.request_id) return;
    const retainUntil = leaseExpiresMs + REPLAY_RETENTION_MS;
    this.sql.exec(
      `INSERT OR REPLACE INTO acquire_replay
       (request_id, holder, ttl_ms, token, lease_expires_ms, retain_until_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
      body.request_id,
      body.holder,
      body.ttl_ms,
      token,
      leaseExpiresMs,
      retainUntil,
    );
  }

  clearLease() {
    this.sql.exec(
      "UPDATE lease_state SET holder = NULL, token = NULL, expires_ms = NULL, request_id = NULL WHERE id = 1",
    );
  }

  async scheduleNextAlarm(now = Date.now()) {
    const row = this.row();
    const candidates = [];
    if (Number.isSafeInteger(row.expires_ms) && row.expires_ms > now) {
      candidates.push(row.expires_ms);
    }
    const replayExpiry = this.earliestReplayExpiry(now);
    if (replayExpiry !== null) candidates.push(replayExpiry);
    if (candidates.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.min(...candidates));
  }

  async acquire(body) {
    if (!validHolder(body?.holder)) return { acquired: false, error: "invalid_holder" };
    if (!validRequestId(body?.request_id)) return { acquired: false, error: "invalid_request_id" };
    if (!validTtl(body?.ttl_ms)) return { acquired: false, error: "invalid_ttl" };

    const now = Date.now();
    let outcome;
    try {
      outcome = this.ctx.storage.transactionSync(() => {
        this.pruneReplay(now);
        const row = this.row();
        const replay = body.request_id ? this.replayRow(body.request_id) : null;

        if (replay !== null) {
          if (replay.holder !== body.holder || replay.ttl_ms !== body.ttl_ms) {
            return { acquired: false, reason: "request_identity_collision" };
          }
          const activeExactReplay =
            row.holder === body.holder &&
            row.request_id === body.request_id &&
            row.token === replay.token &&
            row.expires_ms !== null &&
            row.expires_ms > now;
          if (activeExactReplay) {
            return {
              acquired: true,
              fencing_token: row.token,
              lease_expires_ms: row.expires_ms,
              ttl_ms: replay.ttl_ms,
              renewed: false,
              replayed: true,
            };
          }
          return { acquired: false, reason: "request_replayed_terminal" };
        }

        if (row.holder !== null && row.expires_ms !== null && row.expires_ms > now) {
          if (row.request_id && body.request_id === row.request_id) {
            return { acquired: false, reason: "request_identity_unverifiable" };
          }
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
            return { acquired: false, reason: "request_identity_unverifiable" };
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
        this.recordReplay(body, fencingToken, expires);
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

    await this.scheduleNextAlarm(now);
    return outcome;
  }

  async renew(body) {
    if (!validHolder(body?.holder)) return { renewed: false, error: "invalid_holder" };
    if (!validTtl(body?.ttl_ms)) return { renewed: false, error: "invalid_ttl" };
    const token = canonicalToken(body?.fencing_token);
    if (token === null) return { renewed: false, error: "invalid_fencing_token" };

    const now = Date.now();
    const outcome = this.ctx.storage.transactionSync(() => {
      this.pruneReplay(now);
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
      if (row.request_id) {
        this.sql.exec(
          "UPDATE acquire_replay SET lease_expires_ms = ?, retain_until_ms = ? WHERE request_id = ?",
          expires,
          expires + REPLAY_RETENTION_MS,
          row.request_id,
        );
      }
      return { renewed: true, lease_expires_ms: expires, ttl_ms: body.ttl_ms };
    });

    await this.scheduleNextAlarm(now);
    return outcome;
  }

  async release(body) {
    if (!validHolder(body?.holder)) return { released: false, error: "invalid_holder" };
    const token = canonicalToken(body?.fencing_token);
    if (token === null) return { released: false, error: "invalid_fencing_token" };

    const now = Date.now();
    const outcome = this.ctx.storage.transactionSync(() => {
      this.pruneReplay(now);
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

    await this.scheduleNextAlarm(now);
    if (outcome.released) return { released: true };
    return { released: false, reason: outcome.reason };
  }

  async alarm() {
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.pruneReplay(now);
      const row = this.row();
      if (row.expires_ms !== null && row.expires_ms <= now) this.clearLease();
    });
    await this.scheduleNextAlarm(now);
  }
}
