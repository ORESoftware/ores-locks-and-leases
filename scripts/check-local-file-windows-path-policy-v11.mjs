import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";

if (process.platform !== "win32") {
  console.log("SKIP Windows path-form policy matrix on non-Windows host");
  process.exit(0);
}

const repoRoot = process.cwd();
const rustProbe = resolve(repoRoot, "src/rust/target/debug/examples/local_file_probe.exe");
const goProbe = resolve(repoRoot, "tmp/local-file-go-probe.exe");
const nodeProbe = resolve(repoRoot, "src/ts/test/local-file-process-probe.mjs");
const gleamRoot = resolve(repoRoot, "src/gleam");
const runtimes = ["rust", "go", "node", "gleam"];

function run(command, args, cwd = repoRoot) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => resolveRun({ code, signal, stdout, stderr }));
  });
}

function commandFor(runtime, fullPath, root = dirname(fullPath), name = basename(fullPath)) {
  if (runtime === "rust") return [rustProbe, ["try", fullPath, "windows-v11-owner"], repoRoot];
  if (runtime === "go") return [goProbe, ["try", fullPath, "windows-v11-owner"], repoRoot];
  if (runtime === "node") return [process.execPath, [nodeProbe, "try", fullPath, "windows-v11-owner"], repoRoot];
  if (runtime === "gleam") {
    return [
      "gleam",
      ["run", "-m", "local_file_probe", "--", "try", root, name, "windows-v11-owner", "0"],
      gleamRoot,
    ];
  }
  throw new Error(`unknown runtime ${runtime}`);
}

async function probe(runtime, fullPath, root, name) {
  const [command, args, cwd] = commandFor(runtime, fullPath, root, name);
  return run(command, args, cwd);
}

function output(result) {
  return `${result.stdout}\n${result.stderr}`;
}

async function assertInvalidInput(runtime, fullPath, root, name, label) {
  const result = await probe(runtime, fullPath, root, name);
  assert.equal(result.code, 20, `${label}/${runtime} should be policy rejection: ${JSON.stringify(result)}`);
  assert.match(
    output(result),
    /invalid_input|InvalidInput/,
    `${label}/${runtime} must reject by structured invalid_input, not generic IO`,
  );
}

const root = await mkdtemp(join(tmpdir(), "ores-win-path-v11-"));
try {
  // Ordinary drive-absolute paths are the normal Windows local-filesystem form.
  const driveAbsolute = join(root, "drive-absolute.lock");
  for (const runtime of runtimes) {
    const result = await probe(runtime, driveAbsolute, dirname(driveAbsolute), basename(driveAbsolute));
    assert.equal(result.code, 0, `drive-absolute/${runtime}: ${JSON.stringify(result)}`);
  }
  console.log("PASS drive-absolute-admitted-all-runtimes");

  // Drive-relative paths depend on per-process current-drive state and are
  // intentionally rejected rather than treated as a stable rendezvous identity.
  const drive = root.slice(0, 2);
  const driveRelative = `${drive}relative-v11.lock`;
  for (const runtime of ["rust", "go", "node"]) {
    await assertInvalidInput(runtime, driveRelative, undefined, undefined, "drive-relative");
  }
  // Gleam exposes root + one-component name rather than a raw path. `C:.` keeps
  // the same drive-relative semantics at that public boundary.
  await assertInvalidInput("gleam", `${drive}./relative-v11.lock`, `${drive}.`, "relative-v11.lock", "drive-relative");
  console.log("PASS drive-relative-rejected-as-invalid-input-all-runtimes");

  // Device/verbatim/NT namespaces are distinct from ordinary UNC syntax and are
  // always rejected before filesystem mutation.
  for (const [label, specialRoot] of [
    ["verbatim", `\\\\?\\${root}`],
    ["device", `\\\\.\\${root}`],
    ["nt-object", `\\??\\${root}`],
  ]) {
    const fullPath = `${specialRoot}\\device-v11.lock`;
    for (const runtime of runtimes) {
      await assertInvalidInput(runtime, fullPath, specialRoot, "device-v11.lock", label);
    }
    console.log(`PASS ${label}-namespace-rejected-as-invalid-input`);
  }

  // Ordinary UNC is syntactically distinct from the forbidden namespaces. It
  // remains an admitted path spelling, but the portable lock contract does not
  // claim correctness on SMB/network filesystems. Probe a guaranteed-missing
  // localhost share: IO is acceptable evidence of syntactic admission;
  // invalid_input is not.
  const missingShare = `\\\\localhost\\__ores_missing_share_${process.pid}__`;
  const uncPath = `${missingShare}\\unc-v11.lock`;
  for (const runtime of runtimes) {
    const result = await probe(runtime, uncPath, missingShare, "unc-v11.lock");
    assert.equal(result.code, 20, `missing UNC share should fail at filesystem boundary for ${runtime}`);
    assert.doesNotMatch(
      output(result),
      /invalid_input|InvalidInput/,
      `ordinary UNC must not be confused with device/verbatim namespace for ${runtime}`,
    );
  }
  console.log("PASS ordinary-unc-is-syntactically-admitted-but-network-filesystem-unsupported");
} finally {
  await rm(root, { recursive: true, force: true });
}
