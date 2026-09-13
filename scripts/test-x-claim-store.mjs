import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { XClaimStore } from '../mcp/x/claim-store.mjs';
import { TaskStore } from '../mcp/executors/task-store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const raceWorkerPath = path.join(__dirname, 'x-claim-race-worker.mjs');

const dirs = [];
const stores = [];
function tmpStorePath(name = 'claims.sqlite') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-x-claims-'));
  dirs.push(dir);
  return path.join(dir, name);
}
function makeStore(storagePath, opts = {}) {
  const store = new XClaimStore({ storagePath, ...opts });
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function spawnRaceWorker(storagePath, taskId, ownerId, leaseDurationMs = 5000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [raceWorkerPath, storagePath, taskId, ownerId, String(leaseDurationMs)]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`race worker exited ${code}: ${stderr}`));
      try { resolve(JSON.parse(stdout)); }
      catch (err) { reject(new Error(`race worker produced invalid JSON: ${stdout} (${err.message})`)); }
    });
  });
}

test('C1 single task claim succeeds and reports full lease shape', () => {
  const store = makeStore(tmpStorePath());
  const claim = store.claim({ taskId: 'task-a', ownerId: 'owner-1' });
  assert.ok(claim);
  assert.equal(claim.taskId, 'task-a');
  assert.equal(claim.ownerId, 'owner-1');
  assert.equal(claim.attempt, 1);
  assert.equal(claim.state, 'active');
  assert.ok(claim.leaseId);
  assert.ok(claim.leaseExpiresAt > claim.claimedAt);
});

test('C2 same task double claim: only one winner', () => {
  const store = makeStore(tmpStorePath());
  const first = store.claim({ taskId: 'task-a', ownerId: 'owner-1' });
  const second = store.claim({ taskId: 'task-a', ownerId: 'owner-2' });
  assert.ok(first);
  assert.equal(second, null);
  assert.equal(store.getActiveClaim('task-a').ownerId, 'owner-1');
});

test('C3 second distinct task cannot claim while global slot is held', () => {
  const store = makeStore(tmpStorePath());
  const first = store.claim({ taskId: 'task-a', ownerId: 'owner-1' });
  const second = store.claim({ taskId: 'task-b', ownerId: 'owner-2' });
  assert.ok(first);
  assert.equal(second, null);
});

test('C4 renewal by current owner succeeds and extends the lease', async () => {
  const store = makeStore(tmpStorePath(), { leaseDurationMs: 200 });
  const claim = store.claim({ taskId: 'task-a', ownerId: 'owner-1' });
  await sleep(20);
  const renewed = store.renew({ taskId: 'task-a', ownerId: 'owner-1', leaseId: claim.leaseId });
  assert.ok(renewed);
  assert.equal(renewed.leaseId, claim.leaseId);
  assert.ok(renewed.leaseExpiresAt >= claim.leaseExpiresAt);
});

test('C5 renewal by wrong owner or stale lease id fails', () => {
  const store = makeStore(tmpStorePath());
  const claim = store.claim({ taskId: 'task-a', ownerId: 'owner-1' });
  assert.equal(store.renew({ taskId: 'task-a', ownerId: 'owner-2', leaseId: claim.leaseId }), null);
  assert.equal(store.renew({ taskId: 'task-a', ownerId: 'owner-1', leaseId: 'not-the-lease' }), null);
});

test('C6 expired lease can be reclaimed, and reclaim mints a new lease identity', async () => {
  const store = makeStore(tmpStorePath(), { leaseDurationMs: 20 });
  const first = store.claim({ taskId: 'task-a', ownerId: 'owner-1' });
  await sleep(60);
  const reclaimed = store.claim({ taskId: 'task-a', ownerId: 'owner-2' });
  assert.ok(reclaimed);
  assert.notEqual(reclaimed.leaseId, first.leaseId);
  assert.equal(reclaimed.ownerId, 'owner-2');
  assert.equal(reclaimed.attempt, first.attempt + 1);
});

test('C7 stale owner cannot release or renew a reclaimed lease (fencing)', async () => {
  const store = makeStore(tmpStorePath(), { leaseDurationMs: 20 });
  const first = store.claim({ taskId: 'task-a', ownerId: 'owner-1' });
  await sleep(60);
  const reclaimed = store.claim({ taskId: 'task-a', ownerId: 'owner-2' });
  assert.ok(reclaimed);

  assert.equal(store.release({ taskId: 'task-a', ownerId: 'owner-1', leaseId: first.leaseId }), false);
  assert.equal(store.renew({ taskId: 'task-a', ownerId: 'owner-1', leaseId: first.leaseId }), null);
  // current owner's claim must be untouched by the stale owner's attempts
  assert.equal(store.getActiveClaim('task-a').leaseId, reclaimed.leaseId);
});

test('C8 current owner release succeeds and frees the global slot', () => {
  const store = makeStore(tmpStorePath());
  const claim = store.claim({ taskId: 'task-a', ownerId: 'owner-1' });
  assert.equal(store.release({ taskId: 'task-a', ownerId: 'owner-1', leaseId: claim.leaseId }), true);
  assert.equal(store.getActiveClaim('task-a'), null);
  assert.equal(store.getActiveClaim(), null);
});

test('C9 repeated safe release by the same already-released owner is idempotent', () => {
  const store = makeStore(tmpStorePath());
  const claim = store.claim({ taskId: 'task-a', ownerId: 'owner-1' });
  assert.equal(store.release({ taskId: 'task-a', ownerId: 'owner-1', leaseId: claim.leaseId }), true);
  assert.equal(store.release({ taskId: 'task-a', ownerId: 'owner-1', leaseId: claim.leaseId }), true);
});

test('C10 a released (review-like) task no longer blocks the next independent task', () => {
  const store = makeStore(tmpStorePath());
  const claimB = store.claim({ taskId: 'task-b', ownerId: 'owner-1' });
  assert.ok(claimB);
  assert.equal(store.release({ taskId: 'task-b', ownerId: 'owner-1', leaseId: claimB.leaseId }), true);
  const claimC = store.claim({ taskId: 'task-c', ownerId: 'owner-2' });
  assert.ok(claimC);
  assert.equal(store.getActiveClaim().taskId, 'task-c');
});

test('C11 restart/reopen preserves active lease truth (not an in-memory Map)', () => {
  const storagePath = tmpStorePath();
  const storeA = makeStore(storagePath);
  const claim = storeA.claim({ taskId: 'task-a', ownerId: 'owner-1' });
  storeA.close();

  const storeB = makeStore(storagePath);
  const persisted = storeB.getActiveClaim('task-a');
  assert.ok(persisted);
  assert.equal(persisted.leaseId, claim.leaseId);
  assert.equal(storeB.claim({ taskId: 'task-a', ownerId: 'owner-2' }), null);
  assert.equal(storeB.claim({ taskId: 'task-b', ownerId: 'owner-2' }), null);
});

test('C12 expired lease after restart can be reclaimed safely', async () => {
  const storagePath = tmpStorePath();
  const storeA = makeStore(storagePath, { leaseDurationMs: 20 });
  const first = storeA.claim({ taskId: 'task-a', ownerId: 'owner-1' });
  storeA.close();
  await sleep(60);

  const storeB = makeStore(storagePath);
  const reclaimed = storeB.claim({ taskId: 'task-a', ownerId: 'owner-2' });
  assert.ok(reclaimed);
  assert.notEqual(reclaimed.leaseId, first.leaseId);
  assert.equal(reclaimed.ownerId, 'owner-2');
});

test('C13 X task claim table is isolated from the Antigravity continuation claim table', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-x-claims-'));
  dirs.push(dir);
  const claimStore = makeStore(path.join(dir, 'x-claims.sqlite'));
  const taskStore = new TaskStore({ storagePath: path.join(dir, 'tasks.json') });

  const sharedId = 'shared-id-1';
  taskStore.saveTask({
    taskId: sharedId, conversationId: 'conv-1', workspace: dir, source: 'local',
    status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  const continuationClaim = taskStore.claimContinuation({ taskId: sharedId, jobId: 'job-1', evidence: { taskId: sharedId, jobId: 'job-1' } });
  const xClaim = claimStore.claim({ taskId: sharedId, ownerId: 'owner-1' });

  assert.ok(continuationClaim, 'continuation claim must succeed independently of the X claim store');
  assert.ok(xClaim, 'X claim must succeed independently of the continuation claim store');
  assert.notEqual(fs.realpathSync(claimStore.storagePath), fs.realpathSync(`${taskStore.storagePath}.continuations.sqlite`));

  taskStore.continuationDb?.close();
});

test('C14 release is not completion: no completed/failed state is introduced by this store', () => {
  const store = makeStore(tmpStorePath());
  const claim = store.claim({ taskId: 'task-a', ownerId: 'owner-1' });
  store.release({ taskId: 'task-a', ownerId: 'owner-1', leaseId: claim.leaseId });
  const raw = store.getRaw('task-a');
  assert.ok(['active', 'released'].includes(raw.state));
  assert.notEqual(raw.state, 'completed');
  assert.notEqual(raw.state, 'failed');
  assert.notEqual(raw.state, 'done');
});

test('C15 real cross-process race: N workers claiming the same task, exactly one winner', async () => {
  const storagePath = tmpStorePath();
  const workerCount = 8;
  const results = await Promise.all(
    Array.from({ length: workerCount }, (_, i) => spawnRaceWorker(storagePath, 'task-shared', `owner-${i}`)),
  );
  const winners = results.filter((r) => r.claimed);
  assert.equal(winners.length, 1, JSON.stringify(results));
});

test('C16 real cross-process race: two distinct tasks competing for the single global slot, exactly one winner', async () => {
  const storagePath = tmpStorePath();
  const workerCount = 8;
  const results = await Promise.all(
    Array.from({ length: workerCount }, (_, i) =>
      spawnRaceWorker(storagePath, i % 2 === 0 ? 'task-x' : 'task-y', `owner-${i}`)),
  );
  const winners = results.filter((r) => r.claimed);
  assert.equal(winners.length, 1, JSON.stringify(results));
});
