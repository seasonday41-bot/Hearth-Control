import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { XClaimStore } from '../mcp/x/claim-store.mjs';
import { XRunStore } from '../mcp/x/run-store.mjs';
import { cancelXTask } from '../mcp/x/cancel-x-task.mjs';

const fixtures = [];

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-x-cancel-task-'));
  const storagePath = path.join(dir, 'hearth-runtime.sqlite');
  const claimStore = new XClaimStore({ storagePath, leaseDurationMs: 30_000 });
  const runStore = new XRunStore({ storagePath });
  const claim = claimStore.claim({ taskId: 'task-1', ownerId: 'owner-1' });
  runStore.createRun({ runId: 'run-1', taskId: 'task-1', claimLeaseId: claim.leaseId });
  runStore.markRunning({ runId: 'run-1', claimLeaseId: claim.leaseId });

  const keeper = {
    state: 'active',
    stopCalls: 0,
    async stop() {
      this.stopCalls += 1;
      this.state = 'stopped';
      return { status: 'stopped' };
    },
  };

  const item = { dir, storagePath, claimStore, runStore, claim, keeper };
  fixtures.push(item);
  return item;
}

afterEach(() => {
  for (const item of fixtures.splice(0)) {
    try { item.runStore.close(); } catch {}
    try { item.claimStore.close(); } catch {}
    fs.rmSync(item.dir, { recursive: true, force: true });
  }
});

const ack = (runId = 'run-1') => ({
  runId,
  status: 'cancelled',
  acknowledged: true,
  result: null,
  error: null,
});

test('C7-1 happy path orders X ack -> fenced persistence -> keeper stop -> claim release', async () => {
  const item = fixture();
  const order = [];

  const realCancel = item.runStore.cancelRunFenced.bind(item.runStore);
  item.runStore.cancelRunFenced = (args) => {
    order.push('persist');
    return realCancel(args);
  };

  const realStop = item.keeper.stop.bind(item.keeper);
  item.keeper.stop = async () => {
    order.push('keeper_stop');
    return realStop();
  };

  const realRelease = item.claimStore.release.bind(item.claimStore);
  item.claimStore.release = (args) => {
    order.push('release');
    return realRelease(args);
  };

  const result = await cancelXTask({
    runId: 'run-1',
    taskId: 'task-1',
    claim: item.claim,
    claimStore: item.claimStore,
    runStore: item.runStore,
    keeper: item.keeper,
    xCoderClient: {
      async cancel() {
        order.push('x_ack');
        return ack();
      },
    },
  });

  assert.deepEqual(order, ['x_ack', 'persist', 'keeper_stop', 'release']);
  assert.equal(result.cancelled, true);
  assert.equal(result.clean, true);
  assert.equal(result.run.status, 'cancelled');
  assert.equal(item.runStore.getRun('run-1').status, 'cancelled');
  assert.equal(item.claimStore.getRaw('task-1').state, 'released');
});

test('C7-2 ack received then lease lost before persistence -> no retry and no cleanup by cancel helper', async () => {
  const item = fixture();
  let persistCalls = 0;
  const realCancel = item.runStore.cancelRunFenced.bind(item.runStore);
  item.runStore.cancelRunFenced = (args) => {
    persistCalls += 1;
    return realCancel(args);
  };

  const result = await cancelXTask({
    runId: 'run-1',
    taskId: 'task-1',
    claim: item.claim,
    claimStore: item.claimStore,
    runStore: item.runStore,
    keeper: item.keeper,
    xCoderClient: {
      async cancel() {
        assert.equal(item.claimStore.release({
          taskId: item.claim.taskId,
          ownerId: item.claim.ownerId,
          leaseId: item.claim.leaseId,
        }), true);
        return ack();
      },
    },
  });

  assert.equal(persistCalls, 1, 'one initial persistence attempt, zero retries');
  assert.equal(result.cancelled, false);
  assert.equal(result.status, 'lease_lost');
  assert.equal(result.reconciliationRequired, true);
  assert.equal(item.runStore.getRun('run-1').status, 'running');
  assert.equal(item.keeper.stopCalls, 0);
});

test('C7-3 live lease + first transient null + second success persists cancelled before cleanup', async () => {
  const item = fixture();
  const order = [];
  let persistCalls = 0;
  const realCancel = item.runStore.cancelRunFenced.bind(item.runStore);
  item.runStore.cancelRunFenced = (args) => {
    persistCalls += 1;
    order.push('persist-' + persistCalls);
    if (persistCalls === 1) return null;
    return realCancel(args);
  };

  const realStop = item.keeper.stop.bind(item.keeper);
  item.keeper.stop = async () => {
    order.push('keeper_stop');
    return realStop();
  };
  const realRelease = item.claimStore.release.bind(item.claimStore);
  item.claimStore.release = (args) => {
    order.push('release');
    return realRelease(args);
  };

  const result = await cancelXTask({
    runId: 'run-1',
    taskId: 'task-1',
    claim: item.claim,
    claimStore: item.claimStore,
    runStore: item.runStore,
    keeper: item.keeper,
    xCoderClient: { cancel: async () => ack() },
  });

  assert.equal(result.cancelled, true);
  assert.equal(result.persistAttempts, 2);
  assert.equal(item.runStore.getRun('run-1').status, 'cancelled');
  assert.deepEqual(order, ['persist-1', 'persist-2', 'keeper_stop', 'release']);
});

test('C7-4 live lease + all bounded persistence retries fail -> operational fault, run/keeper/claim remain live', async () => {
  const item = fixture();
  let persistCalls = 0;
  const logs = [];

  item.runStore.cancelRunFenced = () => {
    persistCalls += 1;
    return null;
  };

  const result = await cancelXTask({
    runId: 'run-1',
    taskId: 'task-1',
    claim: item.claim,
    claimStore: item.claimStore,
    runStore: item.runStore,
    keeper: item.keeper,
    xCoderClient: { cancel: async () => ack() },
    maxPersistAttempts: 3,
    logger: { error: (...args) => logs.push(args) },
  });

  assert.equal(persistCalls, 3);
  assert.equal(result.cancelled, false);
  assert.equal(result.status, 'persistence_fault');
  assert.equal(result.reconciliationRequired, true);
  assert.equal(item.runStore.getRun('run-1').status, 'running');
  assert.equal(item.keeper.stopCalls, 0);
  assert.equal(item.keeper.state, 'active');
  assert.equal(item.claimStore.isOwner('task-1', item.claim.ownerId, item.claim.leaseId), true);
  assert.equal(logs.length, 1);
});

test('C7-5 X cancellation without a terminal cancelled ack cannot touch Hearth persistence or cleanup', async () => {
  const item = fixture();
  let persistCalls = 0;
  const realCancel = item.runStore.cancelRunFenced.bind(item.runStore);
  item.runStore.cancelRunFenced = (args) => {
    persistCalls += 1;
    return realCancel(args);
  };

  const result = await cancelXTask({
    runId: 'run-1',
    taskId: 'task-1',
    claim: item.claim,
    claimStore: item.claimStore,
    runStore: item.runStore,
    keeper: item.keeper,
    xCoderClient: {
      cancel: async () => ({ runId: 'run-1', status: 'running', acknowledged: false }),
    },
  });

  assert.equal(result.cancelled, false);
  assert.equal(result.status, 'x_cancel_not_acknowledged');
  assert.equal(persistCalls, 0);
  assert.equal(item.keeper.stopCalls, 0);
  assert.equal(item.runStore.getRun('run-1').status, 'running');
  assert.equal(item.claimStore.isOwner('task-1', item.claim.ownerId, item.claim.leaseId), true);
});

test('C7-6 source invariant: no return path reports cancelled=true without the persistedRun success branch', () => {
  const sourcePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../mcp/x/cancel-x-task.mjs');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const fn = source.slice(source.indexOf('export async function cancelXTask'));

  const trueOccurrences = [...fn.matchAll(/cancelled:\s*true/g)];
  assert.equal(trueOccurrences.length, 1, 'cancelled:true must exist in exactly one success return');

  const returnLines = fn.split('\n').filter((line) => line.trimStart().startsWith('return '));
  const directObjectReturns = returnLines.filter((line) => line.includes('return {'));
  assert.equal(directObjectReturns.length, 1, 'all non-success returns must use notCancelled()');
  assert.ok(returnLines.filter((line) => !line.includes('return {')).every((line) => line.includes('notCancelled(')));

  const successIndex = fn.indexOf('cancelled: true');
  assert.ok(fn.lastIndexOf('if (!persistedRun)', successIndex) >= 0, 'success must be dominated by persistedRun guard');
  assert.match(fn.slice(successIndex, successIndex + 300), /run:\s*persistedRun/);
});
