import { DurableObject } from "cloudflare:workers";

import { LockLeaseAuthority } from "./authority.js";
import {
  bearerMatches,
  internalBody,
  knownLeasePath,
  productionMode,
  readBoundedJson,
  validateInternalOperation,
  validatePublicOperation,
} from "./http-boundary.js";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function rpcStatus(result) {
  if (!result || typeof result !== "object" || !("error" in result)) return 200;
  return result.error === "fencing_token_exhausted" ? 503 : 400;
}

async function invokeRpc(stub, path, body) {
  if (path === "/v1/leases/acquire") return stub.acquire(body);
  if (path === "/v1/leases/renew") return stub.renew(body);
  return stub.release(body);
}

function decodedError(decoded) {
  return decoded.error ? json({ error: decoded.error }, decoded.status) : null;
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
    if (!knownLeasePath(path)) return json({ error: "not_found" }, 404);

    const decoded = await readBoundedJson(request);
    const decodeFailure = decodedError(decoded);
    if (decodeFailure) return decodeFailure;

    const validationError = validateInternalOperation(path, decoded.body);
    if (validationError) return json({ error: validationError }, 400);

    const result = await invokeRpc(this, path, internalBody(path, decoded.body));
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
    if (!knownLeasePath(url.pathname)) return json({ error: "not_found" }, 404);
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

    const allowUnauthenticated = env.ALLOW_UNAUTHENTICATED === "true";
    if (productionMode(env) && allowUnauthenticated) {
      return json({ error: "unsafe_configuration" }, 503);
    }
    if (!env.ORES_LOCKS_API_TOKEN && !allowUnauthenticated) {
      return json({ error: "authority_not_configured" }, 503);
    }
    if (!allowUnauthenticated && !(await bearerMatches(request, env.ORES_LOCKS_API_TOKEN))) {
      return json({ error: "unauthorized" }, 401);
    }

    const decoded = await readBoundedJson(request);
    const decodeFailure = decodedError(decoded);
    if (decodeFailure) return decodeFailure;

    const validationError = validatePublicOperation(url.pathname, decoded.body);
    if (validationError) return json({ error: validationError }, 400);

    const stub = env.LOCKS.getByName(decoded.body.key);
    try {
      const result = await invokeRpc(stub, url.pathname, internalBody(url.pathname, decoded.body));
      return json(result, rpcStatus(result));
    } catch {
      // RPC exceptions invalidate the stub. Transport ambiguity is never contention.
      return json({ error: "authority_rpc_failed" }, 503);
    }
  },
};
