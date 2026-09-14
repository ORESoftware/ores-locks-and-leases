import { lstat, readFile, readdir, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import { LocalFileLockError } from "./local-file.js";

const OWNER_FILE = "owner";

export type LocalFileLockInspectionState = "absent" | "held" | "compromised";

export interface LocalFileLockInspection {
  state: LocalFileLockInspectionState;
  owner?: string;
  message?: string;
}

/** Read-only inspection. This never acquires, repairs, or removes a lock. */
export async function inspect_local_file_lock(path: string): Promise<LocalFileLockInspection> {
  let lockMetadata;
  try {
    lockMetadata = await lstat(path);
  } catch (error) {
    if (error_code(error) === "ENOENT") return { state: "absent" };
    throw io_error(path, "inspect local lock path", error);
  }
  if (!lockMetadata.isDirectory() || lockMetadata.isSymbolicLink()) {
    return compromised("lock path is not an unaliased directory");
  }

  let entries: string[];
  try {
    entries = await readdir(path);
  } catch (error) {
    throw io_error(path, "list local lock directory", error);
  }
  if (entries.length !== 1 || entries[0] !== OWNER_FILE) {
    return compromised("lock directory must contain exactly one owner marker");
  }

  const ownerPath = join(path, OWNER_FILE);
  try {
    const ownerMetadata = await lstat(ownerPath);
    if (!ownerMetadata.isFile() || ownerMetadata.isSymbolicLink()) {
      return compromised("owner token is not an unaliased regular file");
    }
  } catch (error) {
    if (error_code(error) === "ENOENT") return compromised("owner token is missing");
    throw io_error(path, "inspect local lock owner token", error);
  }

  let owner: string;
  try {
    owner = await readFile(ownerPath, "utf8");
  } catch (error) {
    throw io_error(path, "read local lock owner token", error);
  }
  if (owner.length === 0) return compromised("owner token is empty");
  return { state: "held", owner };
}

/**
 * Explicit operator-driven recovery. `confirmed_inactive` asserts that the
 * caller independently established the previous owner is inactive and the
 * protected local state is quiescent. Missing locks are idempotent no-ops.
 */
export async function recover_local_file_lock(
  path: string,
  expected_owner: string,
  confirmed_inactive: boolean,
): Promise<boolean> {
  if (!confirmed_inactive) {
    throw new LocalFileLockError(
      "invalid_input",
      path,
      "explicit confirmed_inactive=true is required for recovery",
    );
  }
  if (expected_owner.length === 0) {
    throw new LocalFileLockError("invalid_input", path, "expected owner must not be empty");
  }

  const inspection = await inspect_local_file_lock(path);
  if (inspection.state === "absent") return false;
  if (inspection.state === "compromised") {
    throw new LocalFileLockError(
      "compromised",
      path,
      inspection.message ?? "local lock state is compromised",
    );
  }
  if (inspection.owner !== expected_owner) {
    throw new LocalFileLockError(
      "compromised",
      path,
      "owner token does not match expected recovery owner",
    );
  }

  const finalInspection = await inspect_local_file_lock(path);
  if (finalInspection.state !== "held" || finalInspection.owner !== expected_owner) {
    throw new LocalFileLockError(
      "compromised",
      path,
      "local lock changed during recovery; refusing deletion",
    );
  }

  try {
    await unlink(join(path, OWNER_FILE));
    await rmdir(path);
  } catch (error) {
    const code = error_code(error);
    throw new LocalFileLockError(
      code === "ENOTEMPTY" || code === "EEXIST" ? "compromised" : "io",
      path,
      `recover local lock failed: ${describe_error(error)}`,
      error,
    );
  }
  return true;
}

function compromised(message: string): LocalFileLockInspection {
  return { state: "compromised", message };
}

function error_code(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function describe_error(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function io_error(path: string, operation: string, error: unknown): LocalFileLockError {
  return new LocalFileLockError("io", path, `${operation} failed: ${describe_error(error)}`, error);
}
