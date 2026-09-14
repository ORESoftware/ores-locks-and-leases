import {
  LocalFileLock,
  acquire_local_file_lock,
  type LocalFileLockOptions,
} from "./local-file.js";

export type ScopedLocalFileLockErrorKind = "lock" | "work" | "work_and_release";

/** Structured outcome preserving work and cleanup failures independently. */
export class ScopedLocalFileLockError extends Error {
  readonly kind: ScopedLocalFileLockErrorKind;
  readonly lock_error: unknown | undefined;
  readonly work_error: unknown | undefined;

  constructor(
    kind: ScopedLocalFileLockErrorKind,
    message: string,
    options: { lock_error?: unknown; work_error?: unknown } = {},
  ) {
    super(message);
    this.name = "ScopedLocalFileLockError";
    this.kind = kind;
    this.lock_error = options.lock_error;
    this.work_error = options.work_error;
  }
}

/**
 * Acquire, run one callback, and release exactly once.
 *
 * Expected callback failures may be any thrown value. Fatal process aborts are
 * outside this structured contract. When work and release both fail, neither
 * failure is discarded.
 */
export async function with_local_file_lock<T>(
  path: string,
  owner: string,
  options: LocalFileLockOptions,
  work: (lock: LocalFileLock) => T | Promise<T>,
): Promise<T> {
  let lock: LocalFileLock;
  try {
    lock = await acquire_local_file_lock(path, owner, options);
  } catch (lock_error) {
    throw new ScopedLocalFileLockError("lock", "local lock acquisition failed", { lock_error });
  }

  let value: T | undefined;
  let work_error: unknown | undefined;
  try {
    value = await work(lock);
  } catch (error) {
    work_error = error;
  }

  let lock_error: unknown | undefined;
  try {
    await lock.release();
  } catch (error) {
    lock_error = error;
  }

  if (work_error !== undefined && lock_error !== undefined) {
    throw new ScopedLocalFileLockError(
      "work_and_release",
      "local lock work and release both failed",
      { work_error, lock_error },
    );
  }
  if (work_error !== undefined) {
    throw new ScopedLocalFileLockError("work", "local lock work failed", { work_error });
  }
  if (lock_error !== undefined) {
    throw new ScopedLocalFileLockError("lock", "local lock release failed", { lock_error });
  }

  return value as T;
}
