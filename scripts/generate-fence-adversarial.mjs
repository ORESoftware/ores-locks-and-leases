#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

const MASK64 = (1n << 64n) - 1n;
const DEFAULT_SEED = 0x2050f3ce5eedn;
const DEFAULT_JSON = "target/adversarial/fence-decision.json";
const PROFILE_ITERATIONS = Object.freeze({ pr: 24, scheduled: 512 });
const PROFILE_STORE_SEQUENCE = Object.freeze({ pr: 128, scheduled: 2048 });
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "0123456789abcdef".repeat(4);
const VALID_FIELDS = new Set([
  "tenantScope",
  "resourceKey",
  "fencingToken",
  "operationId",
  "payloadSha256",
  "holder",
  "leaseId",
]);

function usage(message) {
  if (message) console.error(message);
  console.error(`usage: generate-fence-adversarial.mjs [options]\n\n` +
    `  --profile pr|scheduled   deterministic corpus size (default: pr)\n` +
    `  --seed <integer>         decimal or 0x-prefixed 64-bit seed\n` +
    `  --output <path>          JSON corpus path\n` +
    `  --receipt <path>         write a machine-readable generation receipt\n` +
    `  --check                  fail unless the checked-in output matches\n`);
  process.exit(message ? 64 : 0);
}

function parseArgs(argv) {
  const options = {
    profile: "pr",
    seed: DEFAULT_SEED,
    output: DEFAULT_JSON,
    receipt: undefined,
    check: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--profile":
        options.profile = argv[++index];
        break;
      case "--seed":
        options.seed = BigInt(argv[++index]);
        break;
      case "--output":
        options.output = argv[++index];
        break;
      case "--receipt":
        options.receipt = argv[++index];
        break;
      case "--check":
        options.check = true;
        break;
      case "-h":
      case "--help":
        usage();
        break;
      default:
        usage(`unknown argument: ${arg}`);
    }
  }
  if (!Object.hasOwn(PROFILE_ITERATIONS, options.profile)) {
    usage(`unknown profile: ${options.profile}`);
  }
  if (options.seed < 0n || options.seed > MASK64) {
    usage("seed must fit unsigned 64 bits");
  }
  return options;
}

function xorshift64star(seed) {
  let state = seed === 0n ? 0x9e3779b97f4a7c15n : seed;
  return () => {
    state ^= state >> 12n;
    state ^= (state << 25n) & MASK64;
    state ^= state >> 27n;
    state &= MASK64;
    return (state * 0x2545f4914f6cdd1dn) & MASK64;
  };
}

function digest(label) {
  return createHash("sha256").update(label, "utf8").digest("hex");
}

function request(token, operationId, payloadSha256, overrides = {}) {
  const value = {
    tenantScope: "tenant/acme",
    resourceKey: "example/jobs/rebuild",
    fencingToken: token.toString(),
    operationId,
    payloadSha256,
    ...overrides,
  };
  for (const key of Object.keys(value)) {
    if (!VALID_FIELDS.has(key)) throw new Error(`internal unknown request field: ${key}`);
  }
  return value;
}

function expected(kind, incoming, current, previous) {
  return {
    kind,
    shouldApply: kind === "advanced",
    incomingToken: incoming.toString(),
    currentToken: current.toString(),
    previousToken: previous === null ? null : previous.toString(),
  };
}

function decisionCase(name, current, incoming, result) {
  return { name, current, incoming, expected: result };
}

function generatedCaseSet(seed, iterations) {
  const next = xorshift64star(seed);
  const cases = [];
  const boundaries = [
    0n,
    1n,
    9n,
    10n,
    99n,
    100n,
    (1n << 53n) - 1n,
    1n << 53n,
    (1n << 53n) + 1n,
    (1n << 63n) - 1n,
    1n << 63n,
    (1n << 63n) + 1n,
    MASK64 - 1n,
    MASK64,
  ];

  for (const [index, token] of boundaries.entries()) {
    const op = `boundary-first-${index}`;
    const incoming = request(token, op, digest(op));
    cases.push(decisionCase(
      `boundary ${token} advances an absent watermark`,
      null,
      incoming,
      expected("advanced", token, token, null),
    ));

    const replayCurrent = request(token, `boundary-replay-${index}`, DIGEST_A);
    const replayIncoming = request(token, `boundary-replay-${index}`, DIGEST_A, {
      holder: `retry-holder-${index}`,
    });
    cases.push(decisionCase(
      `boundary ${token} exact replay is a no-op`,
      replayCurrent,
      replayIncoming,
      expected("replay", token, token, token),
    ));

    const reuseIncoming = request(token, `boundary-reuse-${index}`, DIGEST_B);
    cases.push(decisionCase(
      `boundary ${token} different operation is token reuse`,
      replayCurrent,
      reuseIncoming,
      expected("token_reuse", token, token, token),
    ));
  }

  for (let index = 1; index < boundaries.length; index += 1) {
    const previous = boundaries[index - 1];
    const incomingToken = boundaries[index];
    cases.push(decisionCase(
      `boundary transition ${previous} to ${incomingToken} advances`,
      request(previous, `boundary-current-${index}`, DIGEST_A),
      request(incomingToken, `boundary-next-${index}`, DIGEST_B),
      expected("advanced", incomingToken, incomingToken, previous),
    ));
  }

  for (let index = 0; index < iterations; index += 1) {
    const left = next();
    let right = next();
    if (right === left) right = (right + 1n) & MASK64;
    const low = left < right ? left : right;
    const high = left < right ? right : left;
    const prefix = `seed-${seed.toString(16)}-${index.toString().padStart(4, "0")}`;
    const currentOp = `${prefix}-current`;
    const nextOp = `${prefix}-next`;
    const replayDigest = digest(`${prefix}:replay`);

    cases.push(decisionCase(
      `${prefix} newer token advances`,
      request(low, currentOp, DIGEST_A),
      request(high, nextOp, DIGEST_B),
      expected("advanced", high, high, low),
    ));
    cases.push(decisionCase(
      `${prefix} older token is stale`,
      request(high, nextOp, DIGEST_B),
      request(low, currentOp, DIGEST_A),
      expected("stale", low, high, high),
    ));
    cases.push(decisionCase(
      `${prefix} equal token exact replay`,
      request(high, currentOp, replayDigest),
      request(high, currentOp, replayDigest, { holder: `${prefix}-retry` }),
      expected("replay", high, high, high),
    ));
    cases.push(decisionCase(
      `${prefix} equal token changed payload`,
      request(high, currentOp, replayDigest),
      request(high, currentOp, digest(`${prefix}:changed`)),
      expected("token_reuse", high, high, high),
    ));
  }

  const utf8Tenant = "é".repeat(128);
  const utf8Operation = "é".repeat(64);
  const utf8Resource = "é".repeat(256);
  const utf8Metadata = "é".repeat(128);
  cases.push(decisionCase(
    "exact UTF-8 byte ceilings remain valid",
    null,
    request(MASK64, utf8Operation, DIGEST_C, {
      tenantScope: utf8Tenant,
      resourceKey: utf8Resource,
      holder: utf8Metadata,
      leaseId: utf8Metadata,
    }),
    expected("advanced", MASK64, MASK64, null),
  ));

  cases.push({
    name: "watermark tenant identity mismatch fails validation",
    current: request(42n, "identity-current", DIGEST_A, { tenantScope: "tenant/other" }),
    incoming: request(43n, "identity-incoming", DIGEST_B),
    expectedError: "identity_mismatch",
  });
  cases.push({
    name: "watermark resource identity mismatch fails validation",
    current: request(42n, "identity-current-resource", DIGEST_A, {
      resourceKey: "example/jobs/other",
    }),
    incoming: request(43n, "identity-incoming-resource", DIGEST_B),
    expectedError: "identity_mismatch",
  });

  return { cases, boundaries };
}


function buildStoreSequence(seed, requestedCount) {
  const next = xorshift64star(seed ^ 0xd1b54a32d192ed03n);
  const sequence = [];
  let current = null;
  let stateValue = null;

  function append(kind, token, operationId, payloadSha256) {
    const previousToken = current?.token ?? null;
    const requestValue = request(token, operationId, payloadSha256);
    const serializedValue =
      `state-${sequence.length}-${digest(`${seed}:${sequence.length}`).slice(0, 20)}`;
    const shouldApply = kind === "advanced";
    if (shouldApply) {
      current = { token, operationId, payloadSha256 };
      stateValue = serializedValue;
    }
    if (current === null || stateValue === null) {
      throw new Error("store sequence must begin with an advanced decision");
    }
    sequence.push({
      request: requestValue,
      serializedValue,
      expected: {
        decision: kind,
        shouldApply,
        currentToken: current.token.toString(),
        previousToken: previousToken === null ? null : previousToken.toString(),
        stateValue,
      },
    });
  }

  const critical = [
    0n,
    1n,
    (1n << 53n) - 1n,
    1n << 53n,
    (1n << 53n) + 1n,
    (1n << 63n) - 1n,
    1n << 63n,
    (1n << 63n) + 1n,
  ];
  for (const [index, token] of critical.entries()) {
    append("advanced", token, `sequence-critical-${index}`, digest(`sequence-critical-${index}`));
    append("replay", token, `sequence-critical-${index}`, digest(`sequence-critical-${index}`));
    append("token_reuse", token, `sequence-critical-reuse-${index}`, digest(`sequence-critical-${index}`));
    if (token > 0n) {
      append("stale", token - 1n, `sequence-critical-stale-${index}`, DIGEST_A);
    }
  }

  const terminalReserve = 8;
  while (sequence.length < requestedCount - terminalReserve) {
    if (current === null) throw new Error("internal sequence state missing");
    const selector = Number(next() % 4n);
    const index = sequence.length;
    if (selector === 0 && current.token < MASK64) {
      const remaining = MASK64 - current.token;
      const delta = 1n + (next() % (remaining < 1_000_000n ? remaining : 1_000_000n));
      const token = current.token + delta;
      append("advanced", token, `sequence-advance-${index}`, digest(`advance:${seed}:${index}`));
    } else if (selector === 1 && current.token > 0n) {
      const token = next() % current.token;
      append("stale", token, `sequence-stale-${index}`, digest(`stale:${seed}:${index}`));
    } else if (selector === 2) {
      append("replay", current.token, current.operationId, current.payloadSha256);
    } else {
      append(
        "token_reuse",
        current.token,
        `sequence-reuse-${index}`,
        digest(`reuse:${seed}:${index}`),
      );
    }
  }

  for (const [terminalIndex, token] of [MASK64 - 1n, MASK64].entries()) {
    const index = critical.length + terminalIndex;
    append("advanced", token, `sequence-critical-${index}`, digest(`sequence-critical-${index}`));
    append("replay", token, `sequence-critical-${index}`, digest(`sequence-critical-${index}`));
    append("token_reuse", token, `sequence-critical-reuse-${index}`, digest(`sequence-critical-${index}`));
    append("stale", token - 1n, `sequence-critical-stale-${index}`, DIGEST_A);
  }

  if (sequence.length !== requestedCount) {
    throw new Error(`store sequence length ${sequence.length} does not match ${requestedCount}`);
  }
  return sequence;
}

function buildCorpus(profile, seed) {
  const { cases, boundaries } = generatedCaseSet(seed, PROFILE_ITERATIONS[profile]);
  const storeSequence = buildStoreSequence(seed, PROFILE_STORE_SEQUENCE[profile]);
  const invalidTokens = [
    "",
    "00",
    "01",
    "+1",
    "-1",
    "1.0",
    " 1",
    "1 ",
    "1e3",
    "1E3",
    "1_000",
    "١",
    "１２",
    "1\u0000",
    "1\n",
    "18446744073709551616",
    "99999999999999999999",
    "not-a-token",
  ];
  const invalidFields = [
    {
      name: "tenant UTF-8 bytes exceed 256",
      field: "tenantScope",
      value: "é".repeat(129),
      expectedError: "too_long",
    },
    {
      name: "resource UTF-8 bytes exceed 512",
      field: "resourceKey",
      value: "é".repeat(257),
      expectedError: "too_long",
    },
    {
      name: "operation UTF-8 bytes exceed 128",
      field: "operationId",
      value: "é".repeat(65),
      expectedError: "too_long",
    },
    {
      name: "holder UTF-8 bytes exceed 256",
      field: "holder",
      value: "é".repeat(129),
      expectedError: "too_long",
    },
    {
      name: "lease UTF-8 bytes exceed 256",
      field: "leaseId",
      value: "é".repeat(129),
      expectedError: "too_long",
    },
    { name: "empty tenant", field: "tenantScope", value: "", expectedError: "empty_field" },
    { name: "empty resource", field: "resourceKey", value: "", expectedError: "empty_field" },
    { name: "empty operation", field: "operationId", value: "", expectedError: "empty_field" },
    { name: "empty holder", field: "holder", value: "", expectedError: "empty_field" },
    { name: "empty lease", field: "leaseId", value: "", expectedError: "empty_field" },
  ];
  const wrongTypeCases = [
    { field: "tenantScope", value: 7, expectedError: "invalid_type" },
    { field: "resourceKey", value: ["example/jobs/rebuild"], expectedError: "invalid_type" },
    { field: "fencingToken", value: 42, expectedError: "invalid_fencing_token" },
    { field: "operationId", value: false, expectedError: "invalid_type" },
    { field: "payloadSha256", value: [DIGEST_A], expectedError: "invalid_payload_sha256" },
    { field: "holder", value: null, expectedError: "invalid_type" },
    { field: "leaseId", value: { value: "lease-1" }, expectedError: "invalid_type" },
  ];

  return {
    $comment: "Deterministic cross-runtime fencing corpus. Generated by scripts/generate-fence-adversarial.mjs; do not edit by hand.",
    schema: "ores.locks-and-leases.fence-corpus/v2",
    profile,
    seed: `0x${seed.toString(16)}`,
    generator: "scripts/generate-fence-adversarial.mjs",
    generatedCaseCount: cases.length,
    tokenBoundaries: boundaries.map(String),
    cases,
    invalidTokens,
    invalidFields,
    wrongTypeCases,
    storeSequence,
  };
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function compareOrWrite(path, rendered, check) {
  const absolute = resolve(path);
  if (!check) {
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, rendered, "utf8");
    return { path, state: "written", sha256: sha256(rendered) };
  }
  let actual;
  try {
    actual = await readFile(absolute, "utf8");
  } catch (error) {
    return { path, state: "missing", sha256: sha256(rendered), error: String(error) };
  }
  return {
    path,
    state: actual === rendered ? "matched" : "stale",
    sha256: sha256(rendered),
    actualSha256: sha256(actual),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const corpus = buildCorpus(options.profile, options.seed);
  const json = `${JSON.stringify(corpus, null, 2)}\n`;
  const outputs = [await compareOrWrite(options.output, json, options.check)];
  const passed = outputs.every((output) =>
    output.state === "matched" || output.state === "written");
  const receipt = {
    schema: "ores.locks-and-leases.adversarial-receipt/v1",
    status: passed ? "passed" : "stopped_for_evaluation",
    profile: options.profile,
    seed: corpus.seed,
    generator: corpus.generator,
    generatedCaseCount: corpus.generatedCaseCount,
    invalidTokenCount: corpus.invalidTokens.length,
    invalidFieldCount: corpus.invalidFields.length,
    wrongTypeCount: corpus.wrongTypeCases.length,
    storeSequenceCount: corpus.storeSequence.length,
    outputs,
    exactHead: process.env.GITHUB_SHA ?? null,
    runtime: process.version,
    zeroUnexplainedFindings: passed,
  };
  if (options.receipt) {
    await mkdir(dirname(resolve(options.receipt)), { recursive: true });
    await writeFile(resolve(options.receipt), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify(receipt));
  if (!passed) process.exitCode = 1;
}

await main();
