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

type InspectionOwnerRead =
  | { state: "owner"; owner: string }
  | { state: "absent" }
  | { state: "incomplete" };

/** Read-only inspection. This never acquires, repairs, or removes a lock. */
export async function inspect_local_file_lock(path: string): Promise<LocalFileLockInspection> {
  validate_local_file_lock_path(path);
  const lockMetadata = await lstat_inspection_lock_path(path);
  if (lockMetadata === null) return { state: "absent" };
  if (!lockMetadata.isDirectory() || lockMetadata.isSymbolicLink()) {
    return compromised("path_not_directory", "lock path is not an unaliased directory");
  }
  if (process.platform !== "win32" && (lockMetadata.mode & 0o077) !== 0) {
    return compromised(
      "permissions_widened",
      "lock directory permissions widened beyond the private POSIX contract",
    );
  }

  const entries = await read_inspection_entry_names(path);
  if (entries === null) return { state: "absent" };
  if (entries.length === 0) {
    return incomplete(
      "lock directory has no owner marker; acquisition or release may have crashed mid-transition",
    );
  }
  if (entries.length !== 1 || entries[0] !== LOCAL_FILE_LOCK_OWNER_FILE) {
    return compromised("dirty_directory", "lock directory must contain exactly one owner marker");
  }

  const ownerPath = join(path, LOCAL_FILE_LOCK_OWNER_FILE);
  let ownerRead: InspectionOwnerRead;
  try {
    ownerRead = await read_inspection_owner(path, ownerPath);
  } catch (error) {
    if (error instanceof LocalFileLockError && error.kind === "compromised") {
      return compromised(classify_bounded_owner_error(error), error.message);
    }
    throw error;
  }
  if (ownerRead.state === "absent") return { state: "absent" };
  if (ownerRead.state === "incomplete") {
    return incomplete("owner token disappeared during inspection");
  }

  const owner = ownerRead.owner;
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

/**
 * Initial path metadata can itself observe Windows deletion-pending EPERM.
 * Retry only that transient condition, bounded to a few milliseconds. A path
 * that disappears linearizes as absent; persistent denial remains an IO error.
 */
async function lstat_inspection_lock_path(path: string) {
  const maxAttempts = process.platform === "win32" ? 4 : 1;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await lstat(path);
    } catch (error) {
      lastError = error;
      if (error_code(error) === "ENOENT") return null;
      if (process.platform !== "win32" || error_code(error) !== "EPERM") {
        throw io_error(path, "inspect local lock path", error);
      }
      if (attempt + 1 < maxAttempts) {
        await sleep_ms(1);
        continue;
      }
    }
  }

  throw io_error(path, "inspect local lock path", lastError);
}

/**
 * Read the bounded directory shape while tolerating only the two OS-level
 * disappearance signals produced by a concurrent clean release.
 *
 * POSIX typically reports ENOENT when rmdir wins between lstat and opendir.
 * Windows can transiently report EPERM while the directory is deletion-pending.
 * For Windows EPERM we perform a tiny bounded retry: disappearance linearizes
 * as `absent`; a persistent EPERM on an extant path remains a genuine IO error.
 */
async function read_inspection_entry_names(path: string): Promise<string[] | null> {
  const maxAttempts = process.platform === "win32" ? 4 : 1;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await read_local_file_lock_entry_names_bounded(path);
    } catch (error) {
      lastError = error;
      if (!(error instanceof LocalFileLockError) || error.kind !== "io") throw error;
      if (caused_by_error_code(error, "ENOENT")) return null;

      if (process.platform !== "win32" || !caused_by_error_code(error, "EPERM")) {
        throw error;
      }

      try {
        await lstat(path);
      } catch (probeError) {
        if (error_code(probeError) === "ENOENT") return null;
        if (error_code(probeError) !== "EPERM") {
          throw io_error(path, "recheck Windows deletion-pending local lock path", probeError);
        }
      }

      if (attempt + 1 < maxAttempts) {
        await sleep_ms(1);
        continue;
      }
    }
  }

  throw lastError;
}

/**
 * Read the owner marker for diagnostics while preserving fail-closed release
 * behavior. Windows may report EPERM when a clean concurrent release has
 * already put the owner/directory into deletion-pending state. Inspection may
 * linearize that bounded race as absent/incomplete, but persistent EPERM on an
 * extant lock remains an IO error and is never converted to healthy state.
 */
async function read_inspection_owner(
  path: string,
  ownerPath: string,
): Promise<InspectionOwnerRead> {
  const maxAttempts = process.platform === "win32" ? 4 : 1;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return { state: "owner", owner: await read_bounded_local_file_lock_owner(path, ownerPath) };
    } catch (error) {
      lastError = error;

      if (error instanceof LocalFileLockError && error.kind === "compromised") {
        if (error.message.includes("owner token is missing")) {
          try {
            await lstat(path);
            return { state: "incomplete" };
          } catch (probeError) {
            if (error_code(probeError) === "ENOENT") return { state: "absent" };
            if (
              process.platform === "win32" &&
              error_code(probeError) === "EPERM" &&
              attempt + 1 < maxAttempts
            ) {
              await sleep_ms(1);
              continue;
            }
            throw io_error(path, "recheck local lock after owner disappearance", probeError);
          }
        }
        throw error;
      }

      if (
        !(error instanceof LocalFileLockError) ||
        error.kind !== "io" ||
        process.platform !== "win32" ||
        !caused_by_error_code(error, "EPERM")
      ) {
        throw error;
      }

      try {
        await lstat(path);
      } catch (probeError) {
        if (error_code(probeError) === "ENOENT") return { state: "absent" };
        if (error_code(probeError) !== "EPERM") {
          throw io_error(path, "recheck Windows deletion-pending local lock path", probeError);
        }
      }

      if (attempt + 1 < maxAttempts) {
        await sleep_ms(1);
        continue;
      }
    }
  }

  throw lastError;
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
  if (error.message.includes("multiple filesystem links") || error.message.includes("multiply linked")) {
    return "owner_identity_changed";
  }
  if (error.message.includes("exceeds the portable") && error.message.includes("byte")) {
    return "owner_too_large";
  }
  if (error.message.includes("regular file")) return "owner_not_regular_file";
  return "owner_contract_violation";
}

function sleep_ms(delay: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function caused_by_error_code(error: Error, code: string): boolean {
  if (!("cause" in error)) return false;
  return error_code((error as Error & { cause?: unknown }).cause) === code;
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
