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

The trusted BeamScale Erlang actor owns acquisition, renewal, release, durable
owner epochs, and fencing tokens. The customer artifact is separately admitted
and activated; it cannot mint ownership. This repository includes a minimal
restricted Erlang artifact at
`managed/beamscale-critical-section/critical-worker`.

Copy the config, then build/sign, admit, and deploy:

```sh
cp managed/beamscale-critical-section/.bmscl-durable-objects.toml.example \
  managed/beamscale-critical-section/.bmscl-durable-objects.toml

# edit tenant_id first
sh deploy/beamscale-durable-objects.sh build \
  --signing-key /run/secrets/customer-build-key.hex \
  --key-id customer-q3

export BMSCL_ADMIN_API_URL=https://admin-api.beamscale.example
export BMSCL_ADMIN_TOKEN=...
export BMSCL_API_URL=https://api.beamscale.example
export BMSCL_TOKEN=...

sh deploy/beamscale-durable-objects.sh deploy --dry-run
sh deploy/beamscale-durable-objects.sh deploy
```

The deploy command uploads the signed immutable bundle to BeamScale's admin
artifact registry. The admin service re-verifies it with `bmscl-compiler`.
Only after the public API observes a verified artifact with the exact requested
digest and language/profile does it allocate/activate the tenant-dedicated
Durable Actor runtime.

The config is intentionally explicit about `tenancy_class = "tenant_dedicated"`.
The BeamScale API rejects `mixed_tenants` for Durable Objects/critical sections.
