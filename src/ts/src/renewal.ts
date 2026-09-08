/**
 * Deterministic, fail-closed supervision for long-running Fiducia leases.
 *
 * This is cooperative cancellation: call `checkpoint` before each protected
 * commit. A heartbeat cannot make an unfenced external side effect safe and
 * cannot undo an effect emitted before the checkpoint.
 */

import type { Lease, LeaseGrant } from "./lease.js";

export const MAX_RENEWAL_CLOCK_MS = 9_007_199_254_740_991;
/** Largest TTL exactly representable by every runtime duration type. */
export const MAX_RENEWAL_TTL_MS = 9_223_372_036_854;

export interface RenewalPolicy {
  readonly renewEveryMs: number;
  readonly safetyMarginMs: number;
}

export const DEFAULT_RENEWAL_POLICY: RenewalPolicy = {
  renewEveryMs: 20_000,
  safetyMarginMs: 10_000,
};

export type RenewalLossReason =
  | "invalid_policy"
  | "clock_regression"
  | "expired"
  | "renewal_failed"
  | "identity_changed"
  | "token_changed"
  | "deadline_missing"
  | "deadline_invalid"
  | "deadline_regressed"
  | "completion_after_deadline"
  | "deadline_overflow"
  | "invalid_ttl";

export type RenewalDecision =
  | { readonly kind: "wait"; readonly checkInMs: number }
  | { readonly kind: "renew_now" }
  | { readonly kind: "lost"; readonly reason: RenewalLossReason };

export type RenewalCheckpoint =
  | { readonly kind: "wait"; readonly checkInMs: number }
  | { readonly kind: "renewed"; readonly checkInMs: number };

export class RenewalError extends Error {
  readonly reason: RenewalLossReason;
  override readonly cause: unknown;

  constructor(reason: RenewalLossReason, message: string, cause?: unknown) {
    super(`${reason}: ${message}`, { cause });
    this.name = "RenewalError";
    this.reason = reason;
    this.cause = cause;
  }
}

export type MonotonicClock = () => number;

/** Process-relative monotonic milliseconds for browsers and Node.js. */
export function monotonicNowMs(): number {
  return Math.trunc(performance.now());
}

export class LeaseRenewalSupervisor {
  #grant: LeaseGrant;
  readonly #policy: RenewalPolicy;
  #localDeadlineMs: number;
  #nextRenewalMs: number;
  #lastObservedMs: number;
  #loss: RenewalError | undefined;

  constructor(grant: LeaseGrant, policy: RenewalPolicy, nowMs: number) {
    validateGrant(grant);
    validateClock(nowMs);
    validateAuthorityDeadline(grant.leaseExpiresMs);
    const schedule = makeSchedule(nowMs, grant.ttlMs, policy);
    this.#grant = grant;
    this.#policy = policy;
    this.#localDeadlineMs = schedule.deadlineMs;
    this.#nextRenewalMs = schedule.nextRenewalMs;
    this.#lastObservedMs = nowMs;
  }

  get grant(): LeaseGrant {
    return this.#grant;
  }

  get localDeadlineMs(): number {
    return this.#localDeadlineMs;
  }

  get nextRenewalMs(): number {
    return this.#nextRenewalMs;
  }

  get loss(): RenewalError | undefined {
    return this.#loss;
  }

  get isLive(): boolean {
    return this.#loss === undefined;
  }

  decide(nowMs: number): RenewalDecision {
    if (this.#loss) return { kind: "lost", reason: this.#loss.reason };
    try {
      validateClock(nowMs);
    } catch (error) {
      return this.#lose(asRenewalError(error));
    }
    if (nowMs < this.#lastObservedMs) {
      return this.#lose(
        new RenewalError(
          "clock_regression",
          `monotonic clock regressed from ${this.#lastObservedMs} to ${nowMs}`,
        ),
      );
    }
    this.#lastObservedMs = nowMs;
    if (nowMs >= this.#localDeadlineMs) {
      return this.#lose(
        new RenewalError(
          "expired",
          `local lease deadline ${this.#localDeadlineMs} was reached at ${nowMs}`,
        ),
      );
    }
    if (nowMs >= this.#nextRenewalMs) return { kind: "renew_now" };
    return { kind: "wait", checkInMs: this.#nextRenewalMs - nowMs };
  }

  assertLive(nowMs: number): void {
    if (this.decide(nowMs).kind === "lost") throw this.#loss;
  }

  async checkpoint(lease: Lease, clock: MonotonicClock = monotonicNowMs): Promise<RenewalCheckpoint> {
    const decision = this.decide(clock());
    if (decision.kind === "wait") return decision;
    if (decision.kind === "lost") throw this.#loss;

    const previous = this.#grant;
    let renewed: LeaseGrant;
    try {
      renewed = await Promise.resolve().then(() => lease.renew(previous, previous.ttlMs));
    } catch (cause) {
      throw this.#fail(
        new RenewalError(
          "renewal_failed",
          "lease authority did not prove continued ownership",
          cause,
        ),
      );
    }
    return this.acceptRenewal(clock(), renewed);
  }

  acceptRenewal(completedMs: number, renewed: LeaseGrant): RenewalCheckpoint {
    if (this.#loss) throw this.#loss;
    try {
      validateClock(completedMs);
      validateGrant(renewed);
    } catch (error) {
      throw this.#fail(asRenewalError(error));
    }
    if (completedMs < this.#lastObservedMs) {
      throw this.#fail(
        new RenewalError(
          "clock_regression",
          `monotonic clock regressed from ${this.#lastObservedMs} to ${completedMs} during renewal`,
        ),
      );
    }
    this.#lastObservedMs = completedMs;
    if (completedMs >= this.#localDeadlineMs) {
      throw this.#fail(
        new RenewalError(
          "completion_after_deadline",
          `renewal completed at ${completedMs}, not before local deadline ${this.#localDeadlineMs}`,
        ),
      );
    }
    if (renewed.key !== this.#grant.key || renewed.holder !== this.#grant.holder) {
      throw this.#fail(
        new RenewalError("identity_changed", "renewal changed the lock key or holder identity"),
      );
    }
    if (renewed.fencingToken !== this.#grant.fencingToken) {
      throw this.#fail(
        new RenewalError(
          "token_changed",
          `renewal changed fencing token ${this.#grant.fencingToken} to ${renewed.fencingToken}`,
        ),
      );
    }
    try {
      validateDeadlineProgress(this.#grant.leaseExpiresMs, renewed.leaseExpiresMs);
      const schedule = makeSchedule(completedMs, renewed.ttlMs, this.#policy);
      this.#grant = renewed;
      this.#localDeadlineMs = schedule.deadlineMs;
      this.#nextRenewalMs = schedule.nextRenewalMs;
      return { kind: "renewed", checkInMs: schedule.nextRenewalMs - completedMs };
    } catch (error) {
      throw this.#fail(asRenewalError(error));
    }
  }

  #lose(error: RenewalError): RenewalDecision {
    const recorded = this.#record(error);
    return { kind: "lost", reason: recorded.reason };
  }

  #fail(error: RenewalError): RenewalError {
    return this.#record(error);
  }

  #record(error: RenewalError): RenewalError {
    this.#loss ??= error;
    return this.#loss;
  }
}

function validateGrant(grant: LeaseGrant): void {
  if (!grant || typeof grant !== "object") {
    throw new RenewalError("identity_changed", "renewal response is not a grant object");
  }
  if (typeof grant.key !== "string" || typeof grant.holder !== "string" || grant.holder.length === 0) {
    throw new RenewalError("identity_changed", "grant key and holder must be non-empty strings");
  }
  if (typeof grant.fencingToken !== "bigint" || grant.fencingToken < 0n || grant.fencingToken > 18_446_744_073_709_551_615n) {
    throw new RenewalError("token_changed", "fencing token must be an unsigned 64-bit bigint");
  }
  if (!isSafeMillisecond(grant.ttlMs) || grant.ttlMs === 0 || grant.ttlMs > MAX_RENEWAL_TTL_MS) {
    throw new RenewalError("invalid_ttl", `lease TTL must be within 1..=${MAX_RENEWAL_TTL_MS} ms`);
  }
  validateAuthorityDeadline(grant.leaseExpiresMs);
}

function validateClock(value: number): void {
  if (!isSafeMillisecond(value)) {
    throw new RenewalError(
      "deadline_overflow",
      `logical clock must be an integer within 0..=${MAX_RENEWAL_CLOCK_MS}`,
    );
  }
}

function validateAuthorityDeadline(value: number | undefined): void {
  if (value === undefined) return;
  if (!isSafeMillisecond(value) || value === 0) {
    throw new RenewalError("deadline_invalid", "authority deadline must be a positive safe integer when present");
  }
}

function validateDeadlineProgress(previous: number | undefined, renewed: number | undefined): void {
  validateAuthorityDeadline(renewed);
  if (previous !== undefined && renewed === undefined) {
    throw new RenewalError(
      "deadline_missing",
      "renewal omitted a deadline that the authority previously reported",
    );
  }
  if (previous !== undefined && renewed !== undefined && renewed <= previous) {
    throw new RenewalError(
      "deadline_regressed",
      `authority deadline did not advance: ${previous} -> ${renewed}`,
    );
  }
}

function makeSchedule(nowMs: number, ttlMs: number, policy: RenewalPolicy): { deadlineMs: number; nextRenewalMs: number } {
  validateClock(nowMs);
  if (!isSafeMillisecond(ttlMs) || ttlMs === 0 || ttlMs > MAX_RENEWAL_TTL_MS) {
    throw new RenewalError("invalid_ttl", `lease TTL must be within 1..=${MAX_RENEWAL_TTL_MS} ms`);
  }
  if (
    !isPositiveSafeInteger(policy.renewEveryMs) ||
    !isPositiveSafeInteger(policy.safetyMarginMs) ||
    policy.renewEveryMs >= ttlMs ||
    policy.safetyMarginMs >= ttlMs
  ) {
    throw new RenewalError(
      "invalid_policy",
      "renewal interval and safety margin must both be positive and less than the lease TTL",
    );
  }
  const deadlineMs = nowMs + ttlMs;
  const intervalDue = nowMs + policy.renewEveryMs;
  if (!isSafeMillisecond(deadlineMs) || !isSafeMillisecond(intervalDue)) {
    throw new RenewalError("deadline_overflow", "renewal schedule exceeds the shared logical-clock domain");
  }
  const nextRenewalMs = Math.min(intervalDue, deadlineMs - policy.safetyMarginMs);
  if (nextRenewalMs <= nowMs) {
    throw new RenewalError("invalid_policy", "renewal policy leaves no positive live interval");
  }
  return { deadlineMs, nextRenewalMs };
}

function isSafeMillisecond(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_RENEWAL_CLOCK_MS;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isSafeMillisecond(value) && value > 0;
}

function asRenewalError(error: unknown): RenewalError {
  return error instanceof RenewalError
    ? error
    : new RenewalError("renewal_failed", "renewal validation failed", error);
}
