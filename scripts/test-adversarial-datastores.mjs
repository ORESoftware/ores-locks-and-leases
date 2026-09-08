#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import net from "node:net";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const DEFAULT_CORPUS = "conformance/cases/fence-decision.json";
const DEFAULT_REDIS_SCRIPT = "persistence/redis/fenced-write.lua";
const DEFAULT_RECEIPT = "target/adversarial/store-receipt.json";

function parseArgs(argv) {
  const out = {
    corpus: DEFAULT_CORPUS,
    redisScript: DEFAULT_REDIS_SCRIPT,
    receipt: DEFAULT_RECEIPT,
    validateOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--corpus") out.corpus = argv[++index];
    else if (arg === "--redis-script") out.redisScript = argv[++index];
    else if (arg === "--receipt") out.receipt = argv[++index];
    else if (arg === "--validate-only") out.validateOnly = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function sqlLiteral(value) {
  if (value === null) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function assertCorpus(corpus) {
  if (corpus?.schema !== "ores.locks-and-leases.fence-corpus/v2") {
    throw new Error("unsupported fencing corpus schema");
  }
  if (!Array.isArray(corpus.storeSequence) || corpus.storeSequence.length < 64) {
    throw new Error("fencing corpus has no substantial stateful store sequence");
  }
  let current = null;
  let state = null;
  for (const [index, item] of corpus.storeSequence.entries()) {
    const expected = item?.expected;
    const request = item?.request;
    if (!request || !expected || typeof item.serializedValue !== "string") {
      throw new Error(`store sequence ${index} is malformed`);
    }
    if (!/^(0|[1-9][0-9]{0,19})$/u.test(request.fencingToken)) {
      throw new Error(`store sequence ${index} has noncanonical token`);
    }
    if (!["advanced", "replay", "stale", "token_reuse"].includes(expected.decision)) {
      throw new Error(`store sequence ${index} has unknown decision`);
    }
    if ((expected.decision === "advanced") !== expected.shouldApply) {
      throw new Error(`store sequence ${index} has inconsistent shouldApply`);
    }
    if (expected.shouldApply) {
      current = request.fencingToken;
      state = item.serializedValue;
    }
    if (current !== expected.currentToken || state !== expected.stateValue) {
      throw new Error(`store sequence ${index} has inconsistent expected state`);
    }
  }
}

function postgresProgram(corpus, tenant, resource) {
  const chunks = [];
  chunks.push("\\set ON_ERROR_STOP on");
  chunks.push("BEGIN;");
  chunks.push(`DELETE FROM ores_locks.fencing_watermarks WHERE tenant_scope = ${sqlLiteral(tenant)} AND resource_key = ${sqlLiteral(resource)};`);
  chunks.push(`CREATE TEMP TABLE adversarial_protected_state (
    tenant_scope text NOT NULL,
    resource_key text NOT NULL,
    value text NOT NULL,
    fencing_token numeric(20, 0) NOT NULL,
    PRIMARY KEY (tenant_scope, resource_key)
  ) ON COMMIT DROP;`);

  const blockSize = 128;
  for (let offset = 0; offset < corpus.storeSequence.length; offset += blockSize) {
    const block = corpus.storeSequence.slice(offset, offset + blockSize);
    const lines = [
      `DO $adversarial_${offset}$`,
      "DECLARE",
      "  r record;",
      "  observed_state text;",
      "BEGIN",
    ];
    for (const [inner, item] of block.entries()) {
      const index = offset + inner;
      const request = item.request;
      const expected = item.expected;
      const expectedPrevious = expected.previousToken === null
        ? "NULL"
        : sqlLiteral(expected.previousToken);
      lines.push(`  SELECT * INTO STRICT r FROM ores_locks.try_advance_fence(
    ${sqlLiteral(tenant)},
    ${sqlLiteral(resource)},
    ${sqlLiteral(request.fencingToken)},
    ${sqlLiteral(request.operationId)},
    ${sqlLiteral(request.payloadSha256)},
    ${sqlLiteral(request.holder ?? null)},
    ${sqlLiteral(request.leaseId ?? null)}
  );`);
      lines.push(`  IF r.decision IS DISTINCT FROM ${sqlLiteral(expected.decision)}
      OR r.should_apply IS DISTINCT FROM ${expected.shouldApply ? "true" : "false"}
      OR r.current_token IS DISTINCT FROM ${sqlLiteral(expected.currentToken)}
      OR r.previous_token IS DISTINCT FROM ${expectedPrevious}
  THEN
    RAISE EXCEPTION 'sequence ${index} decision mismatch: %', row_to_json(r);
  END IF;`);
      lines.push(`  IF r.should_apply THEN
    INSERT INTO adversarial_protected_state (
      tenant_scope, resource_key, value, fencing_token
    ) VALUES (
      ${sqlLiteral(tenant)}, ${sqlLiteral(resource)},
      ${sqlLiteral(item.serializedValue)}, r.current_token::numeric
    )
    ON CONFLICT (tenant_scope, resource_key) DO UPDATE
    SET value = EXCLUDED.value,
        fencing_token = EXCLUDED.fencing_token;
  END IF;`);
      lines.push(`  SELECT value INTO STRICT observed_state
  FROM adversarial_protected_state
  WHERE tenant_scope = ${sqlLiteral(tenant)}
    AND resource_key = ${sqlLiteral(resource)};
  IF observed_state IS DISTINCT FROM ${sqlLiteral(expected.stateValue)} THEN
    RAISE EXCEPTION 'sequence ${index} protected-state mismatch: got %, expected %',
      observed_state, ${sqlLiteral(expected.stateValue)};
  END IF;`);
    }
    lines.push("END;");
    lines.push(`$adversarial_${offset}$;`);
    chunks.push(lines.join("\n"));
  }
  chunks.push("ROLLBACK;");
  return `${chunks.join("\n\n")}\n`;
}

function runPostgres(corpus, tenant, resource) {
  const databaseUrl = process.env.ORES_LOCKS_TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error("ORES_LOCKS_TEST_DATABASE_URL is required");
  const sql = postgresProgram(corpus, tenant, resource);
  const result = spawnSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1"], {
    input: sql,
    encoding: "utf8",
    env: { ...process.env, PGDATABASE: databaseUrl },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`PostgreSQL adversarial sequence failed: ${result.stderr.trim().slice(-4000)}`);
  }
  return { status: "passed", operationCount: corpus.storeSequence.length };
}

function encodeCommand(parts) {
  const buffers = [Buffer.from(`*${parts.length}\r\n`)];
  for (const part of parts) {
    const value = Buffer.from(String(part));
    buffers.push(Buffer.from(`$${value.length}\r\n`), value, Buffer.from("\r\n"));
  }
  return Buffer.concat(buffers);
}

function lineEnd(buffer, offset) {
  return buffer.indexOf("\r\n", offset, "utf8");
}

function parseReply(buffer, offset = 0) {
  if (offset >= buffer.length) return null;
  const type = String.fromCharCode(buffer[offset]);
  const end = lineEnd(buffer, offset + 1);
  if (end < 0) return null;
  const header = buffer.toString("utf8", offset + 1, end);
  const bodyStart = end + 2;
  if (type === "+") return { value: header, next: bodyStart };
  if (type === "-") return { error: new Error(`Redis error: ${header}`), next: bodyStart };
  if (type === ":") return { value: Number(header), next: bodyStart };
  if (type === "$") {
    const length = Number(header);
    if (length === -1) return { value: null, next: bodyStart };
    if (!Number.isSafeInteger(length) || length < 0) throw new Error("invalid Redis bulk length");
    const next = bodyStart + length + 2;
    if (buffer.length < next) return null;
    if (buffer[bodyStart + length] !== 13 || buffer[bodyStart + length + 1] !== 10) {
      throw new Error("invalid Redis bulk terminator");
    }
    return { value: buffer.toString("utf8", bodyStart, bodyStart + length), next };
  }
  if (type === "*") {
    const length = Number(header);
    if (length === -1) return { value: null, next: bodyStart };
    if (!Number.isSafeInteger(length) || length < 0) throw new Error("invalid Redis array length");
    const values = [];
    let cursor = bodyStart;
    for (let index = 0; index < length; index += 1) {
      const item = parseReply(buffer, cursor);
      if (!item) return null;
      if (item.error) return item;
      values.push(item.value);
      cursor = item.next;
    }
    return { value: values, next: cursor };
  }
  throw new Error(`unsupported Redis reply type ${JSON.stringify(type)}`);
}

class RedisClient {
  constructor(host, port) {
    this.host = host;
    this.port = port;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = [];
  }

  async connect() {
    this.socket = net.createConnection({ host: this.host, port: this.port });
    this.socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      try {
        for (;;) {
          const parsed = parseReply(this.buffer);
          if (!parsed) break;
          this.buffer = this.buffer.subarray(parsed.next);
          const pending = this.pending.shift();
          if (!pending) throw new Error("unsolicited Redis reply");
          if (parsed.error) pending.reject(parsed.error);
          else pending.resolve(parsed.value);
        }
      } catch (error) {
        this.fail(error);
      }
    });
    this.socket.on("error", (error) => this.fail(error));
    this.socket.on("close", () => {
      if (this.pending.length > 0) this.fail(new Error("Redis connection closed"));
    });
    await new Promise((resolvePromise, rejectPromise) => {
      this.socket.once("connect", resolvePromise);
      this.socket.once("error", rejectPromise);
    });
  }

  fail(error) {
    while (this.pending.length > 0) this.pending.shift().reject(error);
  }

  command(...parts) {
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.push({ resolve: resolvePromise, reject: rejectPromise });
      this.socket.write(encodeCommand(parts));
    });
  }

  async close() {
    if (!this.socket) return;
    this.socket.end();
    await new Promise((resolvePromise) => this.socket.once("close", resolvePromise));
  }
}

async function runRedis(corpus, tenant, resource, scriptText) {
  const host = process.env.REDIS_HOST ?? "127.0.0.1";
  const port = Number(process.env.REDIS_PORT ?? "6379");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("REDIS_PORT must be an integer in 1..65535");
  }
  const tag = `adversarial:${tenant}:${resource}`.replaceAll(/[{}]/gu, "_");
  const watermark = `ores-locks:{${tag}}:fence`;
  const state = `ores-locks:{${tag}}:state`;
  const client = new RedisClient(host, port);
  await client.connect();
  try {
    const scriptSha = await client.command("SCRIPT", "LOAD", scriptText);
    await client.command("DEL", watermark, state);
    for (const [index, item] of corpus.storeSequence.entries()) {
      const request = item.request;
      const reply = await client.command(
        "EVALSHA",
        scriptSha,
        "2",
        watermark,
        state,
        request.fencingToken,
        request.operationId,
        request.payloadSha256,
        item.serializedValue,
        request.holder ?? "",
        request.leaseId ?? "",
      );
      if (!Array.isArray(reply) || reply.length !== 4) {
        throw new Error(`Redis sequence ${index} returned malformed reply`);
      }
      const normalizedPrevious = reply[3] === "" ? null : reply[3];
      const expected = item.expected;
      if (
        reply[0] !== expected.decision ||
        reply[1] !== (expected.shouldApply ? "1" : "0") ||
        reply[2] !== expected.currentToken ||
        normalizedPrevious !== expected.previousToken
      ) {
        throw new Error(
          `Redis sequence ${index} mismatch: ${JSON.stringify(reply)} versus ${JSON.stringify(expected)}`,
        );
      }
      const observedState = await client.command("GET", state);
      if (observedState !== expected.stateValue) {
        throw new Error(
          `Redis sequence ${index} state mismatch: ${JSON.stringify(observedState)} versus ${JSON.stringify(expected.stateValue)}`,
        );
      }
    }
    return { status: "passed", operationCount: corpus.storeSequence.length };
  } finally {
    try {
      await client.command("DEL", watermark, state);
    } finally {
      await client.close();
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const corpusText = await readFile(resolve(options.corpus), "utf8");
  const corpus = JSON.parse(corpusText);
  assertCorpus(corpus);
  const receipt = {
    schema: "ores.locks-and-leases.adversarial-store-receipt/v1",
    status: "partial",
    profile: corpus.profile,
    seed: corpus.seed,
    corpusSha256: sha256(corpusText),
    sequenceCount: corpus.storeSequence.length,
    exactHead: process.env.GITHUB_SHA ?? null,
    checks: {
      corpus: { status: "passed", operationCount: corpus.storeSequence.length },
      postgres: { status: "skipped" },
      redis: { status: "skipped" },
    },
    zeroUnexplainedFindings: false,
  };

  try {
    if (!options.validateOnly) {
      const redisScript = await readFile(resolve(options.redisScript), "utf8");
      const identity = `${corpus.seed.replace(/^0x/u, "")}-${process.pid}`;
      const tenant = `tenant/adversarial-${identity}`;
      const resource = "resource/stateful-sequence";
      receipt.checks.postgres = runPostgres(corpus, tenant, resource);
      receipt.checks.redis = await runRedis(corpus, tenant, resource, redisScript);
      receipt.status = "passed";
      receipt.zeroUnexplainedFindings = true;
    }
  } catch (error) {
    receipt.status = "failed";
    receipt.error = String(error instanceof Error ? error.message : error).slice(0, 4000);
    throw error;
  } finally {
    await mkdir(dirname(resolve(options.receipt)), { recursive: true });
    await writeFile(resolve(options.receipt), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  }

  console.log(JSON.stringify(receipt));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
