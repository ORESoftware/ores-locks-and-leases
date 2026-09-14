export interface CloudflareDurableObjectAcquireRequest {
  readonly holder: string;
  readonly ttl_ms: number;
  readonly request_id?: string;
}

export interface CloudflareDurableObjectRenewRequest {
  readonly holder: string;
  readonly fencing_token: string | number;
  readonly ttl_ms: number;
}

export interface CloudflareDurableObjectReleaseRequest {
  readonly holder: string;
  readonly fencing_token: string | number;
}

export type CloudflareDurableObjectAcquireError =
  | "invalid_holder"
  | "invalid_request_id"
  | "invalid_ttl"
  | "fencing_token_exhausted";

export type CloudflareDurableObjectRenewError =
  | "invalid_holder"
  | "invalid_ttl"
  | "invalid_fencing_token";

export type CloudflareDurableObjectReleaseError =
  | "invalid_holder"
  | "invalid_fencing_token";

export type CloudflareDurableObjectAcquireResult =
  | {
      readonly acquired: true;
      readonly fencing_token: string;
      readonly lease_expires_ms: number;
      readonly ttl_ms: number;
      readonly renewed: false;
      readonly replayed: false;
    }
  | {
      readonly acquired: true;
      readonly fencing_token: string;
      readonly lease_expires_ms: number;
      readonly renewed: false;
      readonly replayed: true;
    }
  | {
      readonly acquired: false;
      readonly reason: "contention" | "holder_active_different_request";
      readonly lease_expires_ms: number;
    }
  | {
      readonly acquired: false;
      readonly error: CloudflareDurableObjectAcquireError;
    };

export type CloudflareDurableObjectRenewResult =
  | {
      readonly renewed: true;
      readonly lease_expires_ms: number;
      readonly ttl_ms: number;
    }
  | {
      readonly renewed: false;
      readonly reason: "expired" | "not_owner";
    }
  | {
      readonly renewed: false;
      readonly error: CloudflareDurableObjectRenewError;
    };

export type CloudflareDurableObjectReleaseResult =
  | { readonly released: true }
  | { readonly released: false; readonly reason: "expired" | "not_owner" }
  | { readonly released: false; readonly error: CloudflareDurableObjectReleaseError };

/** Structural view of the methods exposed by DurableObjectStub<LockLeaseObject>. */
export interface CloudflareDurableObjectRpcStub {
  acquire(input: CloudflareDurableObjectAcquireRequest): Promise<CloudflareDurableObjectAcquireResult>;
  renew(input: CloudflareDurableObjectRenewRequest): Promise<CloudflareDurableObjectRenewResult>;
  release(input: CloudflareDurableObjectReleaseRequest): Promise<CloudflareDurableObjectReleaseResult>;
}

/** Structural subset of DurableObjectNamespace<LockLeaseObject>. */
export interface CloudflareDurableObjectRpcNamespace {
  getByName(name: string): CloudflareDurableObjectRpcStub;
}
