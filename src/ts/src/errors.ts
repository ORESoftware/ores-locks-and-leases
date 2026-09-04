import type { LockKey } from "./key.js";
import type { LockStep } from "./plan.js";

/** Why an acquisition or guarded run failed. The contract's `LockErrorKind`. */
export type LockErrorKind =
  /** A layer is held by someone else and `wait` was false. */
  | "contention"
  /** The wait budget elapsed before every layer was held. */
  | "timeout"
  /** The fiducia lease could not be renewed or was reaped; fenced authority is gone. */
  | "lost_lease"
  /** Transport/HTTP failure talking to the lease authority; ownership is unknown. */
  | "transport"
  /** The database refused the advisory statement, the transaction, or the connection. */
  | "database"
  /** The caller's work threw; outer layers were still released / rolled back. */
  | "work"
  /** The inputs cannot be planned. */
  | "invalid_plan";

/** The one structured failure every routine surfaces. The contract's `LockError`. */
export class LockError extends Error {
  readonly kind: LockErrorKind;
  readonly key: LockKey;
  /** Which step failed, when known. */
  step: LockStep | undefined;

  constructor(kind: LockErrorKind, key: LockKey, message: string, options?: { step?: LockStep; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LockError";
    this.kind = kind;
    this.key = key;
    this.step = options?.step;
  }

  /** Retrying the whole routine is reasonable: busy or out of budget, nothing half-done. */
  get retryable(): boolean {
    return this.kind === "contention" || this.kind === "timeout";
  }

  override toString(): string {
    return this.step
      ? `${this.kind} at ${this.step} for \`${this.key}\`: ${this.message}`
      : `${this.kind} for \`${this.key}\`: ${this.message}`;
  }

  static contention(key: LockKey, step: LockStep): LockError {
    return new LockError("contention", key, `\`${key}\` is held by another holder`, { step });
  }

  static timeout(key: LockKey, step: LockStep, waitedMs: number): LockError {
    return new LockError("timeout", key, `gave up waiting for \`${key}\` after ${Math.round(waitedMs)} ms`, { step });
  }

  static work(key: LockKey, cause: unknown): LockError {
    const message = cause instanceof Error ? cause.message : String(cause);
    return new LockError("work", key, message, { step: "work", cause });
  }

  static invalidPlan(key: LockKey, message: string): LockError {
    return new LockError("invalid_plan", key, message);
  }

  static database(key: LockKey, step: LockStep, cause: unknown): LockError {
    const message = cause instanceof Error ? cause.message : String(cause);
    return new LockError("database", key, message, { step, cause });
  }

  static transport(key: LockKey, cause: unknown, step?: LockStep): LockError {
    const message = cause instanceof Error ? cause.message : String(cause);
    return new LockError("transport", key, message, step === undefined ? { cause } : { step, cause });
  }
}

/** Fill in the step on a LockError that has none; other errors pass through. */
export function tagStep(err: unknown, step: LockStep): unknown {
  if (err instanceof LockError && err.step === undefined) err.step = step;
  return err;
}

/**
 * Keep a safety-critical cleanup failure primary while retaining the guarded
 * operation's earlier failure. A failed release/unlock leaves ownership or
 * session state unknown, so callers must not see only a work error and assume
 * an immediate whole-operation retry is safe.
 */
export function cleanupFailure(key: LockKey, cleanup: unknown, inner: unknown): LockError {
  const normalized = cleanup instanceof LockError ? cleanup : LockError.transport(key, cleanup);
  const innerMessage = inner instanceof Error ? inner.toString() : String(inner);
  return new LockError(
    normalized.kind,
    normalized.key,
    `${normalized.message}; guarded operation also failed: ${innerMessage}`,
    normalized.step === undefined
      ? { cause: { cleanup, inner } }
      : { step: normalized.step, cause: { cleanup, inner } },
  );
}
