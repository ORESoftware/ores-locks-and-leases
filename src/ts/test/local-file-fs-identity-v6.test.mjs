import assert from "node:assert/strict";
import { link, mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  inspect_local_file_lock,
  try_acquire_local_file_lock,
} from "../dist/index.js";

async function withTempRoot(prefix, work) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  try {
    await work(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function proveFilesystemAliasPair(root, firstName, secondName, label) {
  const firstPath = join(root, firstName);
  const secondPath = join(root, secondName);
  const first = await try_acquire_local_file_lock(firstPath, `${label}-first`);
  assert.ok(first, `${label}: first spelling must acquire`);

  const second = await try_acquire_local_file_lock(secondPath, `${label}-second`);
  if (second === null) {
    // The filesystem aliases these spellings. Atomic mkdir therefore supplies
    // one shared rendezvous and the second spelling correctly contends.
    await first.release();
    assert.equal((await inspect_local_file_lock(secondPath)).state, "absent");
    return "aliased";
  }

  // The filesystem treats these spellings as distinct. Both locks are valid
  // independent rendezvous points; the library must not invent normalization.
  await second.release();
  await first.release();
  assert.equal((await inspect_local_file_lock(firstPath)).state, "absent");
  assert.equal((await inspect_local_file_lock(secondPath)).state, "absent");
  return "distinct";
}

test("filesystem normalization aliases either contend or remain independent without library normalization", async () => {
  await withTempRoot("ores-normalization-v6-", async (root) => {
    const composed = "caf\u00e9.lock";
    const decomposed = "cafe\u0301.lock";
    const result = await proveFilesystemAliasPair(root, composed, decomposed, "unicode-normalization");
    assert.ok(result === "aliased" || result === "distinct");
  });
});

test("filesystem case aliases either contend or remain independent without library case-folding", async () => {
  await withTempRoot("ores-casefold-v6-", async (root) => {
    const result = await proveFilesystemAliasPair(root, "CaseFold.lock", "casefold.lock", "case-fold");
    assert.ok(result === "aliased" || result === "distinct");
  });
});

test("hard-linked owner marker is compromised and release becomes safe after alias removal", async () => {
  await withTempRoot("ores-hardlink-v6-", async (root) => {
    const lockPath = join(root, "hardlink.lock");
    const aliasPath = join(root, "owner-hardlink-alias");
    const lock = await try_acquire_local_file_lock(lockPath, "owner-hardlink");
    assert.ok(lock);

    try {
      await link(join(lockPath, "owner"), aliasPath);
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP"].includes(error?.code)) {
        // The platform/filesystem does not expose hard-link creation to this
        // runner. That is a conditional capability result, not a false pass.
        await lock.release();
        return;
      }
      throw error;
    }

    const inspection = await inspect_local_file_lock(lockPath);
    assert.equal(inspection.state, "compromised");
    await assert.rejects(
      lock.release(),
      (error) => error?.kind === "compromised" && /multiple filesystem links/.test(error.message),
    );

    await unlink(aliasPath);
    await lock.release();
    assert.equal((await inspect_local_file_lock(lockPath)).state, "absent");
  });
});
