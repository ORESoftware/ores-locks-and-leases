import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  inspect_local_file_lock,
  try_acquire_local_file_lock,
} from "../dist/index.js";

function validateInspection(inspection) {
  assert.ok(["absent", "held", "incomplete", "compromised"].includes(inspection.state));
  if (inspection.state === "held") {
    assert.equal(typeof inspection.owner, "string");
    assert.ok(inspection.owner.length > 0);
    assert.equal("message" in inspection, false);
    return;
  }
  assert.equal("owner" in inspection, false);
  if (inspection.state === "absent") {
    assert.equal("message" in inspection, false);
    return;
  }
  assert.equal(typeof inspection.message, "string");
  assert.ok(inspection.message.length > 0);
}

function yieldTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("inspection remains state-valid during repeated live acquire/release transitions", async () => {
  const root = await mkdtemp(join(tmpdir(), "ores-local-lock-transition-"));
  const path = join(root, "install.lock");
  let done = false;
  let observations = 0;

  try {
    const observer = (async () => {
      while (!done) {
        const inspection = await inspect_local_file_lock(path);
        validateInspection(inspection);
        observations += 1;
        await yieldTurn();
      }
      validateInspection(await inspect_local_file_lock(path));
    })();

    for (let iteration = 0; iteration < 100; iteration += 1) {
      const owner = `owner-${iteration}`;
      const lock = await try_acquire_local_file_lock(path, owner);
      assert.ok(lock, `iteration ${iteration} unexpectedly contended`);

      const held = await inspect_local_file_lock(path);
      validateInspection(held);
      if (held.state === "held") assert.equal(held.owner, owner);

      await yieldTurn();
      await lock.release();
      await yieldTurn();
    }

    done = true;
    await observer;
    assert.ok(observations > 0);
    assert.equal((await inspect_local_file_lock(path)).state, "absent");
  } finally {
    done = true;
    await rm(root, { recursive: true, force: true });
  }
});
