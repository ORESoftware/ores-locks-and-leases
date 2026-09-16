import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

if (process.platform !== "win32") {
  console.log("SKIP Windows local-lock path policy probes on non-Windows host");
  process.exit(0);
}

const repoRoot = process.cwd();
const rustProbe = resolve(repoRoot, "src/rust/target/debug/examples/local_file_probe.exe");
const goProbe = resolve(repoRoot, "tmp/local-file-go-probe.exe");
const nodeProbe = resolve(repoRoot, "src/ts/test/local-file-process-probe.mjs");
const gleamRoot = resolve(repoRoot, "src/gleam");

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

async function assertRejected(runtime, root, name, fullPath) {
  let outcome;
  if (runtime === "rust") {
    outcome = await run(rustProbe, ["try", fullPath, "windows-policy-owner"]);
  } else if (runtime === "go") {
    outcome = await run(goProbe, ["try", fullPath, "windows-policy-owner"]);
  } else if (runtime === "node") {
    outcome = await run(process.execPath, [nodeProbe, "try", fullPath, "windows-policy-owner"]);
  } else if (runtime === "gleam") {
    outcome = await run(
      "gleam",
      ["run", "-m", "local_file_probe", "--", "try", root, name, "windows-policy-owner", "0"],
      gleamRoot,
    );
  } else {
    throw new Error(`unknown runtime ${runtime}`);
  }
  assert.equal(
    outcome.code,
    20,
    `${runtime} admitted Windows-ambiguous path ${JSON.stringify(fullPath)}: ${JSON.stringify(outcome)}`,
  );
}

const root = await mkdtemp(join(tmpdir(), "ores-local-win-policy-"));
try {
  const ordinaryCases = [
    ["reserved-CON", "CON.lock"],
    ["reserved-NUL", "NUL.txt"],
    ["reserved-COM1", "COM1.data"],
    ["reserved-LPT9", "LPT9.lock"],
    ["trailing-dot", "trailing."],
    ["trailing-space", "trailing "],
    ["ads", "stream:alternate"],
  ];

  for (const [label, name] of ordinaryCases) {
    const fullPath = join(root, name);
    for (const runtime of ["rust", "go", "node", "gleam"]) {
      await assertRejected(runtime, root, name, fullPath);
    }
    console.log(`PASS ${label}`);
  }

  const normalLeaf = "device-prefix.lock";
  const verbatimRoot = `\\\\?\\${root}`;
  const deviceRoot = `\\\\.\\${root}`;
  const ntRoot = `\\??\\${root}`;
  for (const [label, specialRoot] of [
    ["verbatim-prefix", verbatimRoot],
    ["device-prefix", deviceRoot],
    ["nt-object-prefix", ntRoot],
  ]) {
    const fullPath = `${specialRoot}\\${normalLeaf}`;
    for (const runtime of ["rust", "go", "node", "gleam"]) {
      await assertRejected(runtime, specialRoot, normalLeaf, fullPath);
    }
    console.log(`PASS ${label}`);
  }

  console.log("Windows local-lock path admission policy passed for Rust/Go/Node/Gleam");
} finally {
  await rm(root, { recursive: true, force: true });
}
