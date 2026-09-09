import { createHash } from "node:crypto";
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const TJSV_COMMIT = "dfc28bfc000faba5a963f23c708171dfd5f8debf";
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const EVIDENCE_SCHEMA =
  "ores.typespec-json-schema-validator.language-boundary-evidence/v1";
const MANIFEST_SCHEMA =
  "ores.typespec-json-schema-validator.language-boundaries/v1";
const VERIFICATION_SCHEMA =
  "ores.typespec-json-schema-validator.language-boundary-verification/v1";

const expectedRevision = process.env.EXPECTED_SHA;
if (typeof expectedRevision !== "string" || !REVISION_PATTERN.test(expectedRevision)) {
  throw new Error("EXPECTED_SHA must be an exact lowercase 40-character commit SHA");
}

const installRoot = resolve(
  process.env.TJSV_INSTALL_ROOT ?? "target/tjsv-language-boundary-package",
);
const modulePath = resolve(
  installRoot,
  "node_modules/@oresoftware/typespec-json-schema-validator/src/language-boundary-verification.mjs",
);
const { verifyLanguageBoundaries } = await import(pathToFileURL(modulePath).href);

const runtimeOutcomes = Object.freeze({
  rust: process.env.RUST_OUTCOME,
  go: process.env.GO_OUTCOME,
  typescript: process.env.TYPESCRIPT_OUTCOME,
  dart: process.env.DART_OUTCOME,
  gleam: process.env.GLEAM_OUTCOME,
});

const targets = Object.freeze([
  {
    language: "rust",
    runtime: "native",
    sourceRoot: "src/rust",
    toolchain: { name: "rustc", version: "1.85.1" },
  },
  {
    language: "go",
    runtime: "native",
    sourceRoot: "src/go",
    toolchain: { name: "go", version: "1.22" },
  },
  {
    language: "typescript",
    runtime: "node",
    sourceRoot: "src/ts",
    toolchain: { name: "node", version: "22" },
  },
  {
    language: "dart",
    runtime: "dart-vm",
    sourceRoot: "src/dart",
    toolchain: { name: "dart", version: "3.13" },
  },
  {
    language: "gleam",
    runtime: "beam",
    sourceRoot: "src/gleam",
    toolchain: { name: "gleam+otp", version: "1.16.0+27" },
  },
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function listFiles(root) {
  const files = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", "build", "dist", "target", ".dart_tool"].includes(entry.name)) {
          continue;
        }
        await walk(absolute);
      } else if (entry.isFile()) {
        files.push(absolute);
      }
    }
  }
  await walk(resolve(root));
  return files;
}

async function sourceClosureDigest(sourceRoot, bundle) {
  const hasher = createHash("sha256");
  const roots = [
    sourceRoot,
    "conformance/cases",
    bundle === "renewal" ? "contracts/renewal" : "contracts/typespec",
    bundle === "renewal" ? null : "contracts/json-schema",
  ].filter(Boolean);
  const seen = new Set();
  for (const root of roots) {
    for (const absolute of await listFiles(root)) {
      const normalized = relative(process.cwd(), absolute).split(sep).join("/");
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      const bytes = await readFile(absolute);
      hasher.update(normalized);
      hasher.update("\0");
      hasher.update(bytes);
      hasher.update("\0");
    }
  }
  return hasher.digest("hex");
}

async function loadJson(path) {
  const bytes = await readFile(path);
  return JSON.parse(bytes.toString("utf8"));
}

function assertParityInputs(bundle, report, contractIr) {
  if (
    report?.schema !== "ores.typespec-json-schema-validator.report/v1" ||
    report.status !== "passed" ||
    report.zeroUnexplainedFindings !== true ||
    typeof report.runId !== "string" ||
    !DIGEST_PATTERN.test(report.runId)
  ) {
    throw new Error(`${bundle}: TJSV parity receipt is not admissible`);
  }
  if (
    contractIr?.schema !== "ores.typespec-json-schema-validator.contract-ir/v1" ||
    contractIr.status !== "passed" ||
    contractIr.admissible !== true ||
    contractIr.role !== "downstream-derived-parity-artifact" ||
    contractIr.editableAuthority !== false ||
    typeof contractIr.irId !== "string" ||
    !DIGEST_PATTERN.test(contractIr.irId) ||
    contractIr.admission?.receipt?.runId !== report.runId
  ) {
    throw new Error(`${bundle}: TJSV Contract IR is not bound to the parity receipt`);
  }
}

async function verifyBundle(bundle) {
  const report = await loadJson(`target/tjsv/${bundle}/report.json`);
  const contractIr = await loadJson(`target/tjsv/${bundle}/contract-ir.json`);
  assertParityInputs(bundle, report, contractIr);

  const output = `target/contract-runtime-boundary/language-boundary/${bundle}`;
  await mkdir(`${output}/runtime-evidence`, { recursive: true });

  const manifest = {
    schema: MANIFEST_SCHEMA,
    minimumDistinctLanguages: targets.length,
    authorities: {
      typeSpec: "peer",
      jsonSchema: "peer",
      generatedWitness: "evidence_only",
    },
    targets: targets.map(({ language, runtime }) => ({
      language,
      runtime,
      required: true,
      ingress: true,
      egress: true,
      evidence: `runtime-evidence/${language}-${runtime}.json`,
    })),
  };

  const evidenceByPath = {};
  for (const target of targets) {
    const status = runtimeOutcomes[target.language] === "success" ? "passed" : "failed";
    const digest = await sourceClosureDigest(target.sourceRoot, bundle);
    const evidence = {
      schema: EVIDENCE_SCHEMA,
      language: target.language,
      runtime: target.runtime,
      status,
      sourceRevision: expectedRevision,
      artifactDigest: `sha256:${digest}`,
      receiptRunId: report.runId,
      contractIrId: contractIr.irId,
      toolchain: target.toolchain,
      generator: {
        name: "ores-locks-runtime-source-closure",
        version: "1",
      },
      validation: {
        ingress: status,
        egress: status,
      },
    };
    const evidencePath = `runtime-evidence/${target.language}-${target.runtime}.json`;
    evidenceByPath[evidencePath] = evidence;
    await writeFile(`${output}/${evidencePath}`, `${JSON.stringify(evidence, null, 2)}\n`);
  }

  const verification = verifyLanguageBoundaries({
    manifest,
    report,
    contractIr,
    evidenceByPath,
  });
  if (
    verification.schema !== VERIFICATION_SCHEMA ||
    verification.status !== "passed" ||
    verification.zeroUnexplainedFindings !== true ||
    verification.counts?.requiredTargets !== targets.length ||
    verification.counts?.distinctRequiredLanguages !== targets.length ||
    verification.counts?.admittedEvidence !== targets.length ||
    verification.counts?.findings !== 0
  ) {
    throw new Error(`${bundle}: official TJSV language/runtime admission did not pass`);
  }

  const tampered = structuredClone(evidenceByPath);
  const firstPath = manifest.targets[0].evidence;
  tampered[firstPath].receiptRunId = "0".repeat(64);
  const negative = verifyLanguageBoundaries({
    manifest,
    report,
    contractIr,
    evidenceByPath: tampered,
  });
  if (
    negative.schema !== VERIFICATION_SCHEMA ||
    negative.status !== "stopped_for_evaluation" ||
    negative.zeroUnexplainedFindings !== false ||
    !negative.findings?.some(
      (finding) => finding.ruleId === "boundary-evidence-receipt-mismatch",
    )
  ) {
    throw new Error(`${bundle}: stale-receipt negative canary was not rejected by TJSV`);
  }

  const summary = {
    schema: "ores.locks.language-runtime-boundary-summary/v1",
    bundle,
    sourceRevision: expectedRevision,
    validator: {
      repository: "ORESoftware/typespec-json-schema-validator",
      commit: TJSV_COMMIT,
      verifier: "verifyLanguageBoundaries",
    },
    parityReceiptRunId: report.runId,
    contractIrId: contractIr.irId,
    manifestSha256: sha256(Buffer.from(canonicalJson(manifest))),
    verificationId: verification.verificationId,
    negativeVerificationId: negative.verificationId,
    requiredLanguages: targets.map(({ language }) => language),
    status: "passed",
  };

  await Promise.all([
    writeFile(`${output}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(`${output}/verification.json`, `${JSON.stringify(verification, null, 2)}\n`),
    writeFile(`${output}/negative-verification.json`, `${JSON.stringify(negative, null, 2)}\n`),
    writeFile(`${output}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`),
  ]);
  process.stdout.write(
    `${bundle}: TJSV language/runtime admission ${verification.verificationId}; stale-receipt canary ${negative.verificationId}\n`,
  );
  return summary;
}

const summaries = await Promise.all([verifyBundle("main"), verifyBundle("renewal")]);
await mkdir("target/contract-runtime-boundary/language-boundary", { recursive: true });
await writeFile(
  "target/contract-runtime-boundary/language-boundary/index.json",
  `${JSON.stringify(
    {
      schema: "ores.locks.language-runtime-boundary-index/v1",
      sourceRevision: expectedRevision,
      validatorCommit: TJSV_COMMIT,
      summaries,
      status: "passed",
    },
    null,
    2,
  )}\n`,
);
