# Provider deployment

This repository can deploy the managed lock authority through either Cloudflare
Durable Objects or BeamScale Durable Objects / critical-section actors.

## Cloudflare

Authenticate Wrangler using the normal Cloudflare credentials, configure the
`ORES_LOCKS_API_TOKEN` secret, and deploy:

```sh
cd managed/cloudflare-do
wrangler secret put ORES_LOCKS_API_TOKEN
cd ../..
sh deploy/cloudflare-durable-objects.sh
```

Use `sh deploy/cloudflare-durable-objects.sh --dry-run` to validate the bundle
without publishing it.

## BeamScale

BeamScale Durable Objects are tenant-dedicated: one tenant per BEAM OS process.
The Lambda free tier may multiplex tenants, but that policy does not apply here.

Copy the example config, set the tenant and the immutable admitted artifact
digest, authenticate with `BMSCL_TOKEN`, and deploy:

```sh
cp managed/beamscale-critical-section/.bmscl-durable-objects.toml.example \
  managed/beamscale-critical-section/.bmscl-durable-objects.toml
export BMSCL_TOKEN=...
export BMSCL_API_URL=https://api.beamscale.example
sh deploy/beamscale-durable-objects.sh --dry-run
sh deploy/beamscale-durable-objects.sh
```

The config is intentionally explicit about `tenancy_class = "tenant_dedicated"`.
The BeamScale API rejects `mixed_tenants` for Durable Objects/critical sections.
