import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  LocalFileLockError,
  inspect_local_file_lock,
  recover_local_file_lock,
} from "../dist/index.js";

async function withTempDir(run) {
  const root = await mkdtemp(join(tmpdir(), "ores-local-inspection-v6-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function makeHeld(path, owner) {
  await mkdir(path, { mode: 0o700 });
  await writeFile(join(path, "owner"), owner, { mode: 0o600 });
}

function assertDiagnosticShape(inspection, state, reason) {
  assert.equal(inspection.state, state);
  assert.equal(inspection.reason, reason);
  assert.equal(typeof inspection.message, "string");
  assert.ok(inspection.message.length > 0);
  assert.equal("owner" in inspection, false);
}

test("1 absent inspection has the exact closed runtime payload shape", async () => {
  await withTempDir(async (root) => {
    const inspection = await inspect_local_file_lock(join(root, "missing.lock"));
    assert.deepEqual(inspection, { state: "absent" });
    assert.deepEqual(Object.keys(inspection), ["state"]);
  });
});

test("2 healthy held inspection has exactly state and owner", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "held.lock");
    await makeHeld(path, "owner-a");
    const inspection = await inspect_local_file_lock(path);
    assert.deepEqual(inspection, { state: "held", owner: "owner-a" });
    assert.deepEqual(Object.keys(inspection), ["state", "owner"]);
  });
});

test("3 ownerless provisional directory has exact incomplete diagnostics", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "incomplete.lock");
    await mkdir(path, { mode: 0o700 });
    const inspection = await inspect_local_file_lock(path);
    assertDiagnosticShape(inspection, "incomplete", "owner_marker_missing");
  });
});

test("4 regular file rendezvous reports path_not_directory", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "regular-file.lock");
    await writeFile(path, "not-a-directory", { mode: 0o600 });
    const inspection = await inspect_local_file_lock(path);
    assertDiagnosticShape(inspection, "compromised", "path_not_directory");
  });
});

test("5 dirty rendezvous reports dirty_directory without owner payload", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "dirty.lock");
    await makeHeld(path, "owner-a");
    await writeFile(join(path, "unexpected"), "x", { mode: 0o600 });
    const inspection = await inspect_local_file_lock(path);
    assertDiagnosticShape(inspection, "compromised", "dirty_directory");
  });
});

test("6 non-file owner marker reports owner_not_regular_file", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "owner-directory.lock");
    await mkdir(path, { mode: 0o700 });
    await mkdir(join(path, "owner"), { mode: 0o700 });
    const inspection = await inspect_local_file_lock(path);
    assertDiagnosticShape(inspection, "compromised", "owner_not_regular_file");
  });
});

test("7 owner above the 2048-byte storage ceiling reports owner_too_large", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "owner-too-large.lock");
    await makeHeld(path, "a".repeat(2049));
    const inspection = await inspect_local_file_lock(path);
    assertDiagnosticShape(inspection, "compromised", "owner_too_large");
  });
});

test("8 invalid persisted UTF-8 reports owner_invalid_utf8", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "invalid-utf8.lock");
    await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, "owner"), Buffer.from([0xff]), { mode: 0o600 });
    const inspection = await inspect_local_file_lock(path);
    assertDiagnosticShape(inspection, "compromised", "owner_invalid_utf8");
  });
});

test("9 empty persisted owner reports owner_contract_violation", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "empty-owner.lock");
    await makeHeld(path, "");
    const inspection = await inspect_local_file_lock(path);
    assertDiagnosticShape(inspection, "compromised", "owner_contract_violation");
  });
});

test("10 2048 ASCII bytes stay under byte ceiling but violate 512-scalar owner contract", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "scalar-overflow.lock");
    const owner = "a".repeat(2048);
    assert.equal(Buffer.byteLength(owner, "utf8"), 2048);
    await makeHeld(path, owner);
    const inspection = await inspect_local_file_lock(path);
    assertDiagnosticShape(inspection, "compromised", "owner_contract_violation");
  });
});

test("11 exactly 512 four-byte scalars at exactly 2048 UTF-8 bytes remain held", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "max-scalar-byte-boundary.lock");
    const owner = "🚀".repeat(512);
    assert.equal(Array.from(owner).length, 512);
    assert.equal(Buffer.byteLength(owner, "utf8"), 2048);
    await makeHeld(path, owner);
    const inspection = await inspect_local_file_lock(path);
    assert.deepEqual(inspection, { state: "held", owner });
  });
});

test("12 POSIX owner permission widening reports permissions_widened", { skip: process.platform === "win32" }, async () => {
  await withTempDir(async (root) => {
    const path = join(root, "owner-mode.lock");
    await makeHeld(path, "owner-a");
    await chmod(join(path, "owner"), 0o644);
    const inspection = await inspect_local_file_lock(path);
    assertDiagnosticShape(inspection, "compromised", "permissions_widened");
  });
});

test("13 POSIX rendezvous permission widening reports permissions_widened", { skip: process.platform === "win32" }, async () => {
  await withTempDir(async (root) => {
    const path = join(root, "directory-mode.lock");
    await makeHeld(path, "owner-a");
    await chmod(path, 0o755);
    const inspection = await inspect_local_file_lock(path);
    assertDiagnosticShape(inspection, "compromised", "permissions_widened");
  });
});

test("14 recovery of incomplete state is typed compromised and preserves the exact state", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "recover-incomplete.lock");
    await mkdir(path, { mode: 0o700 });
    await assert.rejects(
      recover_local_file_lock(path, "expected-owner", true),
      (error) => {
        assert.ok(error instanceof LocalFileLockError);
        assert.equal(error.kind, "compromised");
        assert.equal(error.path, path);
        return true;
      },
    );
    const inspection = await inspect_local_file_lock(path);
    assertDiagnosticShape(inspection, "incomplete", "owner_marker_missing");
  });
});

test("15 recovery owner mismatch is redacted and preserves the healthy owner", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "recover-mismatch.lock");
    const actualOwner = "actual-secret-owner-7f1f";
    const expectedOwner = "expected-secret-owner-9a2c";
    await makeHeld(path, actualOwner);
    await assert.rejects(
      recover_local_file_lock(path, expectedOwner, true),
      (error) => {
        assert.ok(error instanceof LocalFileLockError);
        assert.equal(error.kind, "compromised");
        assert.equal(error.path, path);
        assert.equal(error.message.includes(actualOwner), false);
        assert.equal(error.message.includes(expectedOwner), false);
        return true;
      },
    );
    assert.deepEqual(await inspect_local_file_lock(path), { state: "held", owner: actualOwner });
  });
});
