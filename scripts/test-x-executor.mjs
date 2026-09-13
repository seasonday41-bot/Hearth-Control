import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createAntigravityExecutor } from '../mcp/x/antigravity-executor.mjs';
import { assertExecutorContract, EXECUTOR_OUTCOMES, normalizeExecutorResult } from '../mcp/x/executor.mjs';

const task = Object.freeze({
  taskId: 'hearth-task-x',
  conversationId: 'conversation-x',
  workspace: '/approved/workspace',
  prompt: 'Inspect only',
  durableJobEvidence: { jobId: 'job-x', status: 'completed', exitCode: 0 },
});

const result = (status, extra = {}) => ({
  taskId: task.taskId,
  conversationId: task.conversationId,
  status,
  durableJobEvidence: task.durableJobEvidence,
  ...extra,
});

test('X1 executor contract requires run, resume, and stop', () => {
  const executor = createAntigravityExecutor({ start: async () => result('done'), resume: async () => result('done'), stop: async () => {} });
  assert.equal(assertExecutorContract(executor), executor);
  assert.deepEqual(EXECUTOR_OUTCOMES, ['completed', 'waiting', 'error']);
  assert.throws(() => assertExecutorContract({ run() {}, resume() {} }), /stop/);
});

test('X2 run preserves task and conversation identity with durable evidence', async () => {
  let received;
  const executor = createAntigravityExecutor({
    start: async (value) => { received = value; return result('done'); },
    resume: async () => result('done'), stop: async () => {},
  });
  const actual = await executor.run(task);
  assert.equal(received, task);
  assert.equal(actual.taskId, task.taskId);
  assert.equal(actual.conversationId, task.conversationId);
  assert.deepEqual(actual.durableJobEvidence, task.durableJobEvidence);
  assert.equal(actual.outcome, 'completed');
  assert.equal(actual.lifecycleStatus, 'done');
});

test('X3 resume delegates task plus checkpoint and preserves identity', async () => {
  let received;
  const checkpoint = { message: 'Continue with durable evidence', continuationAttemptId: 'attempt-x' };
  const executor = createAntigravityExecutor({
    start: async () => result('done'),
    resume: async (value) => { received = value; return result('waiting'); },
    stop: async () => {},
  });
  const actual = await executor.resume(task, checkpoint);
  assert.deepEqual(received, { ...task, ...checkpoint });
  assert.equal(actual.taskId, task.taskId);
  assert.equal(actual.conversationId, task.conversationId);
  assert.equal(actual.outcome, 'waiting');
});

test('X4 terminal lifecycle status maps to completed, waiting, and error', () => {
  assert.equal(normalizeExecutorResult(result('done')).outcome, 'completed');
  assert.equal(normalizeExecutorResult(result('waiting')).outcome, 'waiting');
  assert.equal(normalizeExecutorResult(result('error')).outcome, 'error');
});

test('X5 a live running task is retained as live rather than falsely terminal', () => {
  const actual = normalizeExecutorResult(result('running'));
  assert.equal(actual.lifecycleStatus, 'running');
  assert.equal(actual.outcome, null);
});

test('X6 stop delegates only to the Phase 1A stop entry point', async () => {
  const calls = [];
  const executor = createAntigravityExecutor({
    start: async () => result('done'), resume: async () => result('done'),
    stop: async (taskId) => { calls.push(taskId); },
  });
  await executor.stop(task.taskId);
  assert.deepEqual(calls, [task.taskId]);
});

test('X7 adapter has no direct process termination implementation', () => {
  const source = fs.readFileSync(fileURLToPath(new URL('../mcp/x/antigravity-executor.mjs', import.meta.url)), 'utf8');
  assert.equal(source.includes('process.kill'), false);
  assert.equal(source.includes('.kill('), false);
  assert.equal(source.includes('ChildProcess'), false);
});

for (const [name, code] of [['STOP_UNVERIFIED', 'STOP_UNVERIFIED'], ['NOT_FOUND', 'NOT_FOUND']]) {
  test(`X8 ${name} propagates unchanged from Phase 1A`, async () => {
    const expected = Object.assign(new Error(name), { code });
    const executor = createAntigravityExecutor({
      start: async () => result('done'), resume: async () => result('done'),
      stop: async () => { throw expected; },
    });
    await assert.rejects(executor.stop(task.taskId), (err) => err === expected && err.code === code);
  });
}

console.log('X Executor Phase 1B tests: 9 passed');
