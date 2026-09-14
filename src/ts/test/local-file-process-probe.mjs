import process from "node:process";
import { try_acquire_local_file_lock } from "../dist/index.js";

function usage() {
  console.error("usage: local-file-process-probe <hold|try|crash> <path> <owner> [hold_ms]");
  process.exit(2);
}

const [mode, path, owner, holdText] = process.argv.slice(2);
if (!mode || !path || owner === undefined || process.argv.length > 6) usage();
const holdMs = holdText === undefined ? 0 : Number(holdText);
if (!Number.isSafeInteger(holdMs) || holdMs < 0) usage();

try {
  const lock = await try_acquire_local_file_lock(path, owner);
  if (lock === null) {
    console.log("CONTENDED");
    process.exit(10);
  }

  console.log("ACQUIRED");
  if (mode === "hold") {
    await new Promise((resolve) => setTimeout(resolve, holdMs));
  } else if (mode === "crash") {
    console.log("CRASHED");
    process.exit(30);
  } else if (mode !== "try") {
    usage();
  }

  await lock.release();
  console.log("RELEASED");
} catch (error) {
  console.error(`ERROR:${error?.kind ?? "unknown"}:${error?.message ?? String(error)}`);
  process.exit(20);
}
