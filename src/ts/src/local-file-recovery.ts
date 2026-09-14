import { lstat, open, readdir, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  LocalFileLockError,
  MAX_LOCAL_FILE_LOCK_OWNER_CODEPOINTS,
} from "./local-file.js";

const OWNER_FILE = "owner";
export const MAX_LOCAL_FILE_LOCK_OWNER_UTF8_BYTES = 2048;

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
  let ownerMetadata;
  try {
    ownerMetadata = await lstat(ownerPath);
    if (!ownerMetadata.isFile() || ownerMetadata.isSymbolicLink()) {
      return compromised("owner token is not an unaliased regular file");
    }
  } catch (error) {
    if (error_code(error) === "ENOENT") return compromised("owner token is missing");
    throw io_error(path, "inspect local lock owner token", error);
  }
  if (ownerMetadata.size > MAX_LOCAL_FILE_LOCK_OWNER_UTF8_BYTES) {
    return compromised("owner token exceeds the portable 2048-byte UTF-8 storage bound");
  }

  const owner = await read_bounded_utf8_owner(path, ownerPath);
  if (owner.length === 0) return compromised("owner token is empty");
  if (Array.from(owner).length > MAX_LOCAL_FILE_LOCK_OWNER_CODEPOINTS) {
    return compromised("owner token exceeds the portable 512-code-point contract bound");
  }
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
  if (Array.from(expected_owner).length > MAX_LOCAL_FILE_LOCK_OWNER_CODEPOINTS) {
    throw new LocalFileLockError(
      "invalid_input",
      path,
      `expected owner must not exceed ${MAX_LOCAL_FILE_LOCK_OWNER_CODEPOINTS} Unicode code points`,
    );
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

async function read_bounded_utf8_owner(lockPath: string, ownerPath: string): Promise<string> {
  let handle;
  try {
    handle = await open(ownerPath, "r");
    const buffer = new Uint8Array(MAX_LOCAL_FILE_LOCK_OWNER_UTF8_BYTES + 1);
    const { bytesRead } = await handle.read(
      buffer,
      0,
      buffer.byteLength,
      0,
    );
    if (bytesRead > MAX_LOCAL_FILE_LOCK_OWNER_UTF8_BYTES) {
      throw new LocalFileLockError(
        "compromised",
        lockPath,
        "owner token exceeds the portable 2048-byte UTF-8 storage bound",
      );
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
    } catch (error) {
      throw new LocalFileLockError(
        "compromised",
        lockPath,
        "owner token is not valid UTF-8",
        error,
      );
    }
  } catch (error) {
    if (error instanceof LocalFileLockError) throw error;
    if (error_code(error) === "ENOENT") {
      throw new LocalFileLockError("compromised", lockPath, "owner token is missing", error);
    }
    throw io_error(lockPath, "read local lock owner token", error);
  } finally {
    await handle?.close();
  }
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
