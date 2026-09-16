import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import {
  LocalFileLockError,
  inspect_local_file_lock,
  recover_local_file_lock,
  try_acquire_local_file_lock,
} from "../src/ts/dist/index.js";

if (process.platform === "win32") {
  console.log("SKIP POSIX permission/read-only local-lock fault matrix on Windows");
  process.exit(0);
}

function isIo(error) {
  return error instanceof LocalFileLockError && error.kind === "io";
}

async function assertAbsentPath(path) {
  await assert.rejects(lstat(path), (error) => error?.code === "ENOENT");
}

const root = await mkdtemp(join(tmpdir(), "ores-local-permission-v11-"));
try {
  // Read-only/non-writable parent admission: acquisition fails as structured IO
  // and must not leave a rendezvous directory behind.
  const readOnlyParent = join(root, "read-only-parent");
  const readOnlyLock = join(readOnlyParent, "child.lock");
  await mkdir(readOnlyParent, { mode: 0o700 });
  await chmod(readOnlyParent, 0o500);
  await assert.rejects(
    try_acquire_local_file_lock(readOnlyLock, "read-only-owner"),
    isIo,
  );
  await assertAbsentPath(readOnlyLock);
  await chmod(readOnlyParent, 0o700);
  console.log("PASS non-writable-parent-fails-io-without-lock-mutation");

  // Owner-read denial must not mutate release state. Restore permission and the
  // same holder must still be able to release successfully.
  const releasePath = join(root, "release-permission.lock");
  const releaseLock = await try_acquire_local_file_lock(releasePath, "release-owner");
  assert.ok(releaseLock);
  await chmod(join(releasePath, "owner"), 0o000);
  await assert.rejects(releaseLock.release(), isIo);
  await lstat(join(releasePath, "owner"));
  await chmod(join(releasePath, "owner"), 0o600);
  await releaseLock.release();
  await assertAbsentPath(releasePath);
  console.log("PASS owner-read-denial-release-remains-non-destructive");

  // Recovery has the same fail-closed rule: denial while authenticating the
  // persisted owner cannot remove either marker or rendezvous.
  const recoveryPath = join(root, "recovery-permission.lock");
  const recoveryLock = await try_acquire_local_file_lock(recoveryPath, "recovery-owner");
  assert.ok(recoveryLock);
  await chmod(join(recoveryPath, "owner"), 0o000);
  await assert.rejects(
    recover_local_file_lock(recoveryPath, "recovery-owner", true),
    isIo,
  );
  await lstat(join(recoveryPath, "owner"));
  await chmod(join(recoveryPath, "owner"), 0o600);
  assert.deepEqual(await inspect_local_file_lock(recoveryPath), {
    state: "held",
    owner: "recovery-owner",
  });
  assert.equal(await recover_local_file_lock(recoveryPath, "recovery-owner", true), true);
  await assertAbsentPath(recoveryPath);
  console.log("PASS owner-read-denial-recovery-remains-non-destructive");
} finally {
  await rm(root, { recursive: true, force: true });
}
