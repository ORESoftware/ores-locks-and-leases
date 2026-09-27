import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const path =
  process.argv[2] ?? "conformance/cases/runtime-lifecycle-fencing.json";
const corpus = JSON.parse(await readFile(path, "utf8"));

assert.equal(
  corpus.schema,
  "ores.locks-and-leases.runtime-lifecycle-fencing-corpus/v1",
);
assert.equal(
  corpus.profile?.leaseKeyShape,
  "<product>/runtime-lifecycle/<environment>/<region>/<runtime-id>",
);

const requiredStates = new Set([
  "hot",
  "warm_idle",
  "hibernating",
  "hibernated",
  "resuming",
  "draining",
  "terminated",
]);
assert.ok(Array.isArray(corpus.profile?.states));
for (const state of requiredStates) {
  assert.ok(corpus.profile.states.includes(state), `missing lifecycle state ${state}`);
}

const dispositionByKind = new Map([
  ["advanced", "apply"],
  ["replay", "idempotent_noop"],
  ["stale", "reject_stale"],
  ["token_reuse", "reject_token_reuse"],
]);
const tokenPattern = /^(?:[1-9][0-9]{0,19})$/;
const digestPattern = /^[0-9a-f]{64}$/;

assert.ok(Array.isArray(corpus.cases) && corpus.cases.length >= 7);
const seenKinds = new Set();
let staleSameLocalIdentity = false;
let freshResume = false;
let replay = false;

for (const fixture of corpus.cases) {
  assert.equal(typeof fixture.name, "string");
  assert.ok(fixture.name.length > 0);
  assert.equal(typeof fixture.context?.transition, "string");
  assert.ok(Number.isSafeInteger(fixture.context?.runtimeEpoch));
  assert.ok(fixture.context.runtimeEpoch > 0);
  assert.ok(Number.isSafeInteger(fixture.context?.pid));
  assert.ok(fixture.context.pid > 0);

  const incoming = fixture.incoming;
  assert.equal(typeof incoming?.tenantScope, "string");
  assert.equal(typeof incoming?.resourceKey, "string");
  const parts = incoming.resourceKey.split("/");
  assert.equal(parts.length, 5, `${fixture.name}: lifecycle key component count`);
  assert.equal(parts[1], "runtime-lifecycle", `${fixture.name}: lifecycle key namespace`);
  assert.ok(parts.every((part) => part.length > 0 && part !== "." && part !== ".."));
  assert.ok(tokenPattern.test(incoming.fencingToken), `${fixture.name}: incoming token`);
  assert.ok(digestPattern.test(incoming.payloadSha256), `${fixture.name}: incoming digest`);

  if (fixture.current !== null) {
    assert.equal(
      fixture.current.tenantScope,
      incoming.tenantScope,
      `${fixture.name}: tenant scope changed inside one lifecycle watermark`,
    );
    assert.equal(
      fixture.current.resourceKey,
      incoming.resourceKey,
      `${fixture.name}: resource key changed inside one lifecycle watermark`,
    );
    assert.ok(tokenPattern.test(fixture.current.fencingToken), `${fixture.name}: current token`);
    assert.ok(digestPattern.test(fixture.current.payloadSha256), `${fixture.name}: current digest`);
  }

  assert.equal(fixture.expectedError, undefined);
  const kind = fixture.expected?.kind;
  assert.ok(dispositionByKind.has(kind), `${fixture.name}: unsupported fence kind ${kind}`);
  assert.equal(
    fixture.expectedLifecycleDisposition,
    dispositionByKind.get(kind),
    `${fixture.name}: lifecycle disposition drift`,
  );
  assert.equal(
    fixture.expected.shouldApply,
    kind === "advanced",
    `${fixture.name}: only a newer fence may apply a lifecycle mutation`,
  );
  seenKinds.add(kind);

  if (kind === "replay") replay = true;
  if (
    kind === "stale" &&
    fixture.context.sameLocalPidAsCheckpoint === true &&
    fixture.context.sameLocalRuntimeEpochAsCheckpoint === true
  ) {
    staleSameLocalIdentity = true;
  }
  if (
    kind === "advanced" &&
    fixture.context.transition === "resume" &&
    BigInt(incoming.fencingToken) > BigInt(fixture.current?.fencingToken ?? "0")
  ) {
    freshResume = true;
  }
}

for (const kind of dispositionByKind.keys()) {
  assert.ok(seenKinds.has(kind), `missing lifecycle fence kind ${kind}`);
}
assert.ok(replay, "missing idempotent lifecycle replay vector");
assert.ok(
  staleSameLocalIdentity,
  "missing stale-resume vector with unchanged local PID/runtime epoch",
);
assert.ok(freshResume, "missing fresh resume vector with a newer fencing token");

console.log(
  `runtime lifecycle fencing corpus ok: ${corpus.cases.length} cases, kinds=${[...seenKinds].sort().join(",")}`,
);
