import { readFile, writeFile } from "node:fs/promises";

const path = "scripts/check-local-file-process-interop.mjs";
let source = await readFile(path, "utf8");

const anchor = `const gleamRoot = resolve(repoRoot, "src/gleam");
const runtimes = ["rust", "go", "node", "gleam"];`;
const replacement = `const gleamRoot = resolve(repoRoot, "src/gleam");
const gleamEbinRoot = resolve(gleamRoot, "build/dev/erlang");
const gleamEbinPaths = (await readdir(gleamEbinRoot))
  .sort()
  .map((name) => resolve(gleamEbinRoot, name, "ebin"));
const gleamCodePathArgs = gleamEbinPaths.flatMap((path) => ["-pa", path]);
const runtimes = ["rust", "go", "node", "gleam"];`;

if (!source.includes(anchor)) throw new Error("missing gleam root anchor");
source = source.replace(anchor, replacement);

const oldBlock = `  if (runtime === "gleam") {
    return {
      command: "gleam",
      args: [
        "run",
        "-m",
        "local_file_probe",
        "--",
        mode,
        dirname(lockPath),
        basename(lockPath),
        owner,
        String(holdMs),
      ],
      cwd: gleamRoot,
    };
  }`;

const newBlock = `  if (runtime === "gleam") {
    return {
      command: "erl",
      args: [
        "-noshell",
        ...gleamCodePathArgs,
        "-s",
        "local_file_probe",
        "main",
        "-s",
        "init",
        "stop",
        "-extra",
        mode,
        dirname(lockPath),
        basename(lockPath),
        owner,
        String(holdMs),
      ],
      cwd: gleamRoot,
    };
  }`;

if (!source.includes(oldBlock)) throw new Error("missing gleam command block");
source = source.replace(oldBlock, newBlock);
await writeFile(path, source);
