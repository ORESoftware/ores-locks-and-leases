import test from "node:test";
import assert from "node:assert/strict";
import { LockError } from "../dist/errors.js";
import { DEFAULT_ACQUIRE_OPTIONS, withLease } from "../dist/lease.js";
import { withSessionLock } from "../dist/pg.js";

const key = "tests/cleanup/adapter-boundary";
const grant = { key, holder: "test-holder", fencingToken: 42n, ttlMs: 60_000 };

// A Promise-returning adapter is allowed to throw before returning a Promise.
// Keep these fakes non-async so that both runtime failure modes are exercised.
function fail(mode, error) {
  if (mode === "throw") throw error;
  return Promise.reject(error);
}

for (const mode of ["throw", "reject"]) {
  for (const workFails of [false, true]) {
    for (const structured of [false, true]) {
      test(`lease release ${mode}, workFails=${workFails}, structured=${structured}`, async () => {
        const workError = new Error("guarded work failed");
        const releaseError = structured
          ? LockError.transport(key, new Error("authority unavailable"))
          : new Error("authority unavailable");
        let releaseCalls = 0;
        const lease = {
          acquire: async () => grant,
          release(received) {
            assert.equal(received, grant);
            releaseCalls++;
            return fail(mode, releaseError);
          },
        };
        await assert.rejects(
          withLease(key, true, false, DEFAULT_ACQUIRE_OPTIONS, lease, async () => {
            if (workFails) throw workError;
            return "done";
          }),
          (error) => {
            assert.ok(error instanceof LockError);
            assert.equal(error.kind, "transport");
            assert.equal(error.step, "fiducia.release");
            assert.equal(error.retryable, false);
            if (workFails) {
              assert.equal(error.cause.inner.kind, "work");
              assert.equal(error.cause.inner.cause, workError);
              const cleanup = error.cause.cleanup;
              assert.equal(structured ? cleanup : cleanup.cause, releaseError);
            } else {
              assert.equal(structured ? error : error.cause, releaseError);
            }
            return true;
          },
        );
        assert.equal(releaseCalls, 1);
      });
    }

    for (const fiducia of [false, true]) {
      test(`session unlock ${mode}, workFails=${workFails}, fiducia=${fiducia}`, async () => {
        const workError = new Error("guarded work failed");
        const unlockError = new Error("unlock transport failed");
        const events = [];
        const client = {
          query(sql) {
            if (sql === "SELECT pg_advisory_unlock($1)") {
              events.push("unlock");
              return fail(mode, unlockError);
            }
            assert.equal(sql, "SELECT pg_try_advisory_lock($1)");
            events.push("lock");
            return Promise.resolve({ rows: [{ acquired: true }] });
          },
          release(poisoned) {
            events.push(["pool.release", poisoned]);
          },
        };
        const lease = {
          acquire: async () => grant,
          release: async () => {
            events.push("lease.release");
            return true;
          },
        };
        await assert.rejects(
          withSessionLock(key, { fiducia, pgAdvisory: true }, false,
            DEFAULT_ACQUIRE_OPTIONS, fiducia ? lease : undefined,
            { connect: async () => client }, async (guarded) => {
              assert.equal(guarded.client, client);
              events.push("work");
              if (workFails) throw workError;
              return "done";
            }),
          (error) => {
            assert.ok(error instanceof LockError);
            assert.equal(error.kind, "database");
            assert.equal(error.step, "pg.advisory_unlock");
            assert.equal(error.retryable, false);
            if (workFails) {
              assert.equal(error.cause.inner.cause, workError);
              assert.equal(error.cause.cleanup.cause, unlockError);
            } else {
              assert.equal(error.cause, unlockError);
            }
            return true;
          },
        );
        assert.deepEqual(events, ["lock", "work", "unlock", ["pool.release", true],
          ...(fiducia ? ["lease.release"] : [])]);
      });
    }
  }
}

test("healthy session cleanup returns the connection without poisoning it", async () => {
  const releases = [];
  const client = {
    query: async () => ({ rows: [{ ok: true }] }),
    release: (poisoned) => releases.push(poisoned),
  };
  assert.equal(await withSessionLock(key, { fiducia: false, pgAdvisory: true },
    false, DEFAULT_ACQUIRE_OPTIONS, undefined, { connect: async () => client },
    async () => "done"), "done");
  assert.deepEqual(releases, [false]);
});

test("release false retains lost-lease classification and the work error", async () => {
  const workError = new Error("work failed");
  await assert.rejects(withLease(key, true, false, DEFAULT_ACQUIRE_OPTIONS, {
    acquire: async () => grant,
    release: async () => false,
  }, async () => { throw workError; }), (error) => {
    assert.equal(error.kind, "lost_lease");
    assert.equal(error.step, "fiducia.release");
    assert.equal(error.cause.inner.cause, workError);
    return true;
  });
});
