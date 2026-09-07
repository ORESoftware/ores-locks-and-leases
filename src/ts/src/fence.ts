import { MAX_LOCK_KEY_BYTES, lockKey, type LockKey } from "./key.js";

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
  | "invalid_type"
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

  // The public TypeScript signature is intentionally narrow, but JavaScript,
  // `unknown` casts, deserializers, and forged objects still reach this runtime
  // boundary. Check the primitive type before regex or string interpolation so
  // caller coercion hooks can never run.
  if (typeof value !== "string") {
    throw new FenceValidationError(
      "invalid_fencing_token",
      "fencingToken must be canonical unsigned-64 decimal text",
      "fencingToken",
    );
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
  const record = requestRecord(input);
  const tenantScope = validateField(
    "tenantScope",
    record.tenantScope,
    MAX_TENANT_SCOPE_BYTES,
  );
  const resourceKey = validateField(
    "resourceKey",
    record.resourceKey,
    MAX_LOCK_KEY_BYTES,
  );
  const operationId = validateField(
    "operationId",
    record.operationId,
    MAX_OPERATION_ID_BYTES,
  );
  const holder = validateOptionalField(
    "holder",
    record.holder,
    MAX_FENCE_METADATA_BYTES,
  );
  const leaseId = validateOptionalField(
    "leaseId",
    record.leaseId,
    MAX_FENCE_METADATA_BYTES,
  );

  const payloadSha256 = record.payloadSha256;
  if (
    typeof payloadSha256 !== "string" ||
    !LOWER_SHA256.test(payloadSha256)
  ) {
    throw new FenceValidationError(
      "invalid_payload_sha256",
      "payloadSha256 must be exactly 64 lowercase hexadecimal characters",
      "payloadSha256",
    );
  }

  const rawToken = record.fencingToken;
  if (typeof rawToken !== "string" && typeof rawToken !== "bigint") {
    throw new FenceValidationError(
      "invalid_fencing_token",
      "fencingToken must be canonical unsigned-64 decimal text",
      "fencingToken",
    );
  }

  return {
    tenantScope,
    resourceKey: lockKey(resourceKey),
    fencingToken: fencingTokenText(rawToken),
    operationId,
    payloadSha256,
    ...(holder === undefined ? {} : { holder }),
    ...(leaseId === undefined ? {} : { leaseId }),
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
  return { ...fencedWriteRequest(request) };
}

/**
 * Pure fencing decision. The datastore adapter must persist an `advanced`
 * watermark and perform the protected mutation in one transaction or script.
 *
 * Both inputs are revalidated into plain snapshots first. The decision never
 * reads from the caller-controlled object after validation, which prevents
 * getters or later mutation from changing the identity that was checked.
 */
export function evaluateFence(
  current: FenceWatermark | null,
  incoming: FencedWriteRequest,
): FenceDecision {
  const validatedIncoming = fencedWriteRequest(incoming);

  if (current === null) {
    return {
      kind: "advanced",
      shouldApply: true,
      incomingToken: validatedIncoming.fencingToken,
      currentToken: validatedIncoming.fencingToken,
    };
  }
  const validatedCurrent = fenceWatermark(current);

  if (
    validatedCurrent.tenantScope !== validatedIncoming.tenantScope ||
    validatedCurrent.resourceKey !== validatedIncoming.resourceKey
  ) {
    throw new FenceValidationError(
      "identity_mismatch",
      "current watermark and incoming request identify different resources",
    );
  }

  const incomingValue = fencingTokenValue(validatedIncoming.fencingToken);
  const currentValue = fencingTokenValue(validatedCurrent.fencingToken);

  if (incomingValue > currentValue) {
    return {
      kind: "advanced",
      shouldApply: true,
      incomingToken: validatedIncoming.fencingToken,
      currentToken: validatedIncoming.fencingToken,
      previousToken: validatedCurrent.fencingToken,
    };
  }

  if (incomingValue < currentValue) {
    return {
      kind: "stale",
      shouldApply: false,
      incomingToken: validatedIncoming.fencingToken,
      currentToken: validatedCurrent.fencingToken,
      previousToken: validatedCurrent.fencingToken,
    };
  }

  const kind: FenceDecisionKind =
    validatedCurrent.operationId === validatedIncoming.operationId &&
    validatedCurrent.payloadSha256 === validatedIncoming.payloadSha256
      ? "replay"
      : "token_reuse";

  return {
    kind,
    shouldApply: false,
    incomingToken: validatedIncoming.fencingToken,
    currentToken: validatedCurrent.fencingToken,
    previousToken: validatedCurrent.fencingToken,
  };
}

function requestRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new FenceValidationError(
      "invalid_type",
      "fenced write request must be a non-array object",
    );
  }
  return value as Record<string, unknown>;
}

function validateField(
  field: string,
  value: unknown,
  max: number,
): string {
  if (typeof value !== "string") {
    throw new FenceValidationError(
      "invalid_type",
      `${field} must be a string`,
      field,
    );
  }
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
  return value;
}

function validateOptionalField(
  field: string,
  value: unknown,
  max: number,
): string | undefined {
  if (value === undefined) return undefined;
  return validateField(field, value, max);
}
