# Runtime lifecycle fenced lease profile

BeamScale and Scintilla can use the shared `Lease` abstraction to coordinate
runtime hibernation and resume without depending on either product's future
lock service. Cloudflare Durable Objects are the initial distributed authority;
Fiducia can replace the provider later without changing the lifecycle rules.

## Lifecycle

The profile is:

`hot -> warm_idle -> hibernating -> hibernated -> resuming -> hot`

`draining` and `terminated` are escape states. A frozen process is not
hibernated: `SIGSTOP`/cgroup freeze can stop CPU consumption but does not
release the process's resident memory. RAM-reclaiming hibernation requires a
verified checkpoint/snapshot followed by process or VM teardown, or a clean
terminate-and-reconstruct path when no checkpoint adapter is safe.

The distributed lease key has the product-owned shape:

`<product>/runtime-lifecycle/<environment>/<region>/<runtime-id>`

The shared library treats the key as opaque. Product code owns canonical
runtime-id encoding and must not derive distributed authority from a local PID.

## Four distinct identities

Do not collapse these identities:

- **holder**: the host/controller identity currently talking to the authority;
- **request id**: one logical acquire/transition attempt, stable across retries;
- **fencing token**: monotonically increasing distributed mutation authority;
- **runtime epoch**: product lifecycle generation used to reject stale local
  control messages.

A holder retry can recover an already-committed acquire with the same request
id. That replay must be token-bound renewed before guarded work. A later
transition from the same holder uses a new request id and must not inherit the
older grant.

## Hibernation

A host may start hibernation only after local admission proves queue depth,
active request/invocation count, and in-flight capability work are zero and the
idle grace period has elapsed. It then acquires the distributed lifecycle lease
and **rechecks** those predicates after acquisition.

Before the checkpoint is allowed to become the recorded hibernated state:

1. enter a non-routable `hibernating` state;
2. maintain/renew the same fenced lease while checkpointing;
3. bind the checkpoint receipt to runtime epoch, deployment digest, checkpoint
   digest, holder/request identity, and fencing token;
4. verify the checkpoint;
5. atomically apply the lifecycle record through the fencing watermark;
6. only then tear down the VM/process/cgroup resources.

If renewal or transport becomes ambiguous during this sequence, fail closed.
The old process is not allowed to publish ready, acknowledge queue work, or
commit protected state merely because it is still alive.

## Resume

Resume is a **new logical transition** and therefore obtains a fresh request id
and a fresh lifecycle lease/fencing token. The controller validates the
checkpoint/runtime epoch/deployment identity, restores or reconstructs the
runtime, performs health/admission checks, and atomically advances the lifecycle
record through the fencing watermark before publishing readiness.

A resumed process can have the same local PID or the same persisted runtime
epoch as a previous checkpoint and still be stale. Local identity never
overrides the distributed watermark.

## Consumer fencing

`conformance/cases/runtime-lifecycle-fencing.json` projects lifecycle
transitions onto the existing `FenceDecision` state machine:

- a strictly newer token is `advanced` and may apply the lifecycle mutation;
- the same token + operation + payload is an idempotent `replay`;
- the same token with a different transition/payload is `token_reuse` and is
  rejected;
- an older token is `stale` and is rejected, even if PID/runtime epoch still
  match locally.

The lifecycle record and any datastore mutation that makes a runtime routable
must update the fencing watermark atomically. A checkpoint file by itself is
not distributed authority.

Run the profile check with:

```sh
node scripts/check-runtime-lifecycle-corpus.mjs
```

The normal Rust, TypeScript, Go, Dart, and Gleam fencing suites also consume the
same lifecycle corpus.
