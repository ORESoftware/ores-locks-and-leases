// Supervised Fiducia lease renewal — independent TypeSpec authority.
// Peer of ../json-schema/contract.schema.json; neither is generated from the other.

@doc("Fail-closed lifecycle contract for long-running Fiducia lease renewal checkpoints.")
namespace Ores.LocksAndLeases.Renewal;

@doc("Process-local monotonic milliseconds. Cross-runtime values are capped at JavaScript's exact integer boundary.")
scalar LogicalMilliseconds extends uint64;

@doc("A full-width Fiducia fencing token. Renewal must preserve this value exactly.")
scalar FencingToken extends uint64;

@doc("Lease TTL in milliseconds, capped at the largest duration every supported runtime can represent without overflow.")
@maxValue(9223372036854)
scalar RenewalTtlMilliseconds extends uint64;

@doc("When to renew relative to the locally observed lease TTL.")
model RenewalPolicy {
  @doc("Preferred interval between successful renewal checkpoints; positive and less than the active TTL. The active TTL is capped at 9223372036854 ms for cross-runtime duration safety.")
  renewEveryMs: LogicalMilliseconds;
  @doc("Renew no later than this many milliseconds before the local deadline; positive and less than the active TTL.")
  safetyMarginMs: LogicalMilliseconds;
}

@doc("The pure scheduling outcome at one monotonic-clock observation.")
enum RenewalDecisionKind {
  wait: "wait",
  renewNow: "renew_now",
  lost: "lost",
}

@doc("Why a supervisor permanently stopped authorizing protected effects.")
enum RenewalLossReason {
  invalidPolicy: "invalid_policy",
  clockRegression: "clock_regression",
  expired: "expired",
  renewalFailed: "renewal_failed",
  identityChanged: "identity_changed",
  tokenChanged: "token_changed",
  deadlineMissing: "deadline_missing",
  deadlineInvalid: "deadline_invalid",
  deadlineRegressed: "deadline_regressed",
  completionAfterDeadline: "completion_after_deadline",
  deadlineOverflow: "deadline_overflow",
  invalidTtl: "invalid_ttl",
}

@doc("Exact lease identity that a successful renewal must preserve.")
model RenewalGrantIdentity {
  @maxLength(512)
  key: string;
  @maxLength(256)
  holder: string;
  fencingToken: FencingToken;
  ttlMs: RenewalTtlMilliseconds;
  @doc("Absolute authority deadline when supplied. It must advance on each successful renewal once present.")
  leaseExpiresMs?: LogicalMilliseconds;
}

@doc("One scheduling decision. checkInMs is present only for wait; reason only for lost.")
model RenewalDecision {
  kind: RenewalDecisionKind;
  checkInMs?: LogicalMilliseconds;
  reason?: RenewalLossReason;
}

@doc("Observable supervisor state retained by runtime implementations.")
model RenewalSnapshot {
  grant: RenewalGrantIdentity;
  policy: RenewalPolicy;
  localDeadlineMs: LogicalMilliseconds;
  nextRenewalMs: LogicalMilliseconds;
  lastObservedMs: LogicalMilliseconds;
  loss?: RenewalLossReason;
}
