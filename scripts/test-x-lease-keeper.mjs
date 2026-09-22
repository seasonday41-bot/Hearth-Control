import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { XClaimStore } from '../mcp/x/claim-store.mjs';
import { XLeaseKeeper } from '../mcp/x/lease-keeper.mjs';

const fixtures = [];

function fixture(duration = 150) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-x-keeper-'));
  const storagePath = path.join(dir, 'claims.sqlite');
  const first = new XClaimStore({ storagePath, leaseDurationMs: duration });
  const second = new XClaimStore({ storagePath, leaseDurationMs: duration });
  const claim = first.claim({ taskId: 'task-a', ownerId: 'owner-a' });
  const item = { dir, first, second, claim, keepers: [] };
  fixtures.push(item);
  return item;
}

function keep(item, store = item.first, claim = item.claim) {
  const keeper = new XLeaseKeeper({ claimStore: store, claim }).start();
  item.keepers.push(keeper);
  return keeper;
}

afterEach(async () => {
  for (const item of fixtures.splice(0)) {
    for (const keeper of item.keepers) await keeper.stop();
    item.first.close();
    item.second.close();
    fs.rmSync(item.dir, { recursive: true, force: true });
  }
});

test('K0 keeper starts only with the current authoritative lease snapshot', async () => {
  const item = fixture(150);
  const altered = { ...item.claim, leaseExpiresAt: item.claim.leaseExpiresAt + 1000 };
  const keeper = new XLeaseKeeper({ claimStore: item.first, claim: altered });
  item.keepers.push(keeper);
  assert.throws(() => keeper.start(), /current, active lease/);
  assert.equal((await keeper.done).status, 'error');
  assert.equal(keeper.timer, null);
});

test('K1 short lease survives beyond its original expiry without output events', async () => {
  const item = fixture(150);
  const keeper = keep(item);
  await sleep(360);
  assert.equal(keeper.state, 'active');
  assert.ok(item.first.getActiveClaim('task-a').leaseExpiresAt > item.claim.leaseExpiresAt);
});

test('K2 independent store cannot reclaim the same or another task while keeper runs', async () => {
  const item = fixture(150);
  keep(item);
  await sleep(340);
  assert.equal(item.second.claim({ taskId: 'task-a', ownerId: 'owner-b' }), null);
  assert.equal(item.second.claim({ taskId: 'task-b', ownerId: 'owner-b' }), null);
});

test('K3 every renewal preserves exact owner, lease ID, and attempt', async () => {
  const item = fixture(150);
  const keeper = keep(item);
  await sleep(260);
  const active = item.second.getActiveClaim('task-a');
  assert.equal(active.ownerId, item.claim.ownerId);
  assert.equal(active.leaseId, item.claim.leaseId);
  assert.equal(active.attempt, item.claim.attempt);
  assert.equal(keeper.claim.leaseId, item.claim.leaseId);
});

test('K4 stop clears the timer and starts no further renewal', async () => {
  const item = fixture(120);
  let renewCount = 0;
  const store = { isOwner: (...args) => item.first.isOwner(...args), getActiveClaim: (...args) => item.first.getActiveClaim(...args), renew: (args) => { renewCount += 1; return item.first.renew(args); } };
  const keeper = keep(item, store);
  await sleep(80);
  assert.ok(renewCount > 0);
  const outcome = await keeper.stop();
  assert.equal(outcome.status, 'stopped');
  assert.equal(keeper.timer, null);
  const atStop = renewCount;
  await sleep(90);
  assert.equal(renewCount, atStop);
  assert.equal(item.first.getRaw('task-a').state, 'active');
});

test('K5 stop never releases; after expiry another owner can reclaim', async () => {
  const item = fixture(100);
  const keeper = keep(item);
  await keeper.stop();
  assert.equal(item.first.getRaw('task-a').state, 'active');
  await sleep(140);
  const reclaimed = item.second.claim({ taskId: 'task-a', ownerId: 'owner-b' });
  assert.ok(reclaimed);
  assert.notEqual(reclaimed.leaseId, item.claim.leaseId);
  assert.equal(reclaimed.attempt, item.claim.attempt + 1);
});

test('K6 null renewal is surfaced as confirmed ownership loss', async () => {
  const item = fixture(120);
  const keeper = keep(item);
  assert.equal(item.second.release({ taskId: 'task-a', ownerId: 'owner-a', leaseId: item.claim.leaseId }), true);
  const outcome = await keeper.done;
  assert.equal(outcome.status, 'ownership_lost');
  assert.equal(outcome.error, null);
  assert.equal(keeper.state, 'ownership_lost');
});

test('K7 ownership loss prevents any later renewal attempts', async () => {
  const item = fixture(120);
  let renewCount = 0;
  const store = { isOwner: (...args) => item.first.isOwner(...args), getActiveClaim: (...args) => item.first.getActiveClaim(...args), renew: (args) => { renewCount += 1; return item.first.renew(args); } };
  const keeper = keep(item, store);
  item.second.release({ taskId: 'task-a', ownerId: 'owner-a', leaseId: item.claim.leaseId });
  await keeper.done;
  const atLoss = renewCount;
  await sleep(100);
  assert.equal(renewCount, atLoss);
  assert.equal(keeper.timer, null);
});

test('K8 thrown renewal error is surfaced without an unhandled timer failure', async () => {
  const item = fixture(120);
  const failure = new Error('SQLite renewal failed');
  const store = { isOwner: (...args) => item.first.isOwner(...args), getActiveClaim: (...args) => item.first.getActiveClaim(...args), renew: () => { throw failure; } };
  const keeper = keep(item, store);
  const outcome = await keeper.done;
  assert.equal(outcome.status, 'error');
  assert.equal(outcome.error, failure);
  assert.equal(keeper.error, failure);
  assert.equal(keeper.timer, null);
});

test('K9 stale keeper cannot renew or release a lease reclaimed by another owner', async () => {
  const item = fixture(120);
  let beginRenew;
  const begun = new Promise((resolve) => { beginRenew = resolve; });
  let allowRenew;
  const gate = new Promise((resolve) => { allowRenew = resolve; });
  const store = { isOwner: (...args) => item.first.isOwner(...args), getActiveClaim: (...args) => item.first.getActiveClaim(...args), renew: async (args) => { beginRenew(); await gate; return item.first.renew(args); } };
  const keeper = keep(item, store);
  await begun;
  await sleep(140);
  const reclaimed = item.second.claim({ taskId: 'task-a', ownerId: 'owner-b' });
  assert.ok(reclaimed);
  allowRenew();
  const outcome = await keeper.done;
  assert.equal(outcome.status, 'ownership_lost');
  assert.equal(item.second.getActiveClaim('task-a').leaseId, reclaimed.leaseId);
  assert.equal(item.first.release({ taskId: 'task-a', ownerId: 'owner-a', leaseId: item.claim.leaseId }), false);
});

test('K10 a slow renewal never overlaps a second timer attempt', async () => {
  const item = fixture(180);
  let beginRenew;
  const begun = new Promise((resolve) => { beginRenew = resolve; });
  let allowRenew;
  const gate = new Promise((resolve) => { allowRenew = resolve; });
  let calls = 0;
  const store = { isOwner: (...args) => item.first.isOwner(...args), getActiveClaim: (...args) => item.first.getActiveClaim(...args), renew: async (args) => {
    calls += 1;
    beginRenew();
    await gate;
    return item.first.renew(args);
  } };
  const keeper = keep(item, store);
  await begun;
  await sleep(70);
  assert.equal(calls, 1);
  const stopped = keeper.stop();
  allowRenew();
  assert.equal((await stopped).status, 'stopped');
  assert.equal(calls, 1);
});


test('K11 onRenewed fires only after a successful validated renewal with the authoritative snapshot', async () => {
  const item = fixture(180);
  const observed = [];
  const keeper = new XLeaseKeeper({
    claimStore: item.first,
    claim: item.claim,
    onRenewed: async (renewed) => {
      observed.push({ ...renewed });
    },
  }).start();
  item.keepers.push(keeper);

  await sleep(90);
  assert.ok(observed.length >= 1);
  const first = observed[0];
  assert.equal(first.taskId, item.claim.taskId);
  assert.equal(first.ownerId, item.claim.ownerId);
  assert.equal(first.leaseId, item.claim.leaseId);
  assert.equal(first.attempt, item.claim.attempt);
  assert.equal(first.state, 'active');
  assert.ok(first.leaseExpiresAt > item.claim.leaseExpiresAt);
  assert.deepEqual(first, keeper.claim);
});

test('K12 onRenewed is not fired when renewal loses ownership', async () => {
  const item = fixture(120);
  let calls = 0;
  const keeper = new XLeaseKeeper({
    claimStore: item.first,
    claim: item.claim,
    onRenewed: () => { calls += 1; },
  }).start();
  item.keepers.push(keeper);

  assert.equal(item.second.release({
    taskId: item.claim.taskId,
    ownerId: item.claim.ownerId,
    leaseId: item.claim.leaseId,
  }), true);

  const outcome = await keeper.done;
  assert.equal(outcome.status, 'ownership_lost');
  assert.equal(calls, 0);
});

test('K13 onRenewed must be a function when provided', () => {
  const item = fixture(150);
  assert.throws(
    () => new XLeaseKeeper({ claimStore: item.first, claim: item.claim, onRenewed: true }),
    /onRenewed must be a function/,
  );
});
