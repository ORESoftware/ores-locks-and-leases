import { mkdir, rmdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import process from "node:process";

const realGleam = process.env.ORES_REAL_GLEAM;
const startupLock = process.env.ORES_GLEAM_STARTUP_LOCK;
if (!realGleam || !startupLock) {
  console.error("gleam startup shim requires ORES_REAL_GLEAM and ORES_GLEAM_STARTUP_LOCK");
  process.exit(2);
}

const args = process.argv.slice(2);
const serializesBootstrap = args[0] === "run";
let ownsStartupLock = false;
let released = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function acquireStartupLock() {
  if (!serializesBootstrap) return;
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      await mkdir(startupLock);
      ownsStartupLock = true;
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for Gleam startup serialization lock ${startupLock}`);
      }
      await sleep(25);
    }
  }
}

async function releaseStartupLock() {
  if (!ownsStartupLock || released) return;
  released = true;
  ownsStartupLock = false;
  try {
    await rmdir(startupLock);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

await acquireStartupLock();

const child = spawn(realGleam, args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["inherit", "pipe", "pipe"],
  windowsHide: true,
});

let startupText = "";
function forward(stream, destination) {
  stream.on("data", (chunk) => {
    destination.write(chunk);
    if (!released && serializesBootstrap) {
      startupText = (startupText + chunk.toString("utf8")).slice(-8192);
      if (
        startupText.includes("Running local_file_probe.main") ||
        startupText.includes("ACQUIRED") ||
        startupText.includes("CONTENDED") ||
        startupText.includes("ERROR:") ||
        startupText.includes("LOCK_ERROR")
      ) {
        void releaseStartupLock();
      }
    }
  });
}
forward(child.stdout, process.stdout);
forward(child.stderr, process.stderr);

const terminate = (signal) => {
  child.kill(signal);
  void releaseStartupLock().finally(() => process.exit(128));
};
process.once("SIGINT", () => terminate("SIGINT"));
process.once("SIGTERM", () => terminate("SIGTERM"));

const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal) resolve(1);
    else resolve(code ?? 1);
  });
}).finally(releaseStartupLock);

process.exitCode = exitCode;
