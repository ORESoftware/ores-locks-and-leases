namespace ORES.LocksAndLeases.Fencing;

/** Canonical, lossless unsigned-64 decimal token at JSON and datastore boundaries. */
@pattern("^(0|[1-9][0-9]{0,19})$")
scalar FencingTokenDecimal extends string;

/** Stable idempotency identity for one protected write. */
@pattern("^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$")
scalar OperationId extends string;

/** Lowercase hexadecimal SHA-256 digest of the protected write payload. */
@pattern("^[0-9a-f]{64}$")
scalar PayloadSha256 extends string;

/** Durable highest accepted fencing token and the write identity that established it. */
model FenceWatermark {
  fencingToken: FencingTokenDecimal;
  operationId: OperationId;
  payloadSha256: PayloadSha256;
}

/** Candidate write presented to an atomic compare-and-advance operation. */
model FenceAttempt {
  fencingToken: FencingTokenDecimal;
  operationId: OperationId;
  payloadSha256: PayloadSha256;
}

/** Exhaustive outcome of comparing a candidate write with a durable watermark. */
enum FenceDecisionKind {
  advanced,
  replay,
  tokenReuse: "token_reuse",
  stale,
}

/** Pure fail-closed result shared by runtime and datastore adapters. */
model FenceDecision {
  kind: FenceDecisionKind;
  apply: boolean;
  watermark: FenceWatermark;
}
