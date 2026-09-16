import { readFile, writeFile } from "node:fs/promises";

const path = "scripts/tmp-apply-v11-runtime.mjs";
let source = await readFile(path, "utf8");
const replacements = [
  ["    readonly birthtimeMs: number;\\n    readonly ctimeMs: number;\\n    isDirectory(): boolean;", "    readonly birthtimeMs: number;\\n    isDirectory(): boolean;"],
  ["  birthtime_ms: number;\\n  ctime_ms: number;\\n}>;", "  birthtime_ms: number;\\n}>;"],
  ["    birthtime_ms: metadata.birthtimeMs,\\n    ctime_ms: metadata.ctimeMs,\\n  };", "    birthtime_ms: metadata.birthtimeMs,\\n  };"],
  ["    && left.birthtime_ms === right.birthtime_ms\\n    && left.ctime_ms === right.ctime_ms;", "    && left.birthtime_ms === right.birthtime_ms;"],
];
for (const [from, to] of replacements) {
  if (!source.includes(from)) throw new Error(`missing normalization target: ${from}`);
  source = source.replace(from, to);
}
await writeFile(path, source);
