import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(path, "utf8");
const [vectorText, config, rust, ts, docs, example] = await Promise.all([
  read("conformance/cases/service-beamscale-pg.json"),
  read(".ores-lock.toml"),
  read("src/rust/config.rs"),
  read("src/ts/src/beamscale-critical-section.ts"),
  read("docs/managed-authorities.md"),
  read("contracts/lock-config/examples/service-beamscale-pg.ores-lock.toml"),
]);

const vector = JSON.parse(vectorText);
assert.equal(vector.schema, "ores.lock.service-profile.v1");
assert.equal(vector.profile_id, "service-beamscale-pg");
assert.equal(vector.outer_authority, "beamscale_critical_section");
assert.equal(vector.inner_authority, "postgres_advisory");
assert.equal(vector.postgres_scope, "transaction");
assert.equal(vector.tenancy_class, "tenant_dedicated");
assert.equal(vector.fencing_watermark, "sequence");
assert.deepEqual(vector.full_authority_token, ["runtime_epoch", "owner_epoch", "sequence"]);
assert.equal(vector.acquire_replay, "holder+request_id");
assert.deepEqual(vector.config_runtime_owners, ["rust"]);

for (const source of [config, example]) {
  assert.match(source, /outer_authority = "beamscale_critical_section"/u);
  assert.match(source, /deployment_id_env = "BMSCL_CRITICAL_SECTION_DEPLOYMENT_ID"/u);
}
assert.match(rust, /OuterLeaseAuthority::BeamScaleCriticalSection/u);
assert.match(rust, /BeamScaleCriticalSectionProviderConfig/u);
assert.match(ts, /request_id: requestId/u);
assert.match(ts, /runtime_epoch: token\.runtimeEpoch/u);
assert.match(ts, /owner_epoch: token\.ownerEpoch/u);
assert.match(ts, /sequence: token\.sequence/u);
assert.match(docs, /tenant-dedicated/u);
assert.match(docs, /request_id/u);

console.log("service-beamscale-pg conformance: ok");
