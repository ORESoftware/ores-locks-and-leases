import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const matrix = JSON.parse(readFileSync(resolve(root, 'conformance/providers.v1.json'), 'utf8'));
assert.equal(matrix.schema, 'ores.locks.provider_conformance/v1');

const sourcePaths = {
  local_file: {
    rust: 'src/rust/local_file.rs',
    go: 'src/go/local_file.go',
    typescript: 'src/ts/src/local-file.ts',
    gleam: 'src/gleam/src/ores_locks_and_leases/local_file.gleam',
  },
  fiducia: {
    rust: 'src/rust/fiducia.rs',
    go: 'src/go/fiducia.go',
    typescript: 'src/ts/src/fiducia.ts',
    dart: 'src/dart/lib/src/fiducia.dart',
    gleam: 'src/gleam/src/ores_locks_and_leases/fiducia.gleam',
  },
  cloudflare_durable_object: {
    rust: 'src/rust/managed.rs',
    typescript: 'src/ts/src/cloudflare-do-rpc.ts',
  },
  beamscale_critical_section: {
    rust: 'src/rust/beamscale.rs',
    typescript: 'src/ts/src/beamscale-critical-section.ts',
  },
};

for (const [providerName, provider] of Object.entries(matrix.providers)) {
  assert.ok(sourcePaths[providerName], `unknown provider ${providerName}`);
  assert.ok(Array.isArray(provider.languages) && provider.languages.length > 0, `${providerName}: languages`);
  assert.ok(Array.isArray(provider.required_corpora) && provider.required_corpora.length > 0, `${providerName}: corpora`);
  if (provider.distributed) assert.equal(provider.requires_fencing, true, `${providerName}: distributed backends must fence`);
  if (!provider.distributed) assert.equal(provider.requires_fencing, false, `${providerName}: local file lock must not invent distributed fencing`);

  for (const corpus of provider.required_corpora) {
    assert.ok(existsSync(resolve(root, 'conformance/cases', corpus)), `${providerName}: missing corpus ${corpus}`);
  }
  for (const language of provider.languages) {
    const path = sourcePaths[providerName][language];
    assert.ok(path, `${providerName}: no declared source path for ${language}`);
    assert.ok(existsSync(resolve(root, path)), `${providerName}/${language}: missing adapter source ${path}`);
  }
}

for (const distributed of ['fiducia', 'cloudflare_durable_object', 'beamscale_critical_section']) {
  const corpora = new Set(matrix.providers[distributed].required_corpora);
  for (const required of ['fence-decision.json', 'renewal-decision.json', 'cancellation-race.json']) {
    assert.ok(corpora.has(required), `${distributed}: missing required distributed semantics ${required}`);
  }
}

assert.ok(existsSync(resolve(root, 'managed/cloudflare-do/src/index.js')), 'Cloudflare Durable Object authority implementation missing');
console.log(JSON.stringify(matrix, null, 2));
console.log('provider conformance capability matrix: ok');
