#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

import { LockLeaseAuthority } from "../managed/cloudflare-do/src/authority.js";

const DEFAULT_CORPUS = "conformance/cases/fence-decision.json";
const DEFAULT_RECEIPT = "target/adversarial/cloudflare-do-receipt.json";
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_MINUS_ONE = MAX_SAFE - 1n;
const MAX_PLUS_ONE = MAX_SAFE + 1n;

function parseArgs(argv) {
  const options = {
    corpus: DEFAULT_CORPUS,
    receipt: DEFAULT_RECEIPT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--corpus") options.corpus = argv[++index];
    else if (arg === "--receipt") options.receipt = argv[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function rows(items = []) {
  return { toArray: () => items };
}

class FakeSql {
  constructor() {
    this.legacy = false;
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
      const columns = ["id", "holder", "token", "expires_ms", "next_token", "request_id"];
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
  constructor() {
    this.sql = new FakeSql();
    this.alarm = null;
    this.setAlarmCalls = [];
    this.deletedAlarms = 0;
  }

  transactionSync(fn) {
    return fn();
  }

  async setAlarm(at) {
    this.alarm = at;
    this.setAlarmCalls.push(at);
  }

  async deleteAlarm() {
    this.alarm = null;
    this.deletedAlarms += 1;
  }
}

function authority(storage = new FakeStorage()) {
  return {
    storage,
    authority: new LockLeaseAuthority({ storage }),
  };
}

function restart(storage) {
  return new LockLeaseAuthority({ storage });
}

function validateCorpus(corpus) {
  assert.equal(corpus?.schema, "ores.locks-and-leases.fence-corpus/v2");
  assert.equal(typeof corpus.seed, "string");
  assert.ok(Array.isArray(corpus.storeSequence) && corpus.storeSequence.length >= 64);
  assert.ok(Array.isArray(corpus.tokenBoundaries));
  const boundaries = new Set(corpus.tokenBoundaries);
  assert.ok(boundaries.has(MAX_SAFE.toString()), "corpus must contain the exact JSON-safe ceiling");
  assert.ok(boundaries.has(MAX_PLUS_ONE.toString()), "corpus must contain the first JSON-unsafe token");
}

async function runRestartReplayScenario() {
  const { authority: firstInstance, storage } = authority();
  const first = await firstInstance.acquire({
    holder: "worker-retry",
    request_id: "attempt-ambiguous-1",
    ttl_ms: 1_000,
  });
  assert.equal(first.acquired, true);
  assert.equal(first.replayed, false);

  // Simulate a transport failure after the authority committed but before the
  // caller learned the result: throw away `first`, evict the object instance,
  // and retry the same logical request against the same persisted storage.
  const secondInstance = restart(storage);
  const replay = await secondInstance.acquire({
    holder: "worker-retry",
    request_id: "attempt-ambiguous-1",
    ttl_ms: 50_000,
  });
  assert.equal(replay.acquired, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.fencing_token, first.fencing_token);
  assert.equal(replay.lease_expires_ms, first.lease_expires_ms);
  assert.equal(storage.sql.state.expires_ms, first.lease_expires_ms, "ambiguous retry cannot extend authority");

  const differentRequest = await secondInstance.acquire({
    holder: "worker-retry",
    request_id: "attempt-ambiguous-2",
    ttl_ms: 1_000,
  });
  assert.deepEqual(differentRequest, {
    acquired: false,
    reason: "holder_active_different_request",
    lease_expires_ms: first.lease_expires_ms,
  });

  return {
    status: "passed",
    fencingToken: first.fencing_token,
    leaseExpiresMs: first.lease_expires_ms,
  };
}

async function runAlarmScenario(clock) {
  const { authority: leases, storage } = authority();
  const grant = await leases.acquire({
    holder: "worker-alarm",
    request_id: "alarm-1",
    ttl_ms: 1_000,
  });
  assert.equal(grant.acquired, true);
  const expiry = grant.lease_expires_ms;

  clock.now += 500;
  await leases.alarm();
  assert.equal(storage.sql.state.holder, "worker-alarm");
  assert.equal(storage.sql.state.expires_ms, expiry);
  assert.equal(storage.alarm, expiry, "early alarm must only reschedule persisted expiry");

  clock.now = expiry + 250;
  await restart(storage).alarm();
  assert.equal(storage.sql.state.holder, null);
  assert.equal(storage.sql.state.token, null);
  assert.equal(storage.sql.state.next_token, grant.fencing_token);

  return {
    status: "passed",
    fencingToken: grant.fencing_token,
    persistedExpiry: expiry,
  };
}

async function runStaleOwnerScenario(clock) {
  const { authority: leases, storage } = authority();
  const oldGrant = await leases.acquire({
    holder: "worker-old",
    request_id: "stale-old",
    ttl_ms: 1_000,
  });
  assert.equal(oldGrant.acquired, true);
  assert.equal(await leases.release({
    holder: "worker-old",
    fencing_token: oldGrant.fencing_token,
  }).then((result) => result.released), true);

  const newerGrant = await restart(storage).acquire({
    holder: "worker-new",
    request_id: "stale-new",
    ttl_ms: 1_000,
  });
  assert.equal(newerGrant.acquired, true);
  assert.ok(BigInt(newerGrant.fencing_token) > BigInt(oldGrant.fencing_token));

  const staleRenew = await restart(storage).renew({
    holder: "worker-old",
    fencing_token: oldGrant.fencing_token,
    ttl_ms: 5_000,
  });
  assert.deepEqual(staleRenew, { renewed: false, reason: "not_owner" });

  const staleRelease = await restart(storage).release({
    holder: "worker-old",
    fencing_token: oldGrant.fencing_token,
  });
  assert.deepEqual(staleRelease, { released: false, reason: "not_owner" });
  assert.equal(storage.sql.state.holder, "worker-new");
  assert.equal(storage.sql.state.token, newerGrant.fencing_token);

  clock.now += 250;
  const currentRenew = await restart(storage).renew({
    holder: "worker-new",
    fencing_token: newerGrant.fencing_token,
    ttl_ms: 1_000,
  });
  assert.equal(currentRenew.renewed, true);

  return {
    status: "passed",
    staleToken: oldGrant.fencing_token,
    currentToken: newerGrant.fencing_token,
  };
}

async function runSafeIntegerBoundaryScenario() {
  const { authority: leases, storage } = authority();
  storage.sql.state.next_token = (MAX_SAFE - 2n).toString();

  const maxMinusOne = await leases.acquire({
    holder: "worker-max-minus-one",
    request_id: "boundary-max-minus-one",
    ttl_ms: 1_000,
  });
  assert.equal(maxMinusOne.fencing_token, MAX_MINUS_ONE.toString());
  assert.deepEqual(await leases.release({
    holder: "worker-max-minus-one",
    fencing_token: maxMinusOne.fencing_token,
  }), { released: true });

  const max = await restart(storage).acquire({
    holder: "worker-max",
    request_id: "boundary-max",
    ttl_ms: 1_000,
  });
  assert.equal(max.fencing_token, MAX_SAFE.toString());
  assert.deepEqual(await restart(storage).release({
    holder: "worker-max",
    fencing_token: max.fencing_token,
  }), { released: true });

  const maxPlusOne = await restart(storage).acquire({
    holder: "worker-overflow",
    request_id: "boundary-max-plus-one",
    ttl_ms: 1_000,
  });
  assert.deepEqual(maxPlusOne, { acquired: false, error: "fencing_token_exhausted" });
  assert.equal(storage.sql.state.next_token, MAX_SAFE.toString());
  assert.equal(storage.sql.state.holder, null);

  return {
    status: "passed",
    fixtures: {
      maxMinusOne: MAX_MINUS_ONE.toString(),
      max: MAX_SAFE.toString(),
      maxPlusOne: MAX_PLUS_ONE.toString(),
    },
    maxPlusOneDecision: "fencing_token_exhausted",
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const corpusText = await readFile(resolve(options.corpus), "utf8");
  const corpus = JSON.parse(corpusText);
  validateCorpus(corpus);

  const receipt = {
    schema: "ores.locks-and-leases.adversarial-cloudflare-do-receipt/v1",
    status: "partial",
    profile: corpus.profile,
    seed: corpus.seed,
    corpusSha256: sha256(corpusText),
    exactHead: process.env.GITHUB_SHA ?? null,
    authority: "cloudflare_durable_object",
    checks: {},
    zeroUnexplainedFindings: false,
  };

  const originalNow = Date.now;
  const clock = { now: 1_000_000 };
  Date.now = () => clock.now;
  try {
    receipt.checks.restartReplay = await runRestartReplayScenario();
    clock.now += 10_000;
    receipt.checks.alarmAuthority = await runAlarmScenario(clock);
    clock.now += 10_000;
    receipt.checks.staleOwner = await runStaleOwnerScenario(clock);
    clock.now += 10_000;
    receipt.checks.safeIntegerBoundary = await runSafeIntegerBoundaryScenario();
    receipt.status = "passed";
    receipt.zeroUnexplainedFindings = true;
  } catch (error) {
    receipt.status = "failed";
    receipt.error = String(error instanceof Error ? error.stack ?? error.message : error).slice(0, 8000);
    throw error;
  } finally {
    Date.now = originalNow;
    await mkdir(dirname(resolve(options.receipt)), { recursive: true });
    await writeFile(resolve(options.receipt), `${JSON.stringify(receipt, null, 2)}\n`);
  }
}

await main();
