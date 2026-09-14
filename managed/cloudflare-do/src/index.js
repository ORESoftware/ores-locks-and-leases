import { DurableObject } from "cloudflare:workers";

import {
  LockLeaseAuthority,
  validHolder,
  validIdentity,
  validRequestId,
} from "./authority.js";

const MAX_LOCK_KEY_BYTES = 512;
const MAX_BODY_BYTES = 16_384;
const encoder = new TextEncoder();

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function parseBearer(request) {
  const auth = request.headers.get("authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : "";
}

function validKey(key) {
  return validIdentity(key, MAX_LOCK_KEY_BYTES);
}

async function readJson(request) {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const bytes = Number(declared);
    if (Number.isFinite(bytes) && bytes > MAX_BODY_BYTES) {
      return { response: json({ error: "body_too_large" }, 413) };
    }
  }

  let text;
  try {
    text = await request.text();
  } catch {
    return { response: json({ error: "invalid_body" }, 400) };
  }
  if (encoder.encode(text).length > MAX_BODY_BYTES) {
    return { response: json({ error: "body_too_large" }, 413) };
  }
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { response: json({ error: "invalid_json" }, 400) };
  }
}

function rpcStatus(result) {
  if (!result || typeof result !== "object" || !("error" in result)) return 200;
  return result.error === "fencing_token_exhausted" ? 503 : 400;
}

function toRpcInput(path, body) {
  if (path === "/v1/leases/acquire") {
    return {
      holder: body?.holder,
      ttl_ms: body?.ttl_ms,
      ...(body?.request_id === undefined ? {} : { request_id: body.request_id }),
    };
  }
  if (path === "/v1/leases/renew") {
    return {
      holder: body?.holder,
      fencing_token: body?.fencing_token,
      ttl_ms: body?.ttl_ms,
    };
  }
  return {
    holder: body?.holder,
    fencing_token: body?.fencing_token,
  };
}

async function invokeRpc(stub, path, body) {
  const input = toRpcInput(path, body);
  if (path === "/v1/leases/acquire") return stub.acquire(input);
  if (path === "/v1/leases/renew") return stub.renew(input);
  return stub.release(input);
}

/** Native Cloudflare Durable Object RPC authority. */
export class LockLeaseObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.authority = new LockLeaseAuthority(ctx);
  }

  async acquire(input) {
    return this.authority.acquire(input);
  }

  async renew(input) {
    return this.authority.renew(input);
  }

  async release(input) {
    return this.authority.release(input);
  }

  async alarm() {
    return this.authority.alarm();
  }

  /** Backwards-compatible stub.fetch adapter for callers not yet using RPC. */
  async fetch(request) {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const path = new URL(request.url).pathname;
    if (!["/v1/leases/acquire", "/v1/leases/renew", "/v1/leases/release"].includes(path)) {
      return json({ error: "not_found" }, 404);
    }
    const parsed = await readJson(request);
    if (parsed.response) return parsed.response;
    const result = await invokeRpc(this, path, parsed.body);
    return json(result, rpcStatus(result));
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return json({
        ok: true,
        authority: "cloudflare_durable_object",
        transport: "workers_rpc",
        fencing_token_max: Number.MAX_SAFE_INTEGER,
      });
    }
    if (!["/v1/leases/acquire", "/v1/leases/renew", "/v1/leases/release"].includes(url.pathname)) {
      return json({ error: "not_found" }, 404);
    }
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

    const allowUnauthenticated = env.ALLOW_UNAUTHENTICATED === "true";
    if (!env.ORES_LOCKS_API_TOKEN && !allowUnauthenticated) {
      return json({ error: "authority_not_configured" }, 503);
    }
    if (!allowUnauthenticated && parseBearer(request) !== env.ORES_LOCKS_API_TOKEN) {
      return json({ error: "unauthorized" }, 401);
    }

    const parsed = await readJson(request);
    if (parsed.response) return parsed.response;
    const body = parsed.body;
    if (!validKey(body?.key)) return json({ error: "invalid_key" }, 400);
    if (!validHolder(body?.holder)) return json({ error: "invalid_holder" }, 400);
    if (!validRequestId(body?.request_id)) return json({ error: "invalid_request_id" }, 400);

    const stub = env.LOCKS.getByName(body.key);
    try {
      const result = await invokeRpc(stub, url.pathname, body);
      return json(result, rpcStatus(result));
    } catch {
      // RPC exceptions invalidate the stub. Transport ambiguity is never contention.
      return json({ error: "authority_rpc_failed" }, 503);
    }
  },
};
