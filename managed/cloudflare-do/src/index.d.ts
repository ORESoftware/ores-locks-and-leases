import { DurableObject } from "cloudflare:workers";

import type {
  CloudflareDurableObjectAcquireRequest,
  CloudflareDurableObjectAcquireResult,
  CloudflareDurableObjectReleaseRequest,
  CloudflareDurableObjectReleaseResult,
  CloudflareDurableObjectRenewRequest,
  CloudflareDurableObjectRenewResult,
} from "../../../src/ts/src/cloudflare-do-rpc-types.js";

export interface Env {
  LOCKS: DurableObjectNamespace<LockLeaseObject>;
  ORES_LOCKS_API_TOKEN?: string;
  ALLOW_UNAUTHENTICATED?: string;
}

/** RPC methods exposed by the deployed `LOCKS` Durable Object binding. */
export declare class LockLeaseObject extends DurableObject<Env> {
  acquire(input: CloudflareDurableObjectAcquireRequest): Promise<CloudflareDurableObjectAcquireResult>;
  renew(input: CloudflareDurableObjectRenewRequest): Promise<CloudflareDurableObjectRenewResult>;
  release(input: CloudflareDurableObjectReleaseRequest): Promise<CloudflareDurableObjectReleaseResult>;
  fetch(request: Request): Promise<Response>;
  alarm(): Promise<void>;
}

declare const worker: ExportedHandler<Env>;
export default worker;
