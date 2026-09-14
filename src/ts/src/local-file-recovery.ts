import { lstat, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  LOCAL_FILE_LOCK_OWNER_FILE,
  LocalFileLockError,
  MAX_LOCAL_FILE_LOCK_OWNER_CODEPOINTS,
  MAX_LOCAL_FILE_LOCK_OWNER_UTF8_BYTES,
  read_bounded_local_file_lock_owner,
  read_local_file_lock_entry_names_bounded,
  validate_local_file_lock_owner,
  validate_local_file_lock_path,
} from "./local-file.js";

export { MAX_LOCAL_FILE_LOCK_OWNER_UTF8_BYTES } from "./local-file.js";

export type LocalFileLockInspectionState = "absent" | "held" | "incomplete" | "compromised";

export type LocalFileLockInspectionReason =
  | "owner_marker_missing"
  | "path_not_directory"
  | "dirty_directory"
  | "owner_not_regular_file"
  | "owner_too_large"
  | "owner_invalid_utf8"
  | "owner_identity_changed"
  | "permissions_widened"
  | "owner_contract_violation";

export type LocalFileLockInspection =
  | { state: "absent" }
  | { state: "held"; owner: string }
  | {
      state: "incomplete";
      reason: "owner_marker_missing";
      message: string;
    }
  | {
      state: "compromised";
      reason: LocalFileLockInspectionReason;
      message: string;
    };

/** Read-only inspection. This never acquires, repairs, or removes a lock. */
export async function inspect_local_file_lock(path: string): Promise<LocalFileLockInspection> {
  validate_local_file_lock_path(path);
  let lockMetadata;
  try {
    lockMetadata = await lstat(path);
  } catch (error) {
    if (error_code(error) === "ENOENT") return { state: "absent" };
    throw io_error(path, "inspect local lock path", error);
  }
  if (!lockMetadata.isDirectory() || lockMetadata.isSymbolicLink()) {
    return compromised("path_not_directory", "lock path is not an unaliased directory");
  }
  if (process.platform !== "win32" && (lockMetadata.mode & 0o077) !== 0) {
    return compromised(
      "permissions_widened",
      "lock directory permissions widened beyond the private POSIX contract",
    );
  }

  const entries = await read_local_file_lock_entry_names_bounded(path);
  if (entries.length === 0) {
    return incomplete(
      "lock directory has no owner marker; acquisition or release may have crashed mid-transition",
    );
  }
  if (entries.length !== 1 || entries[0] !== LOCAL_FILE_LOCK_OWNER_FILE) {
    return compromised("dirty_directory", "lock directory must contain exactly one owner marker");
  }

  const ownerPath = join(path, LOCAL_FILE_LOCK_OWNER_FILE);
  let ownerMetadata;
  try {
    ownerMetadata = await lstat(ownerPath);
    if (!ownerMetadata.isFile() || ownerMetadata.isSymbolicLink()) {
      return compromised("owner_not_regular_file", "owner token is not an unaliased regular file");
    }
  } catch (error) {
    if (error_code(error) === "ENOENT") return incomplete("owner token disappeared during inspection");
    throw io_error(path, "inspect local lock owner token", error);
  }
  if (process.platform !== "win32" && (ownerMetadata.mode & 0o077) !== 0) {
    return compromised(
      "permissions_widened",
      "owner token permissions widened beyond the private POSIX contract",
    );
  }
  if (ownerMetadata.size > MAX_LOCAL_FILE_LOCK_OWNER_UTF8_BYTES) {
    return compromised(
      "owner_too_large",
      `owner token exceeds the portable ${MAX_LOCAL_FILE_LOCK_OWNER_UTF8_BYTES}-byte UTF-8 storage bound`,
    );
  }

  let owner: string;
  try {
    owner = await read_bounded_local_file_lock_owner(path, ownerPath);
  } catch (error) {
    if (error instanceof LocalFileLockError && error.kind === "compromised") {
      if (error.message.includes("owner token is missing")) {
        return incomplete("owner token disappeared during inspection");
      }
      return compromised(classify_bounded_owner_error(error), error.message);
    }
    throw error;
  }
  if (owner.length === 0) {
    return compromised("owner_contract_violation", "owner token is empty");
  }
  if (Array.from(owner).length > MAX_LOCAL_FILE_LOCK_OWNER_CODEPOINTS) {
    return compromised(
      "owner_contract_violation",
      "owner token exceeds the portable 512-code-point contract bound",
    );
  }
  return { state: "held", owner };
}

/**
 * Explicit operator-driven recovery. `confirmed_inactive` asserts that the
 * caller independently established the previous owner is inactive and the
 * protected local state is quiescent. Missing locks are idempotent no-ops.
 * Ownerless incomplete crash-window state is intentionally never auto-recovered
 * because it has no owner identity to authenticate against.
 */
export async function recover_local_file_lock(
  path: string,
  expected_owner: string,
  confirmed_inactive: boolean,
): Promise<boolean> {
  validate_local_file_lock_path(path);
  validate_local_file_lock_owner(path, expected_owner);
  if (!confirmed_inactive) {
    throw new LocalFileLockError(
      "invalid_input",
      path,
      "explicit confirmed_inactive=true is required for recovery",
    );
  }

  const inspection = await inspect_local_file_lock(path);
  if (inspection.state === "absent") return false;
  if (inspection.state === "incomplete") {
    throw new LocalFileLockError(
      "compromised",
      path,
      "incomplete lock state has no owner identity; refusing automatic recovery",
    );
  }
  if (inspection.state === "compromised") {
    throw new LocalFileLockError("compromised", path, inspection.message);
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
    await unlink(join(path, LOCAL_FILE_LOCK_OWNER_FILE));
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

function incomplete(message: string): LocalFileLockInspection {
  return { state: "incomplete", reason: "owner_marker_missing", message };
}

function compromised(
  reason: LocalFileLockInspectionReason,
  message: string,
): LocalFileLockInspection {
  return { state: "compromised", reason, message };
}

function classify_bounded_owner_error(error: LocalFileLockError): LocalFileLockInspectionReason {
  if (error.message.includes("valid UTF-8")) return "owner_invalid_utf8";
  if (error.message.includes("identity changed")) return "owner_identity_changed";
  if (error.message.includes("permissions widened")) return "permissions_widened";
  if (error.message.includes("exceeds the portable") && error.message.includes("byte")) {
    return "owner_too_large";
  }
  if (error.message.includes("regular file")) return "owner_not_regular_file";
  return "owner_contract_violation";
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
