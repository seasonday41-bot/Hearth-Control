import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

import { cancelXTask } from '../mcp/x/cancel-x-task.mjs';

const claim = Object.freeze({
  taskId: 'task-1',
  ownerId: 'owner-1',
  leaseId: 'lease-1',
});

const cancelledRow = Object.freeze({
  runId: 'run-1',
  taskId: 'task-1',
  status: 'cancelled',
});

const fixture = ({
  ack = { runId: 'run-1', status: 'cancelled', acknowledged: true },
  persist = [cancelledRow],
  owner = [true],
} = {}) => {
  const calls = [];
  let persistIndex = 0;
  let ownerIndex = 0;
  const runStore = {
    cancelRunFenced(args) {
      calls.push('persist:' + (persistIndex + 1));
      const value = persist[Math.min(persistIndex, persist.length - 1)];
      persistIndex += 1;
      if (value instanceof Error) throw value;
      return value;
    },
  };
  const claimStore = {
    isOwner(taskId, ownerId, leaseId) {
      calls.push('isOwner:' + (ownerIndex + 1));
      assert.equal(taskId, claim.taskId);
      assert.equal(ownerId, claim.ownerId);
      assert.equal(leaseId, claim.leaseId);
      const value = owner[Math.min(ownerIndex, owner.length - 1)];
      ownerIndex += 1;
      if (value instanceof Error) throw value;
      return value;
    },
    release(args) {
      calls.push('release');
      assert.deepEqual(args, {
        taskId: claim.taskId,
        ownerId: claim.ownerId,
        leaseId: claim.leaseId,
      });
      return true;
    },
  };
  const keeper = {
    async stop() {
      calls.push('keeper.stop');
      return { status: 'stopped' };
    },
  };
  const xCoderClient = {
    async cancel(runId) {
      calls.push('x.cancel');
      assert.equal(runId, 'run-1');
      if (ack instanceof Error) throw ack;
      return ack;
    },
  };
  const logs = [];
  const logger = {
    error(...args) {
      calls.push('logger.error');
      logs.push(args);
    },
  };
  return { calls, runStore, claimStore, keeper, xCoderClient, logger, logs };
};

const invoke = (item, options = {}) => cancelXTask({
  runId: 'run-1',
  taskId: 'task-1',
  claim,
  claimStore: item.claimStore,
  runStore: item.runStore,
  keeper: item.keeper,
  xCoderClient: item.xCoderClient,
  logger: item.logger,
  ...options,
});

test('S7-1 happy path is X ack -> persisted cancelled -> keeper stop -> original claim release', async () => {
  const item = fixture();
  const result = await invoke(item);

  assert.equal(result.clean, true);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.run, cancelledRow);
  assert.deepEqual(item.calls, ['x.cancel', 'persist:1', 'keeper.stop', 'release']);
  assert.equal(result.cleanup.keeperStatus, 'stopped');
  assert.equal(result.cleanup.released, true);
});

test('S7-2 ack received then lease lost after failed persistence: zero retries and keeper/claim untouched', async () => {
  const item = fixture({ persist: [null], owner: [false] });
  const result = await invoke(item);

  assert.equal(result.clean, false);
  assert.equal(result.status, 'lease_lost');
  assert.equal(result.persistenceAttempts, 1);
  assert.deepEqual(item.calls, ['x.cancel', 'persist:1', 'isOwner:1']);
  assert.equal(item.calls.includes('keeper.stop'), false);
  assert.equal(item.calls.includes('release'), false);
});

test('S7-3 live lease transient null then second persistence succeeds', async () => {
  const item = fixture({ persist: [null, cancelledRow], owner: [true] });
  const result = await invoke(item, { maxPersistenceAttempts: 3 });

  assert.equal(result.clean, true);
  assert.equal(result.persistenceAttempts, 2);
  assert.deepEqual(item.calls, [
    'x.cancel',
    'persist:1',
    'isOwner:1',
    'persist:2',
    'keeper.stop',
    'release',
  ]);
});

test('S7-4 live lease throughout all bounded attempts: operational fault, run not claimed cancelled, keeper/claim untouched', async () => {
  const item = fixture({ persist: [null, null, null], owner: [true, true, true] });
  const result = await invoke(item, { maxPersistenceAttempts: 3 });

  assert.equal(result.clean, false);
  assert.equal(result.status, 'persistence_error');
  assert.equal(result.run, null);
  assert.equal(result.persistenceAttempts, 3);
  assert.equal(item.logs.length, 1);
  assert.deepEqual(item.calls, [
    'x.cancel',
    'persist:1', 'isOwner:1',
    'persist:2', 'isOwner:2',
    'persist:3', 'isOwner:3',
    'logger.error',
  ]);
  assert.equal(item.calls.includes('keeper.stop'), false);
  assert.equal(item.calls.includes('release'), false);
});

test('S7-5 thrown persistence fault is retried only while ownership remains confirmed live', async () => {
  const transient = new Error('sqlite busy');
  const item = fixture({ persist: [transient, cancelledRow], owner: [true] });
  const result = await invoke(item);

  assert.equal(result.clean, true);
  assert.equal(result.persistenceAttempts, 2);
  assert.deepEqual(item.calls, [
    'x.cancel', 'persist:1', 'isOwner:1', 'persist:2', 'keeper.stop', 'release',
  ]);
});

test('S7-6 X must terminally acknowledge cancelled before any Hearth persistence or cleanup', async () => {
  const item = fixture({
    ack: { runId: 'run-1', status: 'running', acknowledged: false },
  });
  const result = await invoke(item);

  assert.equal(result.clean, false);
  assert.equal(result.status, 'x_cancel_not_acknowledged');
  assert.deepEqual(item.calls, ['x.cancel']);
});

test('S7-7 X cancel transport failure leaves Hearth persistence, keeper, and claim untouched', async () => {
  const item = fixture({ ack: new Error('service unavailable') });
  const result = await invoke(item);

  assert.equal(result.clean, false);
  assert.equal(result.status, 'x_cancel_error');
  assert.deepEqual(item.calls, ['x.cancel']);
});

test('S7-8 static success-path invariant: no return path can directly claim clean cancellation without the guarded persisted row helper', () => {
  const source = fs.readFileSync(new URL('../mcp/x/cancel-x-task.mjs', import.meta.url), 'utf8');
  const cleanTrueMatches = source.match(/clean:\s*true/g) ?? [];
  assert.equal(cleanTrueMatches.length, 1, 'clean:true must exist only in the guarded cleanCancellation helper');
  assert.match(source, /if \(!persistedRun \|\| persistedRun\.status !== 'cancelled'\)/);
  const cancelBody = source.slice(source.indexOf('export async function cancelXTask'));
  assert.doesNotMatch(
    cancelBody,
    /return\s*\{[^}]*status:\s*'cancelled'[^}]*clean:\s*true/s,
    'cancelXTask return paths must not inline a clean success object',
  );

  const returnLines = cancelBody.split('\n').filter((line) => line.trim().startsWith('return '));
  assert.ok(returnLines.length >= 5, 'expected every explicit return path to remain visible for audit');
  assert.equal(
    returnLines.some((line) => line.includes("status: 'cancelled'")),
    false,
    'no direct return path may spell a clean cancelled status; only cleanCancellation may construct it',
  );
});
