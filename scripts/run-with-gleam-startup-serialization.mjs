import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";

const target = process.argv[2];
if (!target || process.argv.length !== 3) {
  console.error("usage: run-with-gleam-startup-serialization.mjs <target-module>");
  process.exit(2);
}

const isWindows = process.platform === "win32";
const locator = spawnSync(isWindows ? "where.exe" : "which", ["gleam"], {
  encoding: "utf8",
  env: process.env,
});
if (locator.status !== 0) {
  console.error(locator.stderr || "unable to locate real gleam executable");
  process.exit(2);
}
const realGleam = locator.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
if (!realGleam) {
  console.error("unable to locate real gleam executable");
  process.exit(2);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const shimModule = resolve(scriptDir, "gleam-startup-shim.mjs");
const shimDir = await mkdtemp(join(tmpdir(), "ores-gleam-shim-"));
const startupLock = join(tmpdir(), `ores-gleam-startup-${process.pid}.lock`);
const nodeExe = process.execPath;

try {
  if (isWindows) {
    await writeFile(
      join(shimDir, "gleam.cmd"),
      `@echo off\r\n"${nodeExe}" "${shimModule}" %*\r\nexit /b %ERRORLEVEL%\r\n`,
      "utf8",
    );
  } else {
    const shimPath = join(shimDir, "gleam");
    await writeFile(
      shimPath,
      `#!/bin/sh\nexec "${nodeExe}" "${shimModule}" "$@"\n`,
      "utf8",
    );
    await chmod(shimPath, 0o755);
  }

  process.env.ORES_REAL_GLEAM = realGleam;
  process.env.ORES_GLEAM_STARTUP_LOCK = startupLock;
  process.env.PATH = `${shimDir}${delimiter}${process.env.PATH ?? ""}`;
  await import(pathToFileURL(resolve(process.cwd(), target)).href);
} finally {
  await rm(shimDir, { recursive: true, force: true });
  await rm(startupLock, { recursive: true, force: true });
}
