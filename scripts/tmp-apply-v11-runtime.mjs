import { readFile, writeFile } from "node:fs/promises";

function once(text, from, to, label) {
  const at = text.indexOf(from);
  if (at < 0) throw new Error(`missing ${label}`);
  if (text.indexOf(from, at + from.length) >= 0) throw new Error(`non-unique ${label}`);
  return text.slice(0, at) + to + text.slice(at + from.length);
}

let path = "src/ts/src/local-file-node-shims.d.ts";
let source = await readFile(path, "utf8");
source = once(
  source,
  "    readonly nlink: number;\n    isDirectory(): boolean;",
  "    readonly nlink: number;\n    readonly birthtimeMs: number;\n    readonly ctimeMs: number;\n    isDirectory(): boolean;",
  "stat timestamp shim",
);
await writeFile(path, source);

path = "src/ts/src/local-file.ts";
source = await readFile(path, "utf8");
source = once(
  source,
  'import { lstat, mkdir, open, opendir, rename, rmdir, unlink } from "node:fs/promises";\n',
  'import { lstat, mkdir, open, opendir, rename, rmdir, unlink } from "node:fs/promises";\n\nimport {\n  is_local_file_test_crash,\n  local_file_test_fault_enabled,\n  maybe_inject_local_file_test_fault,\n  maybe_simulate_local_file_test_crash,\n} from "./local-file-test-faults.js";\n',
  "fault imports",
);
source = once(
  source,
  'type LocalFileLockReleaseState = "held" | "released" | "partial";\nconst LOCAL_FILE_LOCK_CONSTRUCTOR_TOKEN = Symbol("ores-local-file-lock-held-constructor");\n',
  'type LocalFileLockReleaseState = "held" | "released" | "partial";\ntype LocalFileOwnerIdentity = Readonly<{\n  dev: number;\n  ino: number;\n  birthtime_ms: number;\n  ctime_ms: number;\n}>;\nconst LOCAL_FILE_LOCK_CONSTRUCTOR_TOKEN = Symbol("ores-local-file-lock-held-constructor");\n',
  "owner identity type",
);
source = once(
  source,
  '  #partial_release_error: unknown | undefined;\n\n  constructor(path: string, owner: string, token: typeof LOCAL_FILE_LOCK_CONSTRUCTOR_TOKEN) {',
  '  #partial_release_error: unknown | undefined;\n  readonly #owner_identity: LocalFileOwnerIdentity;\n\n  constructor(\n    path: string,\n    owner: string,\n    ownerIdentity: LocalFileOwnerIdentity,\n    token: typeof LOCAL_FILE_LOCK_CONSTRUCTOR_TOKEN,\n  ) {',
  "constructor identity parameter",
);
source = once(
  source,
  '    this.path = path;\n    this.owner = owner;\n  }',
  '    this.path = path;\n    this.owner = owner;\n    this.#owner_identity = ownerIdentity;\n  }',
  "constructor identity assignment",
);
source = once(
  source,
  '    await validate_regular_file(this.path, ownerPath, "owner token");\n    const observed = await read_bounded_local_file_lock_owner(this.path, ownerPath);',
  '    await validate_regular_file(this.path, ownerPath, "owner token");\n    const currentOwnerIdentity = await read_local_file_owner_identity(this.path, ownerPath);\n    if (!same_local_file_owner_identity(this.#owner_identity, currentOwnerIdentity)) {\n      throw new LocalFileLockError(\n        "compromised",\n        this.path,\n        "owner marker identity changed; refusing stale-handle release across recovery/reacquisition",\n      );\n    }\n    const observed = await read_bounded_local_file_lock_owner(this.path, ownerPath);',
  "release ABA identity check",
);
source = once(
  source,
  '      await unlink(ownerPath);\n      ownerRemoved = true;\n      await rmdir(this.path);',
  '      await unlink(ownerPath);\n      ownerRemoved = true;\n      maybe_inject_local_file_test_fault("release_rmdir_failure", "EIO");\n      await rmdir(this.path);',
  "release rmdir fault",
);
source = once(
  source,
  '  const parent = dirname(path);\n  try {\n    await mkdir(parent, { recursive: true, mode: 0o700 });',
  '  const parent = dirname(path);\n  try {\n    maybe_inject_local_file_test_fault("parent_prepare_ero_fs", "EROFS");\n    await mkdir(parent, { recursive: true, mode: 0o700 });',
  "EROFS parent fault",
);
source = once(
  source,
  '    pendingHandle = await open(pendingPath, "wx", 0o600);\n    await pendingHandle.writeFile(owner, { encoding: "utf8" });\n    await pendingHandle.sync();\n    await pendingHandle.close();\n    pendingHandle = undefined;\n',
  '    pendingHandle = await open(pendingPath, "wx", 0o600);\n    maybe_simulate_local_file_test_crash("after_pending_create_crash");\n    if (local_file_test_fault_enabled("owner_short_write")) {\n      const prefixLength = Math.max(1, Math.floor(owner.length / 2));\n      await pendingHandle.writeFile(owner.slice(0, prefixLength), { encoding: "utf8" });\n      maybe_inject_local_file_test_fault("owner_short_write", "EIO");\n    } else {\n      await pendingHandle.writeFile(owner, { encoding: "utf8" });\n    }\n    maybe_inject_local_file_test_fault("owner_sync_failure", "EIO");\n    await pendingHandle.sync();\n    await pendingHandle.close();\n    pendingHandle = undefined;\n    maybe_inject_local_file_test_fault("owner_close_failure", "EIO");\n    maybe_simulate_local_file_test_crash("after_pending_sync_crash");\n',
  "publication fault points",
);
source = once(
  source,
  '    await rename(pendingPath, ownerPath);\n  } catch (error) {\n    try {',
  '    maybe_inject_local_file_test_fault("owner_rename_failure", "EIO");\n    await rename(pendingPath, ownerPath);\n    maybe_simulate_local_file_test_crash("after_owner_rename_crash");\n  } catch (error) {\n    if (is_local_file_test_crash(error)) throw error;\n    try {',
  "rename and crash fault points",
);
source = once(
  source,
  '      await unlink(ownerPath).catch((cleanupError) => {\n        if (error_code(cleanupError) !== "ENOENT") throw cleanupError;\n      });\n      await rmdir(path);',
  '      await unlink(ownerPath).catch((cleanupError) => {\n        if (error_code(cleanupError) !== "ENOENT") throw cleanupError;\n      });\n      maybe_inject_local_file_test_fault("rollback_rmdir_failure", "EIO");\n      await rmdir(path);',
  "rollback cleanup fault",
);
source = once(
  source,
  '      throw new LocalFileLockError(\n        "compromised",\n        path,\n        `owner publication failed and provisional lock rollback also failed: ${describe_error(rollbackError)}`,\n        rollbackError,\n      );',
  '      throw new LocalFileLockError(\n        "compromised",\n        path,\n        `owner publication failed: ${describe_error(error)}; provisional lock rollback also failed: ${describe_error(rollbackError)}`,\n        { primary_error: error, rollback_error: rollbackError },\n      );',
  "primary plus rollback context",
);
source = once(
  source,
  '  try {\n    await validate_regular_file(path, ownerPath, "owner token");\n  } catch (error) {',
  '  let ownerIdentity: LocalFileOwnerIdentity;\n  try {\n    await validate_regular_file(path, ownerPath, "owner token");\n    ownerIdentity = await read_local_file_owner_identity(path, ownerPath);\n  } catch (error) {',
  "capture acquisition marker identity",
);
source = once(
  source,
  '  return new LocalFileLock(path, owner, LOCAL_FILE_LOCK_CONSTRUCTOR_TOKEN);',
  '  return new LocalFileLock(path, owner, ownerIdentity, LOCAL_FILE_LOCK_CONSTRUCTOR_TOKEN);',
  "construct holder with identity",
);
source = once(
  source,
  'export async function read_bounded_local_file_lock_owner(lockPath: string, ownerPath: string): Promise<string> {\n  let handle;\n  try {',
  'async function read_local_file_owner_identity(\n  lockPath: string,\n  ownerPath: string,\n): Promise<LocalFileOwnerIdentity> {\n  let metadata;\n  try {\n    metadata = await lstat(ownerPath);\n  } catch (error) {\n    throw io_error(lockPath, "inspect local lock owner identity", error);\n  }\n  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {\n    throw new LocalFileLockError(\n      "compromised",\n      lockPath,\n      "owner marker identity is not a single-link unaliased regular file",\n    );\n  }\n  return {\n    dev: metadata.dev,\n    ino: metadata.ino,\n    birthtime_ms: metadata.birthtimeMs,\n    ctime_ms: metadata.ctimeMs,\n  };\n}\n\nfunction same_local_file_owner_identity(\n  left: LocalFileOwnerIdentity,\n  right: LocalFileOwnerIdentity,\n): boolean {\n  return left.dev === right.dev\n    && left.ino === right.ino\n    && left.birthtime_ms === right.birthtime_ms\n    && left.ctime_ms === right.ctime_ms;\n}\n\nexport async function read_bounded_local_file_lock_owner(lockPath: string, ownerPath: string): Promise<string> {\n  let handle;\n  try {\n    maybe_inject_local_file_test_fault("owner_read_permission", "EACCES");',
  "owner identity helper and wrapped read permission fault",
);
await writeFile(path, source);

path = "src/ts/src/local-file-recovery.ts";
source = await readFile(path, "utf8");
source = once(
  source,
  'import { join } from "node:path";\n',
  'import { join } from "node:path";\n\nimport { maybe_inject_local_file_test_fault } from "./local-file-test-faults.js";\n',
  "recovery fault import",
);
source = once(
  source,
  '  try {\n    // This rename is the destructive recovery linearization point.',
  '  try {\n    maybe_inject_local_file_test_fault("recovery_claim_failure", "EIO");\n    // This rename is the destructive recovery linearization point.',
  "recovery claim fault",
);
await writeFile(path, source);
