#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIRECTORY, "..");
const DEFAULT_CORPUS = "conformance/cases/fence-decision.json";
const DEFAULT_RECEIPT = "target/adversarial/runtime-receipt.json";
const MAX_LOG_BYTES = 16 * 1024 * 1024;

function parseArgs(argv) {
  const options = {
    corpus: DEFAULT_CORPUS,
    receipt: DEFAULT_RECEIPT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--corpus") {
      options.corpus = argv[++index];
      if (!options.corpus) throw new Error("--corpus requires a path");
    } else if (arg === "--receipt") {
      options.receipt = argv[++index];
      if (!options.receipt) throw new Error("--receipt requires a path");
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertCorpus(corpus) {
  if (corpus?.schema !== "ores.locks-and-leases.fence-corpus/v2") {
    throw new Error("unsupported fencing corpus schema");
  }
  if (!Array.isArray(corpus.cases) || corpus.cases.length < 64) {
    throw new Error("fencing corpus has no substantial decision matrix");
  }
  if (!Array.isArray(corpus.storeSequence) || corpus.storeSequence.length < 64) {
    throw new Error("fencing corpus has no substantial stateful sequence");
  }
}

const RUNTIMES = [
  {
    name: "rust",
    directory: "src/rust",
    command:
      "cargo test --locked --no-default-features --test fence_conformance --test fence_adversarial",
  },
  {
    name: "go",
    directory: "src/go",
    command: 'test -z "$(gofmt -l .)" && go vet ./... && go test ./...',
  },
  {
    name: "typescript",
    directory: "src/ts",
    command: "npm ci --no-audit --no-fund && npm test",
  },
  {
    name: "dart",
    directory: "src/dart",
    command:
      "dart pub get --enforce-lockfile && dart format --output=none --set-exit-if-changed lib test && dart analyze --fatal-infos && dart test",
  },
  {
    name: "gleam",
    directory: "src/gleam",
    command: "gleam format --check src test && gleam test",
  },
];

async function runRuntime(runtime, reportDirectory) {
  const startedAt = new Date().toISOString();
  const result = spawnSync("/bin/sh", ["-lc", runtime.command], {
    cwd: resolve(ROOT, runtime.directory),
    encoding: "utf8",
    env: process.env,
    maxBuffer: MAX_LOG_BYTES,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const log = [
    `$ ${runtime.command}`,
    stdout,
    stderr,
  ].join("\n");
  const logPath = resolve(reportDirectory, `runtime-${runtime.name}.log`);
  await writeFile(logPath, log, "utf8");

  process.stdout.write(`\n== adversarial runtime: ${runtime.name} ==\n`);
  process.stdout.write(stdout);
  process.stderr.write(stderr);

  const exitCode = result.status ?? (result.error ? 127 : 1);
  return {
    name: runtime.name,
    status: exitCode === 0 ? "passed" : "failed",
    exitCode,
    signal: result.signal ?? null,
    startedAt,
    completedAt: new Date().toISOString(),
    command: runtime.command,
    workingDirectory: runtime.directory,
    log: `runtime-${runtime.name}.log`,
    logSha256: sha256(log),
    error: result.error?.message ?? null,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const corpusPath = resolve(ROOT, options.corpus);
  const receiptPath = resolve(ROOT, options.receipt);
  const reportDirectory = dirname(receiptPath);
  await mkdir(reportDirectory, { recursive: true });

  const corpusText = await readFile(corpusPath, "utf8");
  const corpus = JSON.parse(corpusText);
  assertCorpus(corpus);

  const report = {
    schema: "ores.locks-and-leases.adversarial-runtime-receipt/v1",
    status: "running",
    profile: corpus.profile,
    seed: corpus.seed,
    corpusPath: options.corpus,
    corpusSha256: sha256(corpusText),
    caseCount: corpus.cases.length,
    statefulSequenceCount: corpus.storeSequence.length,
    exactHead: process.env.GITHUB_SHA ?? null,
    generatedAt: new Date().toISOString(),
    runtimes: [],
    zeroUnexplainedFindings: false,
  };

  try {
    for (const runtime of RUNTIMES) {
      report.runtimes.push(await runRuntime(runtime, reportDirectory));
    }
    const failed = report.runtimes.filter((runtime) => runtime.status !== "passed");
    report.status = failed.length === 0 ? "passed" : "failed";
    report.zeroUnexplainedFindings = failed.length === 0;
    if (failed.length > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    report.status = "failed";
    report.error = String(error instanceof Error ? error.message : error).slice(0, 4000);
    process.exitCode = 1;
  } finally {
    report.completedAt = new Date().toISOString();
    await writeFile(receiptPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  console.log(JSON.stringify(report));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
