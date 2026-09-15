// `.ores-lock.toml` normalized contract — independent TypeSpec authority.
// Peer of ../json-schema/contract.schema.json; neither is generated from the other.
// TOML is normalized to this snake_case JSON shape before admission.

@doc("Runtime coordination configuration for ores-locks-and-leases. Package/build metadata belongs in .zpkg.toml, not here.")
namespace Ores.LocksAndLeases.Config;

@doc("The only accepted schema version for the v1 manifest.")
enum LockConfigSchemaVersion {
  v1: "ores.lock.config.v1",
}

@doc("Environment-value type metadata. Values themselves never appear in the manifest.")
enum EnvKind {
  string: "string",
  boolean: "boolean",
  integer: "integer",
  double: "double",
  url: "url",
  path: "path",
}

@minLength(1)
@maxLength(128)
@pattern("^[A-Z_][A-Z0-9_]*$")
scalar EnvKey extends string;

@minLength(1)
@maxLength(128)
@pattern("^[a-z0-9](?:[a-z0-9_-]{0,126}[a-z0-9])?$")
scalar LockProfileId extends string;

model EnvBinding {
  key: EnvKey;
  kind: EnvKind;
  required: boolean;
  secret: boolean;
  @minLength(1)
  @maxLength(255)
  purpose: string;
}

model ProviderSelection {
  local_file: boolean;
  fiducia: boolean;
  pg_advisory: boolean;
}

model LocalFileProviderConfig {
  root_env: EnvKey;
  require_existing_root: boolean;
}

model FiduciaProviderConfig {
  endpoint_env: EnvKey;
  auth_token_env: EnvKey;
}

enum PostgresLockScope {
  transaction: "transaction",
  session: "session",
}

model PostgresProviderConfig {
  database_url_env: EnvKey;
  scope: PostgresLockScope;
}

model LockProfileConfig {
  profile_id: LockProfileId;
  wait: boolean;

  @minValue(0)
  @maxValue(86400000)
  wait_timeout_ms: int64;

  @minValue(0)
  @maxValue(60000)
  retry_interval_ms: int64;

  @doc("Fiducia lease TTL. Present only when the Fiducia provider is enabled.")
  @minValue(1)
  @maxValue(86400000)
  ttl_ms?: int64;

  @doc("Maintained-lease renewal interval. When present, runtime policy also requires this to be <= ttl_ms / 2.")
  @minValue(1)
  @maxValue(43200000)
  renew_interval_ms?: int64;

  providers: ProviderSelection;
  local_file?: LocalFileProviderConfig;
  fiducia?: FiduciaProviderConfig;
  postgres?: PostgresProviderConfig;
}

model OresLockConfigV1 {
  schema_version: LockConfigSchemaVersion;
  default_profile: LockProfileId;
  selected_profile_env?: EnvKey;
  env: EnvBinding[];
  profiles: LockProfileConfig[];
}
