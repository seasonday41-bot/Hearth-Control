import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ExecutorApiValidationError,
  ExecutorTaskValidationError,
  parseSubmitRequest,
  parseExecutorXTask,
  validateCancelRequest,
  validateExecutorXTask,
  validateStatusRequest,
  validateSubmitRequest,
} from './index.mjs';
import { differentialFixtures, makeValidTask } from './fixtures.mjs';

test('independent executor validator matches expected fixture verdicts', () => {
  for (const fixture of differentialFixtures) {
    const result = validateExecutorXTask(fixture.input);
    assert.equal(result.ok, fixture.expectedOk, fixture.name);
  }
});

test('independent executor parser does not mutate accepted input', () => {
  const task = makeValidTask();
  const before = structuredClone(task);
  const parsed = parseExecutorXTask(task);
  assert.deepEqual(task, before);
  assert.deepEqual(parsed, before);
  assert.notEqual(parsed, task);
});

test('independent executor parser throws typed validation error', () => {
  const task = makeValidTask();
  task.revision = 0;
  assert.throws(
    () => parseExecutorXTask(task),
    (error) => error instanceof ExecutorTaskValidationError && error.code === 'INVALID_EXECUTOR_X_TASK',
  );
});

test('submit request accepts a valid task and trims idempotency key', () => {
  const request = {
    version: 'x-executor-api-v1',
    idempotency_key: '  request-1  ',
    task: makeValidTask(),
  };
  const result = validateSubmitRequest(request);
  assert.equal(result.ok, true);
  assert.equal(result.value.idempotency_key, 'request-1');
  const parsed = parseSubmitRequest(request);
  assert.equal(parsed.task.task_id, 'task-1');
});

test('submit request rejects unknown fields, bad idempotency keys, and invalid tasks', () => {
  const request = {
    version: 'x-executor-api-v1',
    idempotency_key: '',
    task: makeValidTask(),
    worker: 'qwen',
  };
  request.task.attempt = 0;
  const result = validateSubmitRequest(request);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.path === 'worker' && item.code === 'UNKNOWN_FIELD'));
  assert.ok(result.errors.some((item) => item.path === 'idempotency_key'));
  assert.ok(result.errors.some((item) => item.path === 'task.attempt'));
  assert.throws(() => parseSubmitRequest(request), ExecutorApiValidationError);
});

test('status and cancel requests are strict run-id envelopes', () => {
  assert.equal(validateStatusRequest({ version: 'x-executor-api-v1', run_id: 'run-1' }).ok, true);
  assert.equal(validateCancelRequest({ version: 'x-executor-api-v1', run_id: 'run-1' }).ok, true);
  assert.equal(validateStatusRequest({ version: 'x-executor-api-v1', run_id: '', extra: true }).ok, false);
  assert.equal(validateCancelRequest({ version: 'wrong', run_id: 'run-1' }).ok, false);
});
