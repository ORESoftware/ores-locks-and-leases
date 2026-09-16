import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { lstat, mkdir, open, opendir, rename, rmdir, unlink } from "node:fs/promises";

import {
  is_local_file_test_crash,
  local_file_test_fault_enabled,
  maybe_inject_local_file_test_fault,
  maybe_simulate_local_file_test_crash,
} from "./local-file-test-faults.js";

export const LOCAL_FILE_LOCK_OWNER_FILE = "owner";
export const LOCAL_FILE_LOCK_OWNER_PENDING_FILE = "owner.pending";
export const MAX_LOCAL_FILE_LOCK_OWNER_CODEPOINTS = 512;
export const MAX_LOCAL_FILE_LOCK_OWNER_UTF8_BYTES = MAX_LOCAL_FILE_LOCK_OWNER_CODEPOINTS * 4;
export const MAX_LOCAL_FILE_LOCK_TIMER_DELAY_MS = 2_147_483_647;

export type LocalFileLockErrorKind =
  | "contention"
  | "timeout"
  | "compromised"
  | "io"
  | "invalid_input";

export class LocalFileLockError extends Error {
  readonly kind: LocalFileLockErrorKind;
  readonly path: string;

  constructor(kind: LocalFileLockErrorKind, path: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "LocalFileLockError";
    this.kind = kind;
    this.path = path;
  }
}

export interface LocalFileLockOptions {
  wait?: boolean;
  /** End-to-end finite wait budget, including filesystem-call latency. */
  wait_timeout_ms?: number;
  retry_interval_ms?: number;
}

export const DEFAULT_LOCAL_FILE_LOCK_OPTIONS: Readonly<Required<LocalFileLockOptions>> = Object.freeze({
  wait: true,
  wait_timeout_ms: 30_000,
  retry_interval_ms: 50,
});

export function generated_local_file_lock_owner(): string {
  return `ores-locks-${randomUUID()}`;
}

type LocalFileLockReleaseState = "held" | "released" | "partial";
type LocalFileOwnerIdentity = Readonly<{
  dev: number;
  ino: number;
  birthtime_ms: number;
}>;
const LOCAL_FILE_LOCK_CONSTRUCTOR_TOKEN = Symbol("ores-local-file-lock-held-constructor");

export class LocalFileLock {
  readonly path: string;
  readonly owner: string;
  #release_state: LocalFileLockReleaseState = "held";
  #release_promise: Promise<void> | undefined;
  #partial_release_error: unknown | undefined;
  readonly #owner_identity: LocalFileOwnerIdentity;

  constructor(
    path: string,
    owner: string,
    ownerIdentity: LocalFileOwnerIdentity,
    token: typeof LOCAL_FILE_LOCK_CONSTRUCTOR_TOKEN,
  ) {
    if (token !== LOCAL_FILE_LOCK_CONSTRUCTOR_TOKEN) {
      throw new LocalFileLockError(
        "invalid_input",
        path,
        "LocalFileLock instances must be created by the acquisition API",
      );
    }
    this.path = path;
    this.owner = owner;
    this.#owner_identity = ownerIdentity;
  }

  get released(): boolean {
    return this.#release_state === "released";
  }

  get release_state(): LocalFileLockReleaseState {
    return this.#release_state;
  }

  async release(): Promise<void> {
    if (this.#release_state === "released") return;
    if (this.#release_state === "partial") throw this.#partial_release_error;
    if (this.#release_promise !== undefined) return this.#release_promise;

    const releasePromise = this.#release_once();
    this.#release_promise = releasePromise;
    try {
      await releasePromise;
    } finally {
      if (this.#release_promise === releasePromise && this.#release_state === "held") {
        this.#release_promise = undefined;
      }
    }
  }

  async #release_once(): Promise<void> {
    await validate_real_directory(this.path, this.path, "lock directory");
    await validate_posix_private_lock_directory(this.path, this.path);
    const entries = await read_local_file_lock_entry_names_bounded(this.path);
    if (entries.length !== 1 || entries[0] !== LOCAL_FILE_LOCK_OWNER_FILE) {
      throw new LocalFileLockError(
        "compromised",
        this.path,
        "lock directory must contain exactly one published owner marker before release",
      );
    }

    const ownerPath = join(this.path, LOCAL_FILE_LOCK_OWNER_FILE);
    await validate_regular_file(this.path, ownerPath, "owner token");
    const currentOwnerIdentity = await read_local_file_owner_identity(this.path, ownerPath);
    if (!same_local_file_owner_identity(this.#owner_identity, currentOwnerIdentity)) {
      throw new LocalFileLockError(
        "compromised",
        this.path,
        "owner marker identity changed; refusing stale-handle release across recovery/reacquisition",
      );
    }
    const observed = await read_bounded_local_file_lock_owner(this.path, ownerPath);
    if (observed !== this.owner) {
      throw new LocalFileLockError(
        "compromised",
        this.path,
        "owner token changed; refusing to remove a lock that may belong to another acquisition",
      );
    }

    let ownerRemoved = false;
    try {
      await unlink(ownerPath);
      ownerRemoved = true;
      maybe_inject_local_file_test_fault("release_rmdir_failure", "EIO");
      await rmdir(this.path);
    } catch (error) {
      const code = error_code(error);
      const wrapped = new LocalFileLockError(
        code === "ENOTEMPTY" || code === "EEXIST" ? "compromised" : "io",
        this.path,
        `remove local lock directory failed: ${describe_error(error)}`,
        error,
      );
      if (ownerRemoved) {
        this.#release_state = "partial";
        this.#partial_release_error = wrapped;
      }
      throw wrapped;
    }
    this.#release_state = "released";
  }
}

export async function try_acquire_local_file_lock(path: string, owner: string): Promise<LocalFileLock | null> {
  validate_local_file_lock_path(path);
  validate_local_file_lock_owner(path, owner);
  const parent = dirname(path);
  try {
    maybe_inject_local_file_test_fault("parent_prepare_ero_fs", "EROFS");
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await validate_real_directory(path, parent, "lock parent");
    await validate_posix_trusted_parent(path, parent);
  } catch (error) {
    if (error instanceof LocalFileLockError) throw error;
    throw io_error(path, "prepare local lock parent", error);
  }

  let created = false;
  for (let transitionAttempt = 0; transitionAttempt < 2; transitionAttempt += 1) {
    try {
      await mkdir(path, { mode: 0o700 });
      await validate_posix_private_lock_directory(path, path);
      created = true;
      break;
    } catch (error) {
      if (error instanceof LocalFileLockError) throw error;
      if (error_code(error) !== "EEXIST") {
        throw io_error(path, "atomically create local lock directory", error);
      }
      try {
        const metadata = await lstat(path);
        if (metadata.isDirectory() && !metadata.isSymbolicLink()) return null;
        throw new LocalFileLockError(
          "compromised",
          path,
          "lock path already exists but is not an unaliased directory",
          error,
        );
      } catch (inspectError) {
        if (inspectError instanceof LocalFileLockError) throw inspectError;
        if (error_code(inspectError) === "ENOENT") {
          if (transitionAttempt === 0) continue;
          return null;
        }
        throw io_error(path, "inspect contended local lock path", inspectError);
      }
    }
  }
  if (!created) return null;

  const ownerPath = join(path, LOCAL_FILE_LOCK_OWNER_FILE);
  const pendingPath = join(path, LOCAL_FILE_LOCK_OWNER_PENDING_FILE);
  let pendingHandle;
  try {
    pendingHandle = await open(pendingPath, "wx", 0o600);
    maybe_simulate_local_file_test_crash("after_pending_create_crash");
    if (local_file_test_fault_enabled("owner_short_write")) {
      const prefixLength = Math.max(1, Math.floor(owner.length / 2));
      await pendingHandle.writeFile(owner.slice(0, prefixLength), { encoding: "utf8" });
      maybe_inject_local_file_test_fault("owner_short_write", "EIO");
    } else {
      await pendingHandle.writeFile(owner, { encoding: "utf8" });
    }
    maybe_inject_local_file_test_fault("owner_sync_failure", "EIO");
    await pendingHandle.sync();
    await pendingHandle.close();
    pendingHandle = undefined;
    maybe_inject_local_file_test_fault("owner_close_failure", "EIO");
    maybe_simulate_local_file_test_crash("after_pending_sync_crash");

    try {
      await lstat(ownerPath);
      throw new LocalFileLockError(
        "compromised",
        path,
        "published owner target already exists before atomic publication",
      );
    } catch (targetError) {
      if (targetError instanceof LocalFileLockError) throw targetError;
      if (error_code(targetError) !== "ENOENT") {
        throw io_error(path, "inspect owner publication target", targetError);
      }
    }
    maybe_inject_local_file_test_fault("owner_rename_failure", "EIO");
    await rename(pendingPath, ownerPath);
    maybe_simulate_local_file_test_crash("after_owner_rename_crash");
  } catch (error) {
    if (is_local_file_test_crash(error)) throw error;
    try {
      await pendingHandle?.close();
    } catch {
      // Preserve the original publication failure.
    }
    let rollbackError: unknown;
    try {
      await unlink(pendingPath).catch((cleanupError) => {
        if (error_code(cleanupError) !== "ENOENT") throw cleanupError;
      });
      await unlink(ownerPath).catch((cleanupError) => {
        if (error_code(cleanupError) !== "ENOENT") throw cleanupError;
      });
      maybe_inject_local_file_test_fault("rollback_rmdir_failure", "EIO");
      await rmdir(path);
    } catch (cleanupError) {
      rollbackError = cleanupError;
    }
    if (rollbackError !== undefined) {
      throw new LocalFileLockError(
        "compromised",
        path,
        `owner publication failed: ${describe_error(error)}; provisional lock rollback also failed: ${describe_error(rollbackError)}`,
        { primary_error: error, rollback_error: rollbackError },
      );
    }
    if (error instanceof LocalFileLockError) throw error;
    if (error_code(error) === "EEXIST") {
      throw new LocalFileLockError(
        "compromised",
        path,
        "owner publication marker already exists after winning lock directory creation",
        error,
      );
    }
    throw io_error(path, "publish local lock owner token", error);
  }

  let ownerIdentity: LocalFileOwnerIdentity;
  try {
    await validate_regular_file(path, ownerPath, "owner token");
    ownerIdentity = await read_local_file_owner_identity(path, ownerPath);
  } catch (error) {
    let rollbackError: unknown;
    try {
      await unlink(ownerPath);
      await rmdir(path);
    } catch (cleanupError) {
      rollbackError = cleanupError;
    }
    if (rollbackError !== undefined) {
      throw new LocalFileLockError(
        "compromised",
        path,
        `owner token was published but validation failed and rollback also failed: ${describe_error(rollbackError)}`,
        rollbackError,
      );
    }
    throw error;
  }

  return new LocalFileLock(path, owner, ownerIdentity, LOCAL_FILE_LOCK_CONSTRUCTOR_TOKEN);
}

export async function acquire_local_file_lock(
  path: string,
  owner: string,
  options: LocalFileLockOptions = {},
): Promise<LocalFileLock> {
  validate_local_file_lock_path(path);
  validate_local_file_lock_owner(path, owner);
  const resolved = { ...DEFAULT_LOCAL_FILE_LOCK_OPTIONS, ...options };
  validate_options(path, resolved);
  const started = performance.now();

  for (;;) {
    const lock = await try_acquire_local_file_lock(path, owner);
    if (lock !== null) return lock;
    if (!resolved.wait) {
      throw new LocalFileLockError("contention", path, "lock is already held by another owner");
    }
    const elapsed = performance.now() - started;
    if (elapsed >= resolved.wait_timeout_ms) {
      throw new LocalFileLockError(
        "timeout",
        path,
        `timed out after ${resolved.wait_timeout_ms} ms waiting for local lock`,
      );
    }
    await sleep(local_file_lock_sleep_delay_ms(
      resolved.retry_interval_ms,
      resolved.wait_timeout_ms - elapsed,
    ));
  }
}

export async function local_file_lock_exists(path: string): Promise<boolean> {
  validate_local_file_lock_path(path);
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error_code(error) === "ENOENT") return false;
    throw io_error(path, "inspect local lock path", error);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new LocalFileLockError("compromised", path, "lock path exists but is not an unaliased directory");
  }
  validate_posix_private_mode(path, metadata.mode, "lock directory");
  const entries = await read_local_file_lock_entry_names_bounded(path);
  if (entries.length !== 1 || entries[0] !== LOCAL_FILE_LOCK_OWNER_FILE) {
    throw new LocalFileLockError(
      "compromised",
      path,
      "lock directory must contain exactly one published owner marker",
    );
  }
  const ownerPath = join(path, LOCAL_FILE_LOCK_OWNER_FILE);
  await validate_regular_file(path, ownerPath, "owner token");
  const owner = await read_bounded_local_file_lock_owner(path, ownerPath);
  if (owner.length === 0 || Array.from(owner).length > MAX_LOCAL_FILE_LOCK_OWNER_CODEPOINTS) {
    throw new LocalFileLockError("compromised", path, "owner token violates the portable owner contract");
  }
  return true;
}

export async function read_local_file_lock_entry_names_bounded(path: string): Promise<string[]> {
  let directory;
  try {
    directory = await opendir(path);
    const first = await directory.read();
    if (first === null) return [];
    const second = await directory.read();
    if (second === null) return [first.name];
    return [first.name, second.name];
  } catch (error) {
    if (error instanceof LocalFileLockError) throw error;
    throw io_error(path, "list local lock directory", error);
  } finally {
    await directory?.close();
  }
}

async function read_local_file_owner_identity(
  lockPath: string,
  ownerPath: string,
): Promise<LocalFileOwnerIdentity> {
  let metadata;
  try {
    metadata = await lstat(ownerPath);
  } catch (error) {
    throw io_error(lockPath, "inspect local lock owner identity", error);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new LocalFileLockError(
      "compromised",
      lockPath,
      "owner marker identity is not a single-link unaliased regular file",
    );
  }
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    birthtime_ms: metadata.birthtimeMs,
  };
}

function same_local_file_owner_identity(
  left: LocalFileOwnerIdentity,
  right: LocalFileOwnerIdentity,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.birthtime_ms === right.birthtime_ms;
}

export async function read_bounded_local_file_lock_owner(lockPath: string, ownerPath: string): Promise<string> {
  let handle;
  try {
    maybe_inject_local_file_test_fault("owner_read_permission", "EACCES");
    const pathMetadata = await lstat(ownerPath);
    if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) {
      throw new LocalFileLockError("compromised", lockPath, "owner token is not an unaliased regular file");
    }
    if (pathMetadata.nlink !== 1) {
      throw new LocalFileLockError(
        "compromised",
        lockPath,
        "owner token has multiple filesystem links; refusing aliased ownership state",
      );
    }
    validate_posix_private_mode(lockPath, pathMetadata.mode, "owner token");
    if (pathMetadata.size > MAX_LOCAL_FILE_LOCK_OWNER_UTF8_BYTES) {
      throw new LocalFileLockError(
        "compromised",
        lockPath,
        `owner token exceeds the portable ${MAX_LOCAL_FILE_LOCK_OWNER_UTF8_BYTES}-byte UTF-8 storage bound`,
      );
    }

    handle = await open(ownerPath, "r");
    const openedMetadata = await handle.stat();
    if (
      !openedMetadata.isFile() ||
      openedMetadata.isSymbolicLink() ||
      openedMetadata.nlink !== 1 ||
      openedMetadata.dev !== pathMetadata.dev ||
      openedMetadata.ino !== pathMetadata.ino
    ) {
      throw new LocalFileLockError(
        "compromised",
        lockPath,
        "owner token identity changed or became multiply linked while opening; refusing raced path-to-handle state",
      );
    }
    validate_posix_private_mode(lockPath, openedMetadata.mode, "opened owner token");
    if (openedMetadata.size > MAX_LOCAL_FILE_LOCK_OWNER_UTF8_BYTES) {
      throw new LocalFileLockError(
        "compromised",
        lockPath,
        `owner token exceeds the portable ${MAX_LOCAL_FILE_LOCK_OWNER_UTF8_BYTES}-byte UTF-8 storage bound`,
      );
    }

    const buffer = new Uint8Array(MAX_LOCAL_FILE_LOCK_OWNER_UTF8_BYTES + 1);
    let totalBytesRead = 0;
    while (totalBytesRead < buffer.byteLength) {
      const { bytesRead } = await handle.read(
        buffer,
        totalBytesRead,
        buffer.byteLength - totalBytesRead,
        totalBytesRead,
      );
      if (bytesRead === 0) break;
      totalBytesRead += bytesRead;
    }
    if (totalBytesRead > MAX_LOCAL_FILE_LOCK_OWNER_UTF8_BYTES) {
      throw new LocalFileLockError(
        "compromised",
        lockPath,
        `owner token exceeds the portable ${MAX_LOCAL_FILE_LOCK_OWNER_UTF8_BYTES}-byte UTF-8 storage bound`,
      );
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, totalBytesRead));
    } catch (error) {
      throw new LocalFileLockError("compromised", lockPath, "owner token is not valid UTF-8", error);
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

export function local_file_lock_sleep_delay_ms(retryIntervalMs: number, remainingMs: number): number {
  return Math.max(0, Math.min(retryIntervalMs, remainingMs, MAX_LOCAL_FILE_LOCK_TIMER_DELAY_MS));
}

export function validate_local_file_lock_path(path: string): void {
  if (path.length === 0) {
    throw new LocalFileLockError("invalid_input", path, "local lock path must not be empty");
  }
  if (path.includes("\0")) {
    throw new LocalFileLockError("invalid_input", path, "local lock path must not contain NUL");
  }
  if (has_lone_surrogate(path)) {
    throw new LocalFileLockError(
      "invalid_input",
      path,
      "local lock path must contain only valid Unicode scalar values",
    );
  }
  if (process.platform === "win32" && !windows_local_file_lock_path_admitted(path)) {
    throw new LocalFileLockError(
      "invalid_input",
      path,
      "Windows local lock paths must avoid device namespaces, reserved device names, trailing dot/space components, and alternate-data-stream syntax",
    );
  }
}

function windows_local_file_lock_path_admitted(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  const lower = normalized.toLowerCase();
  if (lower.startsWith("//?/") || lower.startsWith("//./") || lower.startsWith("/??/")) return false;

  let first = true;
  for (const component of normalized.split("/")) {
    if (component.length === 0) continue;
    if (component === "." || component === "..") continue;
    if (first && /^[A-Za-z]:$/.test(component)) {
      first = false;
      continue;
    }
    first = false;
    if (component.endsWith(".") || component.endsWith(" ") || component.includes(":")) return false;
    const base = component.split(".", 1)[0]!.trim().toUpperCase();
    if (WINDOWS_RESERVED_DEVICE_BASES.has(base)) return false;
  }
  return true;
}

const WINDOWS_RESERVED_DEVICE_BASES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

export function validate_local_file_lock_owner(path: string, owner: string): void {
  if (owner.length === 0) {
    throw new LocalFileLockError("invalid_input", path, "owner token must not be empty");
  }
  if (has_lone_surrogate(owner)) {
    throw new LocalFileLockError(
      "invalid_input",
      path,
      "owner token must contain only valid Unicode scalar values",
    );
  }
  if (Array.from(owner).length > MAX_LOCAL_FILE_LOCK_OWNER_CODEPOINTS) {
    throw new LocalFileLockError(
      "invalid_input",
      path,
      `owner token must not exceed ${MAX_LOCAL_FILE_LOCK_OWNER_CODEPOINTS} Unicode code points`,
    );
  }
}

function has_lone_surrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function validate_options(path: string, options: Required<LocalFileLockOptions>): void {
  if (!Number.isSafeInteger(options.wait_timeout_ms) || options.wait_timeout_ms < 0) {
    throw new LocalFileLockError(
      "invalid_input",
      path,
      "wait timeout must be a non-negative JavaScript safe integer number of milliseconds",
    );
  }
  if (!Number.isSafeInteger(options.retry_interval_ms) || options.retry_interval_ms < 0) {
    throw new LocalFileLockError(
      "invalid_input",
      path,
      "retry interval must be a non-negative JavaScript safe integer number of milliseconds",
    );
  }
  if (options.wait && options.retry_interval_ms === 0) {
    throw new LocalFileLockError(
      "invalid_input",
      path,
      "retry interval must be greater than zero when waiting",
    );
  }
}

async function validate_real_directory(lockPath: string, path: string, label: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) return;
    throw new LocalFileLockError("compromised", lockPath, `${label} is not an unaliased directory`);
  } catch (error) {
    if (error instanceof LocalFileLockError) throw error;
    if (error_code(error) === "ENOENT") {
      throw new LocalFileLockError("compromised", lockPath, `${label} is missing`, error);
    }
    throw io_error(lockPath, `inspect ${label}`, error);
  }
}

async function validate_posix_trusted_parent(lockPath: string, path: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const metadata = await lstat(path);
    if ((metadata.mode & 0o022) !== 0) {
      throw new LocalFileLockError(
        "compromised",
        lockPath,
        "lock parent is group/world writable and is outside the trusted private-root boundary",
      );
    }
  } catch (error) {
    if (error instanceof LocalFileLockError) throw error;
    throw io_error(lockPath, "inspect POSIX lock-parent permissions", error);
  }
}

async function validate_posix_private_lock_directory(lockPath: string, path: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const metadata = await lstat(path);
    validate_posix_private_mode(lockPath, metadata.mode, "lock directory");
  } catch (error) {
    if (error instanceof LocalFileLockError) throw error;
    throw io_error(lockPath, "inspect POSIX lock-directory permissions", error);
  }
}

function validate_posix_private_mode(lockPath: string, mode: number, label: string): void {
  if (process.platform === "win32") return;
  if ((mode & 0o077) !== 0) {
    throw new LocalFileLockError(
      "compromised",
      lockPath,
      `${label} permissions widened beyond the private POSIX contract`,
    );
  }
}

async function validate_regular_file(lockPath: string, path: string, label: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1) {
      validate_posix_private_mode(lockPath, metadata.mode, label);
      return;
    }
    const detail = metadata.isFile() && metadata.nlink !== 1
      ? `${label} has multiple filesystem links`
      : `${label} is not an unaliased regular file`;
    throw new LocalFileLockError("compromised", lockPath, detail);
  } catch (error) {
    if (error instanceof LocalFileLockError) throw error;
    if (error_code(error) === "ENOENT") {
      throw new LocalFileLockError("compromised", lockPath, `${label} is missing`, error);
    }
    throw io_error(lockPath, `inspect ${label}`, error);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
