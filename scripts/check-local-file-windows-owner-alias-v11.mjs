import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import {
  LocalFileLockError,
  inspect_local_file_lock,
  recover_local_file_lock,
} from "../src/ts/dist/index.js";

if (process.platform !== "win32") {
  console.log("SKIP Windows owner-marker case-alias matrix on non-Windows host");
  process.exit(0);
}

const root = await mkdtemp(join(tmpdir(), "ores-owner-alias-v11-"));
try {
  for (const spelling of ["Owner", "OWNER", "oWnEr"]) {
    const path = join(root, `${spelling}.lock`);
    await mkdir(path);
    await writeFile(join(path, spelling), "alias-owner", { encoding: "utf8" });

    const inspection = await inspect_local_file_lock(path);
    assert.equal(inspection.state, "compromised", `${spelling} must not authenticate canonical owner state`);
    assert.equal(inspection.reason, "dirty_directory");
    await assert.rejects(
      recover_local_file_lock(path, "alias-owner", true),
      (error) => error instanceof LocalFileLockError && error.kind === "compromised",
    );
    console.log(`PASS ${spelling}-case-alias-fails-closed`);
  }

  const collisionPath = join(root, "canonical-collision.lock");
  await mkdir(collisionPath);
  await writeFile(join(collisionPath, "owner"), "canonical-owner", { encoding: "utf8" });
  await assert.rejects(
    open(join(collisionPath, "OWNER"), "wx"),
    (error) => error?.code === "EEXIST",
    "case-insensitive filesystem must reject a second owner-marker identity",
  );
  assert.deepEqual(await inspect_local_file_lock(collisionPath), {
    state: "held",
    owner: "canonical-owner",
  });
  console.log("PASS canonical-owner-case-collision-does-not-create-second-authority");
} finally {
  await rm(root, { recursive: true, force: true });
}
