import { readFile } from 'node:fs/promises';

const read = (path) => readFile(path, 'utf8');
const vector = JSON.parse(await read('conformance/cases/service-cloudflare-pg.json'));
const [config, rust, ts, go, dart, docs] = await Promise.all([
  read('.ores-lock.toml'),
  read('src/rust/maintained.rs'),
  read('src/ts/src/maintained.ts'),
  read('src/go/maintained.go'),
  read('src/dart/lib/src/maintained.dart'),
  read('docs/cloudflare-service-profile.md'),
]);

const requireText = (text, needle, label) => {
  if (!text.includes(needle)) throw new Error(`${label}: missing ${needle}`);
};
const requireRegex = (text, re, label) => {
  if (!re.test(text)) throw new Error(`${label}: missing ${re}`);
};

if (vector.schema !== 'ores.lock.service-profile.v1') throw new Error('unexpected service profile corpus schema');
if (vector.profile_id !== 'service-cloudflare-pg') throw new Error('unexpected service profile id');
if (vector.outer_authority !== 'cloudflare_durable_object') throw new Error('Cloudflare DO must be the outer authority');
if (vector.inner_authority !== 'postgres_advisory' || vector.postgres_scope !== 'transaction') {
  throw new Error('service profile must use transaction-scoped Postgres advisory locking');
}
if (vector.final_renewal_required !== true) throw new Error('final renewal must be mandatory');
if (vector.scheduler_local_lock_is_authority !== false) throw new Error('scheduler-local lock cannot be an authority');
if (JSON.stringify(vector.config_runtime_owners) !== JSON.stringify(['rust'])) {
  throw new Error('config runtime ownership changed; add an explicit projection before changing this vector');
}

requireRegex(config, /profile_id\s*=\s*"service-cloudflare-pg"[\s\S]*outer_authority\s*=\s*"cloudflare_durable_object"/, '.ores-lock.toml');
requireRegex(config, /\[profiles\.pg_advisory\][\s\S]*scope\s*=\s*"transaction"/, '.ores-lock.toml');

for (const [label, source] of [['rust', rust], ['typescript', ts], ['go', go], ['dart', dart]]) {
  requireRegex(source, /renew/i, `${label} maintained path`);
  requireRegex(source, /commit/i, `${label} maintained path`);
  requireRegex(source, /rollback/i, `${label} maintained path`);
}
requireRegex(rust, /final[\s_-]*renew/i, 'rust maintained path');
requireRegex(ts, /final[\s_-]*renew/i, 'typescript maintained path');
requireRegex(go, /final[\s_-]*renew/i, 'go maintained path');
requireRegex(dart, /final[\s_-]*renew/i, 'dart maintained path');

requireText(docs, vector.lock_key_shape, 'cloudflare service profile docs');
requireRegex(docs, /LockService[\s\S]*duplicate-trigger suppression/i, 'cloudflare service profile docs');
requireRegex(docs, /not[^\n]*fenced[^\n]*authority/i, 'cloudflare service profile docs');
for (const [language, example] of Object.entries(vector.runtime_key_examples)) {
  requireText(docs, example, `${language} lock-key example`);
}

console.log('Cloudflare DO + Postgres service profile conformance passed');
