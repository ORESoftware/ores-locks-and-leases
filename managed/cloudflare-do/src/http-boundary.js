import {
  canonicalToken,
  validHolder,
  validIdentity,
  validRequestId,
  validTtl,
} from "./authority.js";

export const MAX_LOCK_KEY_BYTES = 512;
export const MAX_BODY_BYTES = 8 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const PUBLIC_FIELDS = {
  "/v1/leases/acquire": new Set(["key", "holder", "ttl_ms", "request_id"]),
  "/v1/leases/renew": new Set(["key", "holder", "ttl_ms", "fencing_token"]),
  "/v1/leases/release": new Set(["key", "holder", "fencing_token"]),
};

const INTERNAL_FIELDS = {
  "/v1/leases/acquire": new Set(["holder", "ttl_ms", "request_id"]),
  "/v1/leases/renew": new Set(["holder", "ttl_ms", "fencing_token"]),
  "/v1/leases/release": new Set(["holder", "fencing_token"]),
};

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyFields(body, allowed) {
  return isPlainObject(body) && Object.keys(body).every((field) => allowed.has(field));
}

function validateOperation(path, body, fields, requireKey) {
  const allowed = fields[path];
  if (!allowed || !isPlainObject(body)) return "invalid_body";
  if (!hasOnlyFields(body, allowed)) return "unknown_field";
  if (requireKey && !validIdentity(body.key, MAX_LOCK_KEY_BYTES)) return "invalid_key";
  if (!validHolder(body.holder)) return "invalid_holder";
  if (path === "/v1/leases/acquire" && !validRequestId(body.request_id)) {
    return "invalid_request_id";
  }
  if (path !== "/v1/leases/release" && !validTtl(body.ttl_ms)) return "invalid_ttl";
  if (path !== "/v1/leases/acquire" && canonicalToken(body.fencing_token) === null) {
    return "invalid_fencing_token";
  }
  return null;
}

export function validatePublicOperation(path, body) {
  return validateOperation(path, body, PUBLIC_FIELDS, true);
}

export function validateInternalOperation(path, body) {
  return validateOperation(path, body, INTERNAL_FIELDS, false);
}

export function knownLeasePath(path) {
  return Object.hasOwn(PUBLIC_FIELDS, path);
}

export function productionMode(env) {
  const mode = String(env.ORES_LOCKS_ENVIRONMENT ?? "").toLowerCase();
  return mode === "production" || mode === "prod";
}

function parseBearer(request) {
  const auth = request.headers.get("authorization") ?? "";
  const match = /^Bearer[ ]+(.+)$/i.exec(auth);
  return match?.[1] ?? "";
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

export async function bearerMatches(request, expected) {
  if (typeof expected !== "string" || expected.length === 0) return false;
  const supplied = parseBearer(request);
  const [actualDigest, expectedDigest] = await Promise.all([sha256(supplied), sha256(expected)]);
  let difference = 0;
  for (let index = 0; index < expectedDigest.length; index += 1) {
    difference |= actualDigest[index] ^ expectedDigest[index];
  }
  return difference === 0;
}

export async function readBoundedJson(request) {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      return { error: "invalid_content_length", status: 400 };
    }
    if (parsed > MAX_BODY_BYTES) return { error: "body_too_large", status: 413 };
  }

  if (request.body === null) return { error: "invalid_json", status: 400 };

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        return { error: "body_too_large", status: 413 };
      }
      chunks.push(value);
    }
  } catch {
    return { error: "invalid_json", status: 400 };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return { body: JSON.parse(decoder.decode(bytes)) };
  } catch {
    return { error: "invalid_json", status: 400 };
  }
}

export function internalBody(path, body) {
  if (path === "/v1/leases/acquire") {
    return {
      holder: body.holder,
      ttl_ms: body.ttl_ms,
      ...(body.request_id === undefined ? {} : { request_id: body.request_id }),
    };
  }
  if (path === "/v1/leases/renew") {
    return {
      holder: body.holder,
      ttl_ms: body.ttl_ms,
      fencing_token: canonicalToken(body.fencing_token),
    };
  }
  return {
    holder: body.holder,
    fencing_token: canonicalToken(body.fencing_token),
  };
}
