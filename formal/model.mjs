#!/usr/bin/env node

import fs from 'node:fs';

const MAX_TIME = 5;
const MAX_FENCE = 4;
const TTL = 2;
const CLIENTS = ['a', 'b'];
const VALUES = [1, 2];

function requireInvariant(condition, message, context = undefined) {
  if (!condition) {
    const suffix = context === undefined ? '' : `\ncontext=${JSON.stringify(context)}`;
    throw new Error(`model invariant failed: ${message}${suffix}`);
  }
}

function initialState() {
  return {
    now: 0,
    holder: null,
    holderAlive: false,
    leaseFence: 0,
    expiresAt: 0,
    lastFence: 0,
    tokens: { a: 0, b: 0 },
    resourceFence: 0,
    resourceValue: 0,
  };
}

function clone(state) {
  return { ...state, tokens: { ...state.tokens } };
}

function canonical(state) {
  return [
    state.now,
    state.holder ?? '-',
    Number(state.holderAlive),
    state.leaseFence,
    state.expiresAt,
    state.lastFence,
    state.tokens.a,
    state.tokens.b,
    state.resourceFence,
    state.resourceValue,
  ].join('|');
}

function isActive(state) {
  return state.holder !== null && state.holderAlive && state.now < state.expiresAt;
}

function expire(input) {
  const state = clone(input);
  if (state.holder !== null && state.now >= state.expiresAt) {
    state.holder = null;
    state.holderAlive = false;
    state.leaseFence = 0;
    state.expiresAt = 0;
  }
  return state;
}

function step(input, action) {
  const beforeAction = expire(input);
  const next = clone(beforeAction);
  let accepted = false;
  let reason = 'precondition';

  switch (action.kind) {
    case 'tick': {
      if (next.now < MAX_TIME) {
        next.now += 1;
        Object.assign(next, expire(next));
        accepted = true;
        reason = 'advanced';
      }
      break;
    }
    case 'acquire': {
      if (CLIENTS.includes(action.client) && next.holder === null && next.lastFence < MAX_FENCE) {
        next.lastFence += 1;
        next.leaseFence = next.lastFence;
        next.holder = action.client;
        next.holderAlive = true;
        next.expiresAt = Math.min(MAX_TIME + TTL, next.now + TTL);
        next.tokens[action.client] = next.leaseFence;
        accepted = true;
        reason = 'granted';
      }
      break;
    }
    case 'renew': {
      if (CLIENTS.includes(action.client) && isActive(next) && next.holder === action.client) {
        next.expiresAt = Math.min(MAX_TIME + TTL, next.expiresAt + 1);
        accepted = true;
        reason = 'renewed';
      }
      break;
    }
    case 'release': {
      if (
        CLIENTS.includes(action.client)
        && isActive(next)
        && next.holder === action.client
        && next.tokens[action.client] === next.leaseFence
      ) {
        next.holder = null;
        next.holderAlive = false;
        next.leaseFence = 0;
        next.expiresAt = 0;
        accepted = true;
        reason = 'released';
      }
      break;
    }
    case 'crash': {
      if (CLIENTS.includes(action.client) && next.holder === action.client && next.holderAlive) {
        next.holderAlive = false;
        accepted = true;
        reason = 'crashed';
      }
      break;
    }
    case 'write': {
      if (CLIENTS.includes(action.client) && VALUES.includes(action.value)) {
        const token = next.tokens[action.client];
        const ownsLiveLease = isActive(next)
          && next.holder === action.client
          && token === next.leaseFence;
        const fresh = token > next.resourceFence;
        const exactReplay = token === next.resourceFence && action.value === next.resourceValue;
        if (ownsLiveLease && (fresh || exactReplay)) {
          next.resourceFence = token;
          next.resourceValue = action.value;
          accepted = true;
          reason = exactReplay ? 'replayed' : 'committed';
        } else if (token === next.resourceFence && action.value !== next.resourceValue) {
          reason = 'ambiguous-token-reuse';
        } else if (token < next.resourceFence) {
          reason = 'stale-fence';
        }
      }
      break;
    }
    default:
      reason = 'unknown-action';
  }

  const transition = { action, beforeAction, next, accepted, reason };
  assertState(next);
  assertTransition(input, transition);
  return transition;
}

function assertState(state) {
  requireInvariant(Number.isInteger(state.now) && state.now >= 0 && state.now <= MAX_TIME, 'time is bounded', state);
  requireInvariant(Number.isInteger(state.lastFence) && state.lastFence >= 0 && state.lastFence <= MAX_FENCE, 'minted fence is bounded', state);
  requireInvariant(state.resourceFence >= 0 && state.resourceFence <= state.lastFence, 'resource fence cannot exceed minted fence', state);
  requireInvariant(state.tokens.a >= 0 && state.tokens.a <= state.lastFence, 'client A token is in range', state);
  requireInvariant(state.tokens.b >= 0 && state.tokens.b <= state.lastFence, 'client B token is in range', state);
  if (state.holder === null) {
    requireInvariant(state.leaseFence === 0 && state.expiresAt === 0 && !state.holderAlive, 'free lease has no live grant metadata', state);
  } else {
    requireInvariant(CLIENTS.includes(state.holder), 'holder is known', state);
    requireInvariant(state.leaseFence > 0 && state.leaseFence === state.lastFence, 'active grant carries the newest fence', state);
    requireInvariant(state.tokens[state.holder] === state.leaseFence, 'holder token matches authority grant', state);
  }
}

function assertTransition(original, transition) {
  const { action, beforeAction, next, accepted } = transition;
  requireInvariant(next.lastFence >= original.lastFence, 'fencing tokens never regress', transition);
  requireInvariant(next.resourceFence >= original.resourceFence, 'committed resource fence never regresses', transition);

  if (action.kind === 'acquire' && accepted) {
    requireInvariant(next.lastFence === beforeAction.lastFence + 1, 'each grant mints exactly one newer fence', transition);
  }
  if (action.kind === 'renew' && accepted) {
    requireInvariant(next.leaseFence === beforeAction.leaseFence, 'renewal never mints a new fence', transition);
  }
  if (action.kind === 'crash' && accepted) {
    requireInvariant(next.holder === beforeAction.holder && next.expiresAt === beforeAction.expiresAt, 'crash cannot release or extend the authority grant', transition);
  }
  if (action.kind === 'write') {
    if (accepted) {
      const token = beforeAction.tokens[action.client];
      requireInvariant(isActive(beforeAction), 'write requires a live lease', transition);
      requireInvariant(beforeAction.holder === action.client && token === beforeAction.leaseFence, 'writer must own the live grant', transition);
      requireInvariant(
        token > beforeAction.resourceFence
          || (token === beforeAction.resourceFence && action.value === beforeAction.resourceValue),
        'write accepts only a fresh fence or exact replay',
        transition,
      );
      requireInvariant(next.resourceFence === token, 'accepted write persists its fence', transition);
    } else {
      requireInvariant(next.resourceFence === beforeAction.resourceFence && next.resourceValue === beforeAction.resourceValue, 'rejected write is side-effect free', transition);
    }
  }
  if (
    beforeAction.holder !== null
    && !beforeAction.holderAlive
    && beforeAction.now < beforeAction.expiresAt
    && action.kind === 'acquire'
  ) {
    requireInvariant(!accepted, 'process crash does not prematurely free a grant', transition);
  }
}

function allActions() {
  const actions = [{ kind: 'tick' }];
  for (const client of CLIENTS) {
    actions.push(
      { kind: 'acquire', client },
      { kind: 'renew', client },
      { kind: 'release', client },
      { kind: 'crash', client },
      ...VALUES.map((value) => ({ kind: 'write', client, value })),
    );
  }
  return actions;
}

function explicitWitnesses() {
  let state = initialState();
  const firstGrant = step(state, { kind: 'acquire', client: 'a' });
  requireInvariant(firstGrant.accepted, 'A acquires initial lease');
  state = firstGrant.next;
  const firstWrite = step(state, { kind: 'write', client: 'a', value: 1 });
  requireInvariant(firstWrite.accepted, 'A writes under initial fence');
  state = step(firstWrite.next, { kind: 'crash', client: 'a' }).next;
  requireInvariant(!step(state, { kind: 'acquire', client: 'b' }).accepted, 'B cannot acquire before crashed lease expires');
  state = step(step(state, { kind: 'tick' }).next, { kind: 'tick' }).next;
  const successor = step(state, { kind: 'acquire', client: 'b' });
  requireInvariant(successor.accepted && successor.next.leaseFence > firstGrant.next.leaseFence, 'successor receives a newer fence');
  requireInvariant(!step(successor.next, { kind: 'write', client: 'a', value: 2 }).accepted, 'stale leader is rejected');
  const commit = step(successor.next, { kind: 'write', client: 'b', value: 2 });
  requireInvariant(commit.accepted, 'successor write commits');
  const replay = step(commit.next, { kind: 'write', client: 'b', value: 2 });
  requireInvariant(replay.accepted && canonical(replay.next) === canonical(commit.next), 'exact retry is idempotent');
  requireInvariant(!step(commit.next, { kind: 'write', client: 'b', value: 1 }).accepted, 'same token with different payload fails closed');
}

function explore() {
  explicitWitnesses();
  const initial = initialState();
  const seen = new Map([[canonical(initial), initial]]);
  const queue = [initial];
  let index = 0;
  let transitions = 0;
  let accepted = 0;
  let rejected = 0;
  while (index < queue.length) {
    const state = queue[index++];
    assertState(state);
    for (const action of allActions()) {
      const transition = step(state, action);
      transitions += 1;
      if (transition.accepted) {
        accepted += 1;
        const key = canonical(transition.next);
        if (!seen.has(key)) {
          seen.set(key, transition.next);
          queue.push(transition.next);
        }
      } else {
        rejected += 1;
      }
    }
  }
  console.log(JSON.stringify({
    model: 'ores-locks-and-leases/fencing-v1',
    claim: 'finite-exhaustive-abstraction',
    bounds: { maxTime: MAX_TIME, maxFence: MAX_FENCE, ttl: TTL, clients: CLIENTS.length, values: VALUES.length },
    states: seen.size,
    transitions,
    accepted,
    rejected,
    invariants: [
      'exclusive-live-holder',
      'monotonic-fencing-token',
      'renew-preserves-fence',
      'crash-does-not-release',
      'stale-writer-rejected',
      'exact-replay-idempotent',
      'ambiguous-token-reuse-rejected',
    ],
  }));
}

function replayLine(document) {
  requireInvariant(document && Array.isArray(document.actions), 'replay input must contain an actions array', document);
  let state = initialState();
  const outcomes = [];
  for (const action of document.actions) {
    const transition = step(state, action);
    outcomes.push({ accepted: transition.accepted, reason: transition.reason });
    state = transition.next;
  }
  return { ok: true, state, outcomes };
}

if (process.argv.includes('--json-stdin')) {
  const input = fs.readFileSync(0, 'utf8');
  for (const line of input.split(/\r?\n/).filter((value) => value.trim() !== '')) {
    try {
      console.log(JSON.stringify(replayLine(JSON.parse(line))));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
      process.exitCode = 1;
    }
  }
} else {
  explore();
}
