#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

const MAX_PERIODIC_RENEWALS = 2;
const MAX_CONTENTION_RETRIES = 2;

const CLEANUP_FAILURES = new Set([
  "pg.rollback_failed",
  "fiducia.release_failed",
  "fiducia.release_mismatch",
]);

function initialState() {
  return {
    phase: "acquire",
    acquired: false,
    begun: false,
    locked: false,
    workCompleted: false,
    finalRenewAttempted: false,
    finalRenewed: false,
    commitAttempted: false,
    committed: false,
    rollbackAttempted: false,
    rolledBack: false,
    releaseAttempts: 0,
    released: false,
    authorityLive: false,
    authorityLost: false,
    authorityLostBeforeCommit: false,
    periodicRenewals: 0,
    contentionRetries: 0,
    primaryFailure: null,
    failures: [],
    result: null,
  };
}

function clone(state, patch = {}) {
  return {
    ...state,
    failures: [...state.failures],
    ...patch,
  };
}

function recordFailure(state, code, { cleanup = false } = {}) {
  const next = clone(state);
  next.failures.push(code);
  if (cleanup || next.primaryFailure === null) next.primaryFailure = code;
  return next;
}

function loseAuthority(state, code) {
  return recordFailure(
    clone(state, {
      authorityLive: false,
      authorityLost: true,
      authorityLostBeforeCommit: !state.commitAttempted && !state.committed,
    }),
    code,
  );
}

function transition(name, state) {
  return { name, state };
}

function successors(state, { requireFinalRenewal }) {
  switch (state.phase) {
    case "acquire":
      return [
        transition(
          "acquire.success",
          clone(state, {
            phase: "begin",
            acquired: true,
            authorityLive: true,
          }),
        ),
        transition(
          "acquire.failure",
          recordFailure(clone(state, { phase: "done", result: "error" }), "fiducia.acquire_failed"),
        ),
      ];

    case "begin": {
      const next = [
        transition(
          "pg.begin.success",
          clone(state, { phase: "lock", begun: true }),
        ),
        transition(
          "pg.begin.failure",
          recordFailure(clone(state, { phase: "release" }), "pg.begin_failed"),
        ),
        transition(
          "periodic_renew.failure",
          clone(loseAuthority(state, "fiducia.periodic_renew_failed"), { phase: "release" }),
        ),
        transition(
          "periodic_renew.token_drift",
          clone(loseAuthority(state, "fiducia.periodic_token_changed"), { phase: "release" }),
        ),
      ];
      if (state.periodicRenewals < MAX_PERIODIC_RENEWALS) {
        next.push(
          transition(
            "periodic_renew.success",
            clone(state, { periodicRenewals: state.periodicRenewals + 1 }),
          ),
        );
      }
      return next;
    }

    case "lock": {
      const next = [
        transition(
          "pg.lock.success",
          clone(state, { phase: "work", locked: true }),
        ),
        transition(
          "pg.lock.database_failure",
          recordFailure(clone(state, { phase: "rollback" }), "pg.lock_failed"),
        ),
        transition(
          "pg.lock.timeout",
          recordFailure(clone(state, { phase: "rollback" }), "pg.lock_timeout"),
        ),
        transition(
          "periodic_renew.failure",
          clone(loseAuthority(state, "fiducia.periodic_renew_failed"), { phase: "rollback" }),
        ),
        transition(
          "periodic_renew.token_drift",
          clone(loseAuthority(state, "fiducia.periodic_token_changed"), { phase: "rollback" }),
        ),
      ];
      if (state.contentionRetries < MAX_CONTENTION_RETRIES) {
        next.push(
          transition(
            "pg.lock.contention_retry",
            clone(state, { contentionRetries: state.contentionRetries + 1 }),
          ),
        );
      }
      if (state.periodicRenewals < MAX_PERIODIC_RENEWALS) {
        next.push(
          transition(
            "periodic_renew.success",
            clone(state, { periodicRenewals: state.periodicRenewals + 1 }),
          ),
        );
      }
      return next;
    }

    case "work": {
      const successPhase = requireFinalRenewal ? "final_renew" : "commit";
      const next = [
        transition(
          "work.success",
          clone(state, {
            phase: successPhase,
            workCompleted: true,
          }),
        ),
        transition(
          "work.failure",
          recordFailure(clone(state, { phase: "rollback" }), "work.failed"),
        ),
        transition(
          "periodic_renew.failure",
          clone(loseAuthority(state, "fiducia.periodic_renew_failed"), { phase: "rollback" }),
        ),
        transition(
          "periodic_renew.token_drift",
          clone(loseAuthority(state, "fiducia.periodic_token_changed"), { phase: "rollback" }),
        ),
      ];
      if (state.periodicRenewals < MAX_PERIODIC_RENEWALS) {
        next.push(
          transition(
            "periodic_renew.success",
            clone(state, { periodicRenewals: state.periodicRenewals + 1 }),
          ),
        );
      }
      return next;
    }

    case "final_renew":
      return [
        transition(
          "final_renew.success",
          clone(state, {
            phase: "commit",
            finalRenewAttempted: true,
            finalRenewed: true,
          }),
        ),
        transition(
          "final_renew.failure",
          clone(
            loseAuthority(
              clone(state, { finalRenewAttempted: true }),
              "fiducia.final_renew_failed",
            ),
            { phase: "rollback" },
          ),
        ),
        transition(
          "final_renew.token_drift",
          clone(
            loseAuthority(
              clone(state, { finalRenewAttempted: true }),
              "fiducia.final_token_changed",
            ),
            { phase: "rollback" },
          ),
        ),
      ];

    case "commit":
      return [
        transition(
          "pg.commit.success",
          clone(state, {
            phase: "release",
            commitAttempted: true,
            committed: true,
          }),
        ),
        transition(
          "pg.commit.failure",
          recordFailure(
            clone(state, {
              phase: "release",
              commitAttempted: true,
            }),
            "pg.commit_failed",
          ),
        ),
      ];

    case "rollback":
      return [
        transition(
          "pg.rollback.success",
          clone(state, {
            phase: "release",
            rollbackAttempted: true,
            rolledBack: true,
          }),
        ),
        transition(
          "pg.rollback.failure",
          recordFailure(
            clone(state, {
              phase: "release",
              rollbackAttempted: true,
            }),
            "pg.rollback_failed",
            { cleanup: true },
          ),
        ),
      ];

    case "release":
      return [
        transition(
          "fiducia.release.success",
          clone(state, {
            phase: "done",
            releaseAttempts: state.releaseAttempts + 1,
            released: true,
            authorityLive: false,
            result: state.primaryFailure === null && state.committed ? "success" : "error",
          }),
        ),
        transition(
          "fiducia.release.mismatch",
          recordFailure(
            clone(state, {
              phase: "done",
              releaseAttempts: state.releaseAttempts + 1,
              authorityLive: false,
              authorityLost: true,
              result: "error",
            }),
            "fiducia.release_mismatch",
            { cleanup: true },
          ),
        ),
        transition(
          "fiducia.release.failure",
          recordFailure(
            clone(state, {
              phase: "done",
              releaseAttempts: state.releaseAttempts + 1,
              authorityLive: false,
              result: "error",
            }),
            "fiducia.release_failed",
            { cleanup: true },
          ),
        ),
      ];

    case "done":
      return [];

    default:
      throw new Error(`unknown phase: ${state.phase}`);
  }
}

function stateKey(state) {
  return JSON.stringify(state);
}

function assertState(state, { requireFinalRenewal }) {
  const fail = (message) => {
    const error = new Error(message);
    error.state = state;
    throw error;
  };

  if (state.committed) {
    if (!state.acquired || !state.begun || !state.locked || !state.workCompleted) {
      fail("commit occurred without acquire, begin, lock, and successful work");
    }
    if (requireFinalRenewal && (!state.finalRenewAttempted || !state.finalRenewed)) {
      fail("commit occurred without mandatory final renewal");
    }
    if (state.authorityLostBeforeCommit) fail("commit occurred after authority loss");
  }

  if (state.commitAttempted && state.rollbackAttempted) {
    fail("commit and rollback were both attempted on one transaction path");
  }
  if (state.rolledBack && !state.rollbackAttempted) {
    fail("rollback completed without a rollback attempt");
  }
  if (state.releaseAttempts > 1) fail("lease release was attempted more than once");
  if (!state.acquired && state.releaseAttempts !== 0) {
    fail("release was attempted after acquisition failed");
  }
  if (state.phase === "done" && state.acquired && state.releaseAttempts !== 1) {
    fail("an acquired terminal path did not attempt release exactly once");
  }
  if (state.result === "success") {
    if (!state.committed || !state.released || state.primaryFailure !== null) {
      fail("successful return lacked commit, release, or a clean failure state");
    }
  }
  if (state.authorityLost && state.authorityLive) {
    fail("lost authority became live again");
  }
  if (state.primaryFailure !== null && !state.failures.includes(state.primaryFailure)) {
    fail("primary failure was not retained in diagnostics");
  }

  const cleanupFailures = state.failures.filter((code) => CLEANUP_FAILURES.has(code));
  if (cleanupFailures.length > 0) {
    const expectedPrimary = cleanupFailures.at(-1);
    if (state.primaryFailure !== expectedPrimary) {
      fail(`cleanup failure ${expectedPrimary} did not remain primary`);
    }
  }
}

function explore({ requireFinalRenewal }) {
  const start = initialState();
  const queue = [{ state: start, trace: [] }];
  const visited = new Map([[stateKey(start), { state: start, trace: [] }]]);
  const terminals = [];
  let transitionCount = 0;

  while (queue.length > 0) {
    const current = queue.shift();
    assertState(current.state, { requireFinalRenewal });
    const next = successors(current.state, { requireFinalRenewal });
    transitionCount += next.length;
    if (next.length === 0) {
      terminals.push(current);
      continue;
    }

    for (const edge of next) {
      const trace = [...current.trace, edge.name];
      assertState(edge.state, { requireFinalRenewal });
      const key = stateKey(edge.state);
      if (!visited.has(key)) {
        const item = { state: edge.state, trace };
        visited.set(key, item);
        queue.push(item);
      }
    }
  }

  return {
    states: [...visited.values()],
    terminals,
    transitionCount,
  };
}

function verifyProductionModel(model) {
  const success = model.terminals.filter(({ state }) => state.result === "success");
  const errors = model.terminals.filter(({ state }) => state.result === "error");
  if (success.length === 0) throw new Error("model has no successful terminal path");
  if (errors.length === 0) throw new Error("model has no failing terminal path");

  const expectedFailures = new Set([
    "fiducia.acquire_failed",
    "fiducia.periodic_renew_failed",
    "fiducia.periodic_token_changed",
    "fiducia.final_renew_failed",
    "fiducia.final_token_changed",
    "pg.begin_failed",
    "pg.lock_failed",
    "pg.lock_timeout",
    "work.failed",
    "pg.commit_failed",
    "pg.rollback_failed",
    "fiducia.release_mismatch",
    "fiducia.release_failed",
  ]);
  const observedFailures = new Set(
    model.terminals.flatMap(({ state }) => state.failures),
  );
  for (const code of expectedFailures) {
    if (!observedFailures.has(code)) {
      throw new Error(`failure class was not reachable: ${code}`);
    }
  }

  for (const { state } of success) {
    if (!state.finalRenewAttempted || !state.finalRenewed) {
      throw new Error("successful terminal path bypassed final renewal");
    }
  }

  return {
    successfulTerminals: success.length,
    errorTerminals: errors.length,
    observedFailures: [...observedFailures].sort(),
  };
}

function findNegativeControlWitness(model) {
  return model.terminals.find(
    ({ state }) =>
      state.result === "success" &&
      state.committed &&
      !state.finalRenewAttempted &&
      !state.finalRenewed,
  );
}

function parseArgs(argv) {
  const args = { receipt: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--receipt") {
      const path = argv[index + 1];
      if (!path) throw new Error("--receipt requires a path");
      args.receipt = resolve(path);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${value}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const production = explore({ requireFinalRenewal: true });
  const coverage = verifyProductionModel(production);
  const negative = explore({ requireFinalRenewal: false });
  const witness = findNegativeControlWitness(negative);
  if (!witness) {
    throw new Error("negative control failed to witness commit without final renewal");
  }

  const receipt = {
    schema: "ores.locks.maintained-transaction-model/v1",
    revision: process.env.GITHUB_SHA ?? null,
    bounds: {
      maxPeriodicRenewals: MAX_PERIODIC_RENEWALS,
      maxContentionRetries: MAX_CONTENTION_RETRIES,
    },
    production: {
      states: production.states.length,
      transitions: production.transitionCount,
      terminals: production.terminals.length,
      successfulTerminals: coverage.successfulTerminals,
      errorTerminals: coverage.errorTerminals,
      observedFailures: coverage.observedFailures,
    },
    invariants: {
      commitRequiresAcquireBeginLockAndWork: true,
      commitRequiresFinalRenewal: true,
      authorityLossPreventsCommit: true,
      commitAndRollbackAreExclusive: true,
      acquiredPathsReleaseExactlyOnce: true,
      acquisitionFailureDoesNotRelease: true,
      cleanupFailureIsPrimaryAndRetainsInnerFailure: true,
      terminalStatesHaveNoSuccessors: true,
    },
    negativeControl: {
      finalRenewalDisabled: true,
      unsafeCommitWitnessed: true,
      trace: witness.trace,
    },
    assumptions: [
      "the final renewal completes immediately before the PostgreSQL commit call",
      "the datastore still atomically admits the unchanged fencing token with every protected mutation",
      "transport and database adapters report the documented failure classes",
      "periodic renewal and advisory-lock contention are bounded only for exhaustive enumeration, not as a liveness claim",
    ],
    result: "passed",
  };

  if (args.receipt) {
    await mkdir(dirname(args.receipt), { recursive: true });
    await writeFile(args.receipt, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

main().catch(async (error) => {
  const payload = {
    schema: "ores.locks.maintained-transaction-model/v1",
    result: "failed",
    message: error instanceof Error ? error.message : String(error),
    state: error && typeof error === "object" && "state" in error ? error.state : undefined,
  };
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.receipt) {
      await mkdir(dirname(args.receipt), { recursive: true });
      await writeFile(args.receipt, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    }
  } catch {
    // The original failure remains primary; argument errors are already
    // represented by the payload above when parsing happened in main().
  }
  process.stderr.write(`${JSON.stringify(payload)}\n`);
  process.exitCode = 1;
});
