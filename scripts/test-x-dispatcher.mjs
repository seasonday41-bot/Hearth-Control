import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { XClaimStore } from '../mcp/x/claim-store.mjs';
import { XDispatcher } from '../mcp/x/dispatcher.mjs';
import { X_TASK_VERSION } from '../mcp/x/task-contract.mjs';

const dirs = [];
const stores = [];
function tmpStorePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-x-dispatch-'));
  dirs.push(dir);
  return path.join(dir, 'claims.sqlite');
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

const validTask = (taskId, overrides = {}) => ({
  version: X_TASK_VERSION,
  task_id: taskId,
  parent_task_id: null,
  revision: 1,
  attempt: 1,
  based_on_result_id: null,
  objective: 'Fix the focused defect.',
  problem: 'The dispatcher needs deterministic, safe ownership.',
  expected_behavior: 'Exactly one task executes at a time.',
  observed_behavior: 'No serial dispatcher exists yet.',
  why_this_matters: 'Concurrent execution risks duplicate or racing edits.',
  known_evidence: ['docs/X-EXECUTOR-V1-SPEC.md'],
  suspected_area: ['mcp/x'],
  workspace: { repo: 'Hearth-Control', root: '/approved/hearth' },
  scope: { allowed_paths: ['mcp/x'], preferred_files: ['mcp/x/dispatcher.mjs'], forbidden_paths: ['mcp/runtime'] },
  constraints: { preserve: ['Durable Job Runtime'], do_not: ['Modify Bridge'] },
  allowed_tools: ['repo_read', 'file_search'],
  acceptance_criteria: ['Focused tests pass.'],
  validation: { required: ['node --test scripts/test-x-dispatcher.mjs'], optional: [] },
  verification: { evidence: ['dispatcher result'] },
  done_criteria: ['Dispatcher claims exactly one task.'],
  teaching_notes: [],
  uncertainty_policy: { policy: 'bounded_autonomy', stop_conditions: ['Scope conflict'] },
  repair_budget: { initial_attempts: 1, max_repairs: 2, max_total_rounds: 3 },
  timing: { estimated_minutes: 10, first_check_after_minutes: 2, soft_deadline_minutes: 8, hard_timeout_minutes: 15 },
  commit_policy: 'never',
  ...overrides,
});

test('D1 dispatcher claims exactly one runnable task and never reports more than one active', () => {
  const store = makeStore(tmpStorePath());
  const dispatcherA = new XDispatcher({ claimStore: store, ownerId: 'dispatcher-a' });
  const dispatcherB = new XDispatcher({ claimStore: store, ownerId: 'dispatcher-b' });

  const resultA = dispatcherA.claimNext([{ task: validTask('task-1') }]);
  const resultB = dispatcherB.claimNext([{ task: validTask('task-2') }]);

  assert.ok(resultA.claim);
  assert.equal(resultB.claim, null);
  assert.equal(resultB.skipped[0].reason, 'no_capacity');

  const active = store.getActiveClaim();
  assert.equal(active.taskId, 'task-1');
  assert.equal(active.ownerId, 'dispatcher-a');
});

test('D2 deterministic ordering: higher priority wins, then oldest enqueuedAt, then input order', () => {
  const store = makeStore(tmpStorePath());
  const dispatcher = new XDispatcher({ claimStore: store });

  const entries = [
    { task: validTask('task-low-old'), priority: 1, enqueuedAt: 1000 },
    { task: validTask('task-high-new'), priority: 5, enqueuedAt: 5000 },
    { task: validTask('task-high-old'), priority: 5, enqueuedAt: 1000 },
  ];
  const result = dispatcher.claimNext(entries);
  assert.equal(result.task.task_id, 'task-high-old');
});

test('D3 no-priority entries are plain FIFO by input order', () => {
  const store = makeStore(tmpStorePath());
  const dispatcher = new XDispatcher({ claimStore: store });
  const entries = [{ task: validTask('task-second') }, { task: validTask('task-first') }];
  // input order is authoritative when there is no priority/enqueuedAt distinction
  const result = dispatcher.claimNext(entries);
  assert.equal(result.task.task_id, 'task-second');
});

test('D4 malformed/unvalidated task cannot be silently dispatched', () => {
  const store = makeStore(tmpStorePath());
  const dispatcher = new XDispatcher({ claimStore: store });
  const malformed = { version: X_TASK_VERSION, task_id: 'task-broken' }; // missing required fields
  const entries = [{ task: malformed }, { task: validTask('task-ok') }];

  const result = dispatcher.claimNext(entries);
  assert.ok(result.claim);
  assert.equal(result.task.task_id, 'task-ok');
  const invalidEntry = result.skipped.find((s) => s.reason === 'invalid_task');
  assert.ok(invalidEntry, JSON.stringify(result.skipped));
  assert.ok(invalidEntry.errors.length > 0);
});

test('D5 an all-malformed queue claims nothing and reports every rejection explicitly', () => {
  const store = makeStore(tmpStorePath());
  const dispatcher = new XDispatcher({ claimStore: store });
  const entries = [{ task: { version: X_TASK_VERSION } }, { task: { foo: 'bar' } }];
  const result = dispatcher.claimNext(entries);
  assert.equal(result.claim, null);
  assert.equal(result.skipped.length, 2);
  assert.ok(result.skipped.every((s) => s.reason === 'invalid_task'));
});

test('D6 released task frees capacity for the next independent dispatch', () => {
  const store = makeStore(tmpStorePath());
  const dispatcher = new XDispatcher({ claimStore: store });

  const first = dispatcher.claimNext([{ task: validTask('task-b') }]);
  assert.ok(first.claim);
  const released = dispatcher.release('task-b', first.claim.leaseId);
  assert.equal(released, true);

  const second = dispatcher.claimNext([{ task: validTask('task-c') }]);
  assert.ok(second.claim);
  assert.equal(second.task.task_id, 'task-c');
});

test('D7 renew/release are fenced to the owning dispatcher only', () => {
  const store = makeStore(tmpStorePath());
  const dispatcherA = new XDispatcher({ claimStore: store, ownerId: 'dispatcher-a' });
  const dispatcherB = new XDispatcher({ claimStore: store, ownerId: 'dispatcher-b' });

  const claimed = dispatcherA.claimNext([{ task: validTask('task-a') }]);
  assert.ok(claimed.claim);

  assert.equal(dispatcherB.renew('task-a', claimed.claim.leaseId), null);
  assert.equal(dispatcherB.release('task-a', claimed.claim.leaseId), false);
  assert.ok(dispatcherA.renew('task-a', claimed.claim.leaseId));
  assert.equal(dispatcherA.release('task-a', claimed.claim.leaseId), true);
});

test('D8 release does not mark the task completed -- it only frees the dispatcher slot', () => {
  const store = makeStore(tmpStorePath());
  const dispatcher = new XDispatcher({ claimStore: store });
  const claimed = dispatcher.claimNext([{ task: validTask('task-a') }]);
  const released = dispatcher.release('task-a', claimed.claim.leaseId);
  assert.equal(typeof released, 'boolean');
  assert.equal(store.getRaw('task-a').state, 'released');
});
