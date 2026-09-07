import { lockKey, type LockKey } from "./key.js";

const MAX_FENCING_TOKEN = 18_446_744_073_709_551_615n;
const CANONICAL_TOKEN = /^(0|[1-9][0-9]{0,19})$/;
const LOWER_SHA256 = /^[0-9a-f]{64}$/;

declare const fencingTokenBrand: unique symbol;

/**
 * Canonical unsigned-64 decimal text. Use this form at JSON, Redis, SQL, and
 * cross-runtime boundaries; never round-trip a Fiducia token through number.
 */
export type FencingTokenText = string & {
  readonly [fencingTokenBrand]: true;
};

export const MAX_FENCING_TOKEN_TEXT = "18446744073709551615" as FencingTokenText;
export const MAX_TENANT_SCOPE_BYTES = 256;
export const MAX_OPERATION_ID_BYTES = 128;
export const MAX_FENCE_METADATA_BYTES = 256;

export type FenceValidationCode =
  | "empty_field"
  | "too_long"
  | "invalid_fencing_token"
  | "invalid_payload_sha256"
  | "identity_mismatch";

export class FenceValidationError extends Error {
  readonly code: FenceValidationCode;
  readonly field: string | undefined;

  constructor(code: FenceValidationCode, message: string, field?: string) {
    super(message);
    this.name = "FenceValidationError";
    this.code = code;
    this.field = field;
  }
}

/** Validate and canonicalize string or bigint input without precision loss. */
export function fencingTokenText(value: string | bigint): FencingTokenText {
  if (typeof value === "bigint") {
    if (value < 0n || value > MAX_FENCING_TOKEN) {
      throw new FenceValidationError(
        "invalid_fencing_token",
        `fencing token ${value.toString()} is outside the unsigned-64 range`,
        "fencingToken",
      );
    }
    return value.toString() as FencingTokenText;
  }

  if (!CANONICAL_TOKEN.test(value)) {
    throw new FenceValidationError(
      "invalid_fencing_token",
      `fencing token ${JSON.stringify(value)} is not canonical unsigned-64 decimal text`,
      "fencingToken",
    );
  }

  const parsed = BigInt(value);
  if (parsed > MAX_FENCING_TOKEN || parsed.toString() !== value) {
    throw new FenceValidationError(
      "invalid_fencing_token",
      `fencing token ${JSON.stringify(value)} is outside the unsigned-64 range`,
      "fencingToken",
    );
  }
  return value as FencingTokenText;
}

/** Convert canonical text to an exact native bigint. */
export function fencingTokenValue(value: FencingTokenText): bigint {
  return BigInt(fencingTokenText(value));
}

export type FenceDecisionKind =
  | "advanced"
  | "replay"
  | "stale"
  | "token_reuse";

export interface FencedWriteRequest {
  readonly tenantScope: string;
  readonly resourceKey: LockKey;
  readonly fencingToken: FencingTokenText;
  readonly operationId: string;
  readonly payloadSha256: string;
  readonly holder?: string;
  readonly leaseId?: string;
}

export interface FencedWriteRequestInput {
  readonly tenantScope: string;
  readonly resourceKey: string;
  readonly fencingToken: string | bigint;
  readonly operationId: string;
  readonly payloadSha256: string;
  readonly holder?: string;
  readonly leaseId?: string;
}

export interface FenceWatermark extends FencedWriteRequest {}

export interface FenceDecision {
  readonly kind: FenceDecisionKind;
  /** True only for `advanced`; replay and every rejection are no-ops. */
  readonly shouldApply: boolean;
  readonly incomingToken: FencingTokenText;
  /** Token that remains current after the decision. */
  readonly currentToken: FencingTokenText;
  /** Watermark before the decision, absent only for the first accepted write. */
  readonly previousToken?: FencingTokenText;
}

/** Validate an untrusted wire object before any datastore call. */
export function fencedWriteRequest(
  input: FencedWriteRequestInput,
): FencedWriteRequest {
  validateField("tenantScope", input.tenantScope, MAX_TENANT_SCOPE_BYTES);
  validateField("resourceKey", input.resourceKey, 512);
  validateField("operationId", input.operationId, MAX_OPERATION_ID_BYTES);
  validateOptionalField("holder", input.holder, MAX_FENCE_METADATA_BYTES);
  validateOptionalField("leaseId", input.leaseId, MAX_FENCE_METADATA_BYTES);
  if (!LOWER_SHA256.test(input.payloadSha256)) {
    throw new FenceValidationError(
      "invalid_payload_sha256",
      "payloadSha256 must be exactly 64 lowercase hexadecimal characters",
      "payloadSha256",
    );
  }

  return {
    tenantScope: input.tenantScope,
    resourceKey: lockKey(input.resourceKey),
    fencingToken: fencingTokenText(input.fencingToken),
    operationId: input.operationId,
    payloadSha256: input.payloadSha256,
    ...(input.holder === undefined ? {} : { holder: input.holder }),
    ...(input.leaseId === undefined ? {} : { leaseId: input.leaseId }),
  };
}

/** Validate persisted state using the same boundary as an incoming request. */
export function fenceWatermark(input: FencedWriteRequestInput): FenceWatermark {
  return fencedWriteRequest(input);
}

/** Row to persist when the decision is `advanced`. */
export function watermarkFromRequest(
  request: FencedWriteRequest,
): FenceWatermark {
  return { ...request };
}

/**
 * Pure fencing decision. The datastore adapter must persist an `advanced`
 * watermark and perform the protected mutation in one transaction or script.
 */
export function evaluateFence(
  current: FenceWatermark | null,
  incoming: FencedWriteRequest,
): FenceDecision {
  validateTrustedRequest(incoming);

  if (current === null) {
    return {
      kind: "advanced",
      shouldApply: true,
      incomingToken: incoming.fencingToken,
      currentToken: incoming.fencingToken,
    };
  }
  validateTrustedRequest(current);

  if (
    current.tenantScope !== incoming.tenantScope ||
    current.resourceKey !== incoming.resourceKey
  ) {
    throw new FenceValidationError(
      "identity_mismatch",
      "current watermark and incoming request identify different resources",
    );
  }

  const incomingValue = fencingTokenValue(incoming.fencingToken);
  const currentValue = fencingTokenValue(current.fencingToken);

  if (incomingValue > currentValue) {
    return {
      kind: "advanced",
      shouldApply: true,
      incomingToken: incoming.fencingToken,
      currentToken: incoming.fencingToken,
      previousToken: current.fencingToken,
    };
  }

  if (incomingValue < currentValue) {
    return {
      kind: "stale",
      shouldApply: false,
      incomingToken: incoming.fencingToken,
      currentToken: current.fencingToken,
      previousToken: current.fencingToken,
    };
  }

  const kind: FenceDecisionKind =
    current.operationId === incoming.operationId &&
    current.payloadSha256 === incoming.payloadSha256
      ? "replay"
      : "token_reuse";

  return {
    kind,
    shouldApply: false,
    incomingToken: incoming.fencingToken,
    currentToken: current.fencingToken,
    previousToken: current.fencingToken,
  };
}

function validateTrustedRequest(request: FencedWriteRequest): void {
  // Branded types are compile-time only; adapters can still receive values
  // from `unknown`, so the pure decision revalidates every external field.
  fencedWriteRequest({
    tenantScope: request.tenantScope,
    resourceKey: request.resourceKey,
    fencingToken: request.fencingToken,
    operationId: request.operationId,
    payloadSha256: request.payloadSha256,
    ...(request.holder === undefined ? {} : { holder: request.holder }),
    ...(request.leaseId === undefined ? {} : { leaseId: request.leaseId }),
  });
}

function validateField(field: string, value: string, max: number): void {
  if (value.length === 0) {
    throw new FenceValidationError(
      "empty_field",
      `${field} must not be empty`,
      field,
    );
  }
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes > max) {
    throw new FenceValidationError(
      "too_long",
      `${field} is ${bytes} bytes; maximum is ${max}`,
      field,
    );
  }
}

function validateOptionalField(
  field: string,
  value: string | undefined,
  max: number,
): void {
  if (value !== undefined) validateField(field, value, max);
}
