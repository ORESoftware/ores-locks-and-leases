import { lstat, mkdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

const OWNER_FILE = "owner";
export const MAX_LOCAL_FILE_LOCK_OWNER_CODEPOINTS = 512;

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
  /** When false, acquisition is one immediate attempt. */
  wait?: boolean;
  /** Finite wait budget. Defaults to 30 seconds. */
  wait_timeout_ms?: number;
  /** Delay between portable mkdir attempts. Defaults to 50 ms. */
  retry_interval_ms?: number;
}

export const DEFAULT_LOCAL_FILE_LOCK_OPTIONS: Required<LocalFileLockOptions> = {
  wait: true,
  wait_timeout_ms: 30_000,
  retry_interval_ms: 50,
};

/**
 * Held portable single-host filesystem lock.
 *
 * Atomic directory creation is the admission authority. The owner file is an
 * owner-safe release token and diagnostics; it is never a stale PID authority.
 */
export class LocalFileLock {
  readonly path: string;
  readonly owner: string;
  #released = false;

  constructor(path: string, owner: string) {
    this.path = path;
    this.owner = owner;
  }

  get released(): boolean {
    return this.#released;
  }

  async release(): Promise<void> {
    if (this.#released) return;

    await validate_real_directory(this.path, this.path, "lock directory");
    const owner_path = join(this.path, OWNER_FILE);
    await validate_regular_file(this.path, owner_path, "owner token");

    let observed: string;
    try {
      observed = await readFile(owner_path, "utf8");
    } catch (error) {
      if (error_code(error) === "ENOENT") {
        throw new LocalFileLockError(
          "compromised",
          this.path,
          "owner token is missing; refusing to treat externally altered lock state as a successful release",
          error,
        );
      }
      throw io_error(this.path, "read local lock owner token", error);
    }
    if (observed !== this.owner) {
      throw new LocalFileLockError(
        "compromised",
        this.path,
        "owner token changed; refusing to remove a lock that may belong to another acquisition",
      );
    }

    try {
      await unlink(owner_path);
      await rmdir(this.path);
    } catch (error) {
      const code = error_code(error);
      throw new LocalFileLockError(
        code === "ENOTEMPTY" || code === "EEXIST" ? "compromised" : "io",
        this.path,
        `remove local lock directory failed: ${describe_error(error)}`,
        error,
      );
    }
    this.#released = true;
  }
}

/** One immediate atomic attempt. `null` means ordinary contention. */
export async function try_acquire_local_file_lock(
  path: string,
  owner: string,
): Promise<LocalFileLock | null> {
  validate_owner(path, owner);
  const parent = dirname(path);
  try {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await validate_real_directory(path, parent, "lock parent");
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error instanceof LocalFileLockError) throw error;
    if (error_code(error) === "EEXIST") {
      try {
        const metadata = await lstat(path);
        if (metadata.isDirectory() && !metadata.isSymbolicLink()) return null;
      } catch (inspectError) {
        throw io_error(path, "inspect contended local lock path", inspectError);
      }
      throw new LocalFileLockError(
        "compromised",
        path,
        "lock path already exists but is not an unaliased directory",
        error,
      );
    }
    throw io_error(path, "atomically create local lock directory", error);
  }

  const owner_path = join(path, OWNER_FILE);
  try {
    await writeFile(owner_path, owner, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    try {
      await rmdir(path);
    } catch {
      // Leave the failed lock directory visible and fail closed if cleanup
      // itself cannot be completed.
    }
    if (error_code(error) === "EEXIST") {
      throw new LocalFileLockError(
        "compromised",
        path,
        "owner token already exists after winning lock directory creation",
        error,
      );
    }
    throw io_error(path, "write local lock owner token", error);
  }

  return new LocalFileLock(path, owner);
}

/** Acquire with optional finite waiting. */
export async function acquire_local_file_lock(
  path: string,
  owner: string,
  options: LocalFileLockOptions = {},
): Promise<LocalFileLock> {
  validate_owner(path, owner);
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

    await sleep(Math.min(resolved.retry_interval_ms, resolved.wait_timeout_ms - elapsed));
  }
}

/** Diagnostics only; callers still must acquire before treating themselves as owner. */
export async function local_file_lock_exists(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) return true;
    throw new LocalFileLockError(
      "compromised",
      path,
      "lock path exists but is not an unaliased directory",
    );
  } catch (error) {
    if (error instanceof LocalFileLockError) throw error;
    if (error_code(error) === "ENOENT") return false;
    throw io_error(path, "inspect local lock path", error);
  }
}

function validate_owner(path: string, owner: string): void {
  if (owner.length === 0) {
    throw new LocalFileLockError("invalid_input", path, "owner token must not be empty");
  }
  if (Array.from(owner).length > MAX_LOCAL_FILE_LOCK_OWNER_CODEPOINTS) {
    throw new LocalFileLockError(
      "invalid_input",
      path,
      `owner token must not exceed ${MAX_LOCAL_FILE_LOCK_OWNER_CODEPOINTS} Unicode code points`,
    );
  }
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

async function validate_real_directory(lock_path: string, path: string, label: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) return;
    throw new LocalFileLockError(
      "compromised",
      lock_path,
      `${label} is not an unaliased directory`,
    );
  } catch (error) {
    if (error instanceof LocalFileLockError) throw error;
    if (error_code(error) === "ENOENT") {
      throw new LocalFileLockError("compromised", lock_path, `${label} is missing`, error);
    }
    throw io_error(lock_path, `inspect ${label}`, error);
  }
}

async function validate_regular_file(lock_path: string, path: string, label: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (metadata.isFile() && !metadata.isSymbolicLink()) return;
    throw new LocalFileLockError(
      "compromised",
      lock_path,
      `${label} is not an unaliased regular file`,
    );
  } catch (error) {
    if (error instanceof LocalFileLockError) throw error;
    if (error_code(error) === "ENOENT") {
      throw new LocalFileLockError("compromised", lock_path, `${label} is missing`, error);
    }
    throw io_error(lock_path, `inspect ${label}`, error);
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
