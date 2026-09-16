import { existsSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const erlangRoot = resolve(repoRoot, "src/gleam/build/dev/erlang");

if (!existsSync(erlangRoot)) {
  console.error(`Gleam build output is missing: ${erlangRoot}`);
  process.exit(2);
}

const codePaths = [];
for (const packageName of readdirSync(erlangRoot)) {
  const packageRoot = resolve(erlangRoot, packageName);
  for (const child of ["_gleam_artefacts", "ebin"]) {
    const candidate = resolve(packageRoot, child);
    if (existsSync(candidate)) codePaths.push(candidate);
  }
}

const passthrough = process.argv.slice(2);
const args = [];
for (const codePath of codePaths) args.push("-pa", codePath);
args.push(
  "-noshell",
  "-s",
  "local_file_probe",
  "main",
  "-s",
  "init",
  "stop",
  "-extra",
  ...passthrough,
);

const child = spawn("erl", args, {
  cwd: resolve(repoRoot, "src/gleam"),
  env: process.env,
  stdio: "inherit",
  windowsHide: true,
});

child.once("error", (error) => {
  console.error(error);
  process.exit(2);
});
child.once("exit", (code, signal) => {
  if (signal) {
    console.error(`erl probe terminated by ${signal}`);
    process.exit(2);
  }
  process.exit(code ?? 2);
});
