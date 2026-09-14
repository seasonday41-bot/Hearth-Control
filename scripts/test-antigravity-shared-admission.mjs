// Focused tests for the shared X/Antigravity global execution-admission
// slot. Uses the REAL XClaimStore (a real temp hearth-runtime.sqlite per
// test), the REAL antigravity-admission.mjs module (which uses the REAL
// XLeaseKeeper for time-based renewal, unmodified), and the REAL
// taskRegistry/onTaskTransition/isTaskActivelyRunning wiring already
// registered by mcp/executors/antigravity.mjs at module load, for the two
// cases (15, 16) that exercise that fast-path integration.
//
// Deliberately does NOT spawn a real `agy` process or go through
// startAntigravityTask/resumeAntigravityTask's full CLI-spawn machinery --
// those are already covered by scripts/test-antigravity.mjs and friends.
// This file is scoped to admission itself: acquire/renew/release/ownership
// semantics against the real shared SQLite primitive.
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { XClaimStore } from '../mcp/x/claim-store.mjs';
import {
  acquireAntigravityAdmission,
  releaseAntigravityAdmission,
  hasAntigravityAdmission,
  antigravityClaimTaskId,
  __resetAntigravityAdmissionsForTests,
} from '../mcp/executors/antigravity-admission.mjs';
import {
  taskRegistry,
  emitTaskTransition,
  isTaskActivelyRunning,
} from '../mcp/executors/antigravity.mjs';

const dirs = [];
const stores = [];
const acquiredIds = new Set();

function tmpStorePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-ag-admission-'));
  dirs.push(dir);
  return path.join(dir, 'hearth-runtime.sqlite');
}

function makeStore(storagePath, opts = {}) {
  const store = new XClaimStore({ storagePath, ...opts });
  stores.push(store);
  return store;
}

/** Wraps acquireAntigravityAdmission, tracking taskId for afterEach cleanup. */
async function acquire(params) {
  const result = await acquireAntigravityAdmission(params);
  if (result.ok && result.record) acquiredIds.add(params.taskId);
  return result;
}

afterEach(async () => {
  for (const id of [...acquiredIds]) {
    await releaseAntigravityAdmission(id);
    acquiredIds.delete(id);
  }
  __resetAntigravityAdmissionsForTests();
  for (const taskId of [...taskRegistry.keys()]) {
    if (taskId.startsWith('ag-fastpath-')) taskRegistry.delete(taskId);
  }
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const alwaysActive = () => true;
const neverInvoked = () => { throw new Error('onOwnershipLost must not be called in this test'); };

// ── 1-4: cross-task-id, cross-store-instance global capacity=1 ─────────────

test('1 X active claim -> Antigravity admission denied', async () => {
  const storagePath = tmpStorePath();
  const claimStore = makeStore(storagePath);
  const xClaim = claimStore.claim({ taskId: 'x-task-1', ownerId: 'x-owner-1' });
  assert.ok(xClaim, 'X must be able to claim first');

  const result = await acquire({
    claimStore, taskId: 'ag-task-1', ownerId: 'ag-owner-1',
    isActive: alwaysActive, onOwnershipLost: neverInvoked,
  });
  assert.equal(result.ok, false, 'Antigravity admission must be denied while X holds the slot');
  assert.equal(result.record, null);
  assert.equal(hasAntigravityAdmission('ag-task-1'), false);
});

test('2 Antigravity active claim -> X claim denied', async () => {
  const storagePath = tmpStorePath();
  const claimStore = makeStore(storagePath);
  const result = await acquire({
    claimStore, taskId: 'ag-task-2', ownerId: 'ag-owner-2',
    isActive: alwaysActive, onOwnershipLost: neverInvoked,
  });
  assert.equal(result.ok, true);

  const xClaim = claimStore.claim({ taskId: 'x-task-2', ownerId: 'x-owner-2' });
  assert.equal(xClaim, null, 'X must be denied while Antigravity holds the slot');
});

test('3 different, unrelated task IDs still enforce global capacity=1', async () => {
  const storagePath = tmpStorePath();
  const claimStore = makeStore(storagePath);
  const xClaim = claimStore.claim({ taskId: 'totally-unrelated-x-id-777', ownerId: 'x-owner-3' });
  assert.ok(xClaim);

  const result = await acquire({
    claimStore, taskId: 'completely-different-ag-id-888', ownerId: 'ag-owner-3',
    isActive: alwaysActive, onOwnershipLost: neverInvoked,
  });
  assert.equal(result.ok, false, 'capacity=1 must hold across arbitrary, unrelated task IDs');
});

test('4 independent store instances against the same SQLite file cannot bypass admission', async () => {
  const storagePath = tmpStorePath();
  const storeA = makeStore(storagePath);
  const storeB = makeStore(storagePath);

  const result = await acquire({
    claimStore: storeA, taskId: 'ag-task-4', ownerId: 'ag-owner-4',
    isActive: alwaysActive, onOwnershipLost: neverInvoked,
  });
  assert.equal(result.ok, true);

  const xClaimViaB = storeB.claim({ taskId: 'x-task-4', ownerId: 'x-owner-4' });
  assert.equal(xClaimViaB, null, 'a second store instance on the same file must observe the same global lock');
});

// ── 5-6: renewal and normal release ─────────────────────────────────────────

test('5 Antigravity lease renews over time independently of task output', async () => {
  const storagePath = tmpStorePath();
  const claimStore = makeStore(storagePath);
  const taskId = 'ag-task-5';
  const result = await acquire({
    claimStore, taskId, ownerId: 'ag-owner-5',
    leaseDurationMs: 300, pollIntervalMs: 50000,
    isActive: alwaysActive, onOwnershipLost: neverInvoked,
  });
  assert.equal(result.ok, true);
  const original = claimStore.getActiveClaim(antigravityClaimTaskId(taskId));
  assert.ok(original);

  // No output/event is ever produced for this task -- isActive is a static
  // constant and nothing calls emitTaskTransition. Waiting well past the
  // original 300ms lease proves renewal is purely time-based (via
  // XLeaseKeeper, unmodified): without it the claim would already be gone.
  await sleep(800);

  const renewed = claimStore.getActiveClaim(antigravityClaimTaskId(taskId));
  assert.ok(renewed, 'claim must still be active past its original lease duration');
  assert.ok(renewed.leaseExpiresAt > original.leaseExpiresAt, 'lease must have been renewed forward in time');
  assert.equal(renewed.leaseId, original.leaseId, 'renewal must keep the same lease identity, not reclaim');
});

test('6 normal Antigravity release releases the exact original claim', async () => {
  const storagePath = tmpStorePath();
  const claimStore = makeStore(storagePath);
  const taskId = 'ag-task-6';
  const result = await acquire({
    claimStore, taskId, ownerId: 'ag-owner-6',
    isActive: alwaysActive, onOwnershipLost: neverInvoked,
  });
  const { leaseId } = result.record.claim;

  const released = await releaseAntigravityAdmission(taskId);
  acquiredIds.delete(taskId);
  assert.equal(released, true);

  const raw = claimStore.getRaw(antigravityClaimTaskId(taskId));
  assert.equal(raw.state, 'released');
  assert.equal(raw.leaseId, leaseId, 'the exact original lease must be the one marked released');
  assert.equal(claimStore.getActiveClaim(antigravityClaimTaskId(taskId)), null);
});

// ── 7: fencing ───────────────────────────────────────────────────────────

test('7 wrong owner / wrong lease cannot release another task\'s claim', async () => {
  const storagePath = tmpStorePath();
  const claimStore = makeStore(storagePath);
  const taskId = 'ag-task-7';
  const result = await acquire({
    claimStore, taskId, ownerId: 'ag-owner-7',
    isActive: alwaysActive, onOwnershipLost: neverInvoked,
  });
  const claimTaskId = antigravityClaimTaskId(taskId);

  const wrongOwner = claimStore.release({ taskId: claimTaskId, ownerId: 'intruder', leaseId: result.record.claim.leaseId });
  assert.equal(wrongOwner, false);
  const wrongLease = claimStore.release({ taskId: claimTaskId, ownerId: 'ag-owner-7', leaseId: 'not-the-real-lease' });
  assert.equal(wrongLease, false);

  const stillActive = claimStore.getActiveClaim(claimTaskId);
  assert.ok(stillActive, 'the real claim must remain active after fenced-off release attempts');
  assert.equal(stillActive.leaseId, result.record.claim.leaseId);
});

// ── 8-9: mutual release -> other side can acquire ───────────────────────────

test('8 released Antigravity claim allows X to acquire afterward', async () => {
  const storagePath = tmpStorePath();
  const claimStore = makeStore(storagePath);
  const taskId = 'ag-task-8';
  await acquire({
    claimStore, taskId, ownerId: 'ag-owner-8',
    isActive: alwaysActive, onOwnershipLost: neverInvoked,
  });
  await releaseAntigravityAdmission(taskId);
  acquiredIds.delete(taskId);

  const xClaim = claimStore.claim({ taskId: 'x-task-8', ownerId: 'x-owner-8' });
  assert.ok(xClaim, 'X must be able to claim once Antigravity releases');
});

test('9 released X claim allows Antigravity to acquire afterward', async () => {
  const storagePath = tmpStorePath();
  const claimStore = makeStore(storagePath);
  const xClaim = claimStore.claim({ taskId: 'x-task-9', ownerId: 'x-owner-9' });
  assert.ok(xClaim);
  const released = claimStore.release({ taskId: 'x-task-9', ownerId: 'x-owner-9', leaseId: xClaim.leaseId });
  assert.equal(released, true);

  const result = await acquire({
    claimStore, taskId: 'ag-task-9', ownerId: 'ag-owner-9',
    isActive: alwaysActive, onOwnershipLost: neverInvoked,
  });
  assert.equal(result.ok, true, 'Antigravity must be able to claim once X releases');
});

// ── 10: two Antigravity tasks, different IDs, cannot both run ──────────────

test('10 two Antigravity tasks with different task IDs cannot run concurrently', async () => {
  const storagePath = tmpStorePath();
  const claimStore = makeStore(storagePath);
  const first = await acquire({
    claimStore, taskId: 'ag-task-10a', ownerId: 'ag-owner-10a',
    isActive: alwaysActive, onOwnershipLost: neverInvoked,
  });
  assert.equal(first.ok, true);

  const second = await acquire({
    claimStore, taskId: 'ag-task-10b', ownerId: 'ag-owner-10b',
    isActive: alwaysActive, onOwnershipLost: neverInvoked,
  });
  assert.equal(second.ok, false, 'a second, independently-IDed Antigravity task must not also acquire the slot');
  assert.equal(hasAntigravityAdmission('ag-task-10b'), false);
});

// ── 11-12: ownership loss ───────────────────────────────────────────────────

test('11 ownership loss invokes onOwnershipLost exactly once', async () => {
  const storagePath = tmpStorePath();
  const storeA = makeStore(storagePath);
  const storeB = makeStore(storagePath);
  const taskId = 'ag-task-11';
  const claimTaskId = antigravityClaimTaskId(taskId);
  let lostCalls = 0;
  let lostTaskId = null;

  const result = await acquire({
    claimStore: storeA, taskId, ownerId: 'ag-owner-11',
    leaseDurationMs: 250, pollIntervalMs: 50000,
    isActive: alwaysActive,
    onOwnershipLost: (id) => { lostCalls += 1; lostTaskId = id; },
  });
  assert.equal(result.ok, true);

  // Force this row's lease into the past (without touching the keeper's own
  // in-memory state) so an independent store instance can legitimately
  // reclaim it -- simulating this process having gone unresponsive long
  // enough for its lease to genuinely lapse.
  storeA._getDb().prepare('UPDATE x_task_claims SET lease_expires_at = ? WHERE task_id = ?')
    .run(Date.now() - 1000, claimTaskId);
  const stolen = storeB.claim({ taskId: claimTaskId, ownerId: 'intruder-11', leaseDurationMs: 5000 });
  assert.ok(stolen, 'an independent store must be able to reclaim the now-expired lease');

  // The keeper's own scheduled renewal (~leaseDurationMs/3 from acquire) will
  // observe the reclaim and fail; give it time to fire and settle.
  await sleep(500);

  assert.equal(lostCalls, 1, 'onOwnershipLost must fire exactly once');
  assert.equal(lostTaskId, taskId);
  assert.equal(hasAntigravityAdmission(taskId), false, 'the local admission record must be cleared');
  acquiredIds.delete(taskId);
});

test('12 ownership loss does not release or reclaim another owner\'s lease', async () => {
  const storagePath = tmpStorePath();
  const storeA = makeStore(storagePath);
  const storeB = makeStore(storagePath);
  const taskId = 'ag-task-12';
  const claimTaskId = antigravityClaimTaskId(taskId);

  const result = await acquire({
    claimStore: storeA, taskId, ownerId: 'ag-owner-12',
    leaseDurationMs: 250, pollIntervalMs: 50000,
    isActive: alwaysActive,
    onOwnershipLost: () => {},
  });
  assert.equal(result.ok, true);

  storeA._getDb().prepare('UPDATE x_task_claims SET lease_expires_at = ? WHERE task_id = ?')
    .run(Date.now() - 1000, claimTaskId);
  const stolen = storeB.claim({ taskId: claimTaskId, ownerId: 'intruder-12', leaseDurationMs: 5000 });
  assert.ok(stolen);

  await sleep(500);

  const current = storeB.getActiveClaim(claimTaskId);
  assert.ok(current, 'the intruder\'s claim must remain active');
  assert.equal(current.ownerId, 'intruder-12');
  assert.equal(current.leaseId, stolen.leaseId, 'the original owner\'s ownership-loss handling must never touch the new owner\'s lease');
  acquiredIds.delete(taskId);
});

// ── 13: idempotent release ──────────────────────────────────────────────────

test('13 repeated release is safe and idempotent', async () => {
  const storagePath = tmpStorePath();
  const claimStore = makeStore(storagePath);
  const taskId = 'ag-task-13';
  await acquire({
    claimStore, taskId, ownerId: 'ag-owner-13',
    isActive: alwaysActive, onOwnershipLost: neverInvoked,
  });

  const first = await releaseAntigravityAdmission(taskId);
  const second = await releaseAntigravityAdmission(taskId);
  const third = await releaseAntigravityAdmission(taskId);
  acquiredIds.delete(taskId);

  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(third, true);
});

// ── 14: no-claimStore legacy compatibility ──────────────────────────────────

test('14 no-claimStore path remains a no-op (legacy-test compatibility)', async () => {
  const result = await acquireAntigravityAdmission({
    taskId: 'ag-task-14', ownerId: 'ag-owner-14',
    isActive: alwaysActive, onOwnershipLost: neverInvoked,
  });
  assert.deepEqual(result, { ok: true, record: null });
  assert.equal(hasAntigravityAdmission('ag-task-14'), false);
  const released = await releaseAntigravityAdmission('ag-task-14');
  assert.equal(released, true);
});

// ── 15-16: real antigravity.mjs onTaskTransition fast-path wiring ─────────

test('15 task transition to inactive releases admission promptly', async () => {
  const storagePath = tmpStorePath();
  const claimStore = makeStore(storagePath);
  const taskId = 'ag-fastpath-inactive';
  const result = await acquire({
    claimStore, taskId, ownerId: 'ag-owner-15',
    leaseDurationMs: 5000, pollIntervalMs: 50000,
    isActive: (id) => isTaskActivelyRunning(id),
    onOwnershipLost: neverInvoked,
  });
  assert.equal(result.ok, true);

  taskRegistry.set(taskId, { taskId, status: 'error', dismissed: false });
  emitTaskTransition(taskRegistry.get(taskId));
  // The listener's release is fire-and-forget async; give it a tick to settle.
  await sleep(50);

  assert.equal(hasAntigravityAdmission(taskId), false, 'an inactive-task transition must promptly release admission');
  acquiredIds.delete(taskId);
});

test('16 active task transition does NOT release admission', async () => {
  const storagePath = tmpStorePath();
  const claimStore = makeStore(storagePath);
  const taskId = 'ag-fastpath-active';
  const result = await acquire({
    claimStore, taskId, ownerId: 'ag-owner-16',
    leaseDurationMs: 5000, pollIntervalMs: 50000,
    isActive: (id) => isTaskActivelyRunning(id),
    onOwnershipLost: neverInvoked,
  });
  assert.equal(result.ok, true);

  taskRegistry.set(taskId, {
    taskId, status: 'running', dismissed: false,
    child: { killed: false, exitCode: null },
  });
  emitTaskTransition(taskRegistry.get(taskId));
  await sleep(50);

  assert.equal(hasAntigravityAdmission(taskId), true, 'a transition while the task is still active must not release admission');
});
