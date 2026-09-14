import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { parseXTask, X_TASK_VERSION } from '../mcp/x/task-contract.mjs';
import { XExecutionAbortedError } from '../mcp/x/cancellation.mjs';
import { createModelAdapter } from '../mcp/x/model-adapter.mjs';
import { executeTask } from '../mcp/x/local-executor.mjs';
import { createFile, replaceFile, applyEdits } from '../mcp/x/edit-writer.mjs';
import { runRequiredValidation } from '../mcp/x/validation-runner.mjs';
import { runTaskWithRepair } from '../mcp/x/repair-loop.mjs';
import { executeXTask } from '../mcp/x/execute-x-task.mjs';

const roots = [];
function fixture({ validation } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-x-cancel-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts/test-pass.mjs'), "import test from 'node:test';\ntest('ok', () => {});\n");
  const task = parseXTask({
    version: X_TASK_VERSION, task_id: 'TASK-CANCEL-1', parent_task_id: null,
    revision: 1, attempt: 1, based_on_result_id: null,
    objective: 'Verify cooperative cancellation.', problem: 'A stale owner must stop starting new work.',
    expected_behavior: 'The signal stops execution before the next side effect.',
    observed_behavior: 'No whole-run signal existed.', why_this_matters: 'Lease loss must stop stale execution.',
    known_evidence: [], suspected_area: [], workspace: { repo: 'Hearth-Control', root },
    scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: [] },
    constraints: { preserve: [], do_not: [] }, allowed_tools: ['repo_read'],
    acceptance_criteria: ['Cancellation is propagated outside the Result Gate.'],
    validation: validation ?? { required: ['node --test scripts/test-pass.mjs'], optional: [] },
    verification: null, done_criteria: ['No new work begins after abort.'], teaching_notes: [],
    uncertainty_policy: { policy: 'bounded_autonomy', stop_conditions: [] },
    repair_budget: { initial_attempts: 1, max_repairs: 2, max_total_rounds: 3 },
    timing: { estimated_minutes: 5, first_check_after_minutes: 1, soft_deadline_minutes: 3, hard_timeout_minutes: 10 },
    commit_policy: { mode: 'never' },
  });
  return { root, task };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const response = (actions) => ({
  ok: true, provider: 'fake', model: 'fake', text: JSON.stringify({ actions }),
  finishReason: 'stop', usage: null, error: null,
});
const create = (name) => ({ type: 'create', path: `src/${name}`, content: 'ok\n' });
const aborted = (error) => error instanceof XExecutionAbortedError && error.code === 'X_EXECUTION_ABORTED';
const exists = (root, name) => fs.existsSync(path.join(root, 'src', name));

test('already-aborted signal prevents context/model execution and never reaches Result Gate', async () => {
  const { task } = fixture();
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(executeXTask(task, { generate: async () => { calls += 1; return response([]); } }, { signal: controller.signal }), aborted);
  assert.equal(calls, 0);
});

test('abort during a model wait propagates the signal and prevents later edits', async () => {
  const { root, task } = fixture();
  const controller = new AbortController();
  let resume;
  const waiting = new Promise((resolve) => { resume = resolve; });
  let entered;
  const begun = new Promise((resolve) => { entered = resolve; });
  const adapter = { generate: async (_request, options) => {
    assert.equal(options.signal, controller.signal);
    entered();
    await waiting;
    return response([create('late.js')]);
  } };
  const run = executeXTask(task, adapter, { signal: controller.signal });
  await begun;
  controller.abort();
  resume();
  await assert.rejects(run, aborted);
  assert.equal(exists(root, 'late.js'), false);
});

test('provider result arriving after abort cannot become model_request_failed or an edit', async () => {
  const { root, task } = fixture();
  const controller = new AbortController();
  const adapter = { generate: async () => {
    controller.abort();
    return response([create('late.js')]);
  } };
  await assert.rejects(runTaskWithRepair(task, adapter, { signal: controller.signal }), aborted);
  assert.equal(exists(root, 'late.js'), false);
});

test('real ModelAdapter relays abort to the provider; normalized provider error does not hide cancellation', async () => {
  const { root, task } = fixture();
  const controller = new AbortController();
  let providerSignal;
  let entered;
  const begun = new Promise((resolve) => { entered = resolve; });
  const adapter = createModelAdapter({ provider: { chat: ({ signal }) => {
    providerSignal = signal;
    entered();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('provider aborted')), { once: true }));
  } } });
  const run = executeXTask(task, adapter, { signal: controller.signal });
  await begun;
  controller.abort();
  await assert.rejects(run, aborted);
  assert.equal(providerSignal.aborted, true);
  assert.equal(exists(root, 'late.js'), false);
});

test('abort before the first edit action prevents mutation', async () => {
  const { root, task } = fixture();
  const controller = new AbortController();
  const adapter = { generate: async () => { controller.abort(); return response([create('first.js')]); } };
  await assert.rejects(executeTask(task, adapter, { signal: controller.signal }), aborted);
  assert.equal(exists(root, 'first.js'), false);
});

test('abort between multiple actions preserves the first edit and prevents the next', async () => {
  const { root, task } = fixture();
  const controller = new AbortController();
  let writerCalls = 0;
  // The writer reads limits once per action. This controlled caller-owned
  // getter aborts at the second action's pre-write boundary.
  const writeLimits = { get maxBytesPerWrite() {
    writerCalls += 1;
    if (writerCalls === 2) controller.abort();
    return 200_000;
  } };
  const adapter = { generate: async () => response([create('first.js'), create('second.js')]) };
  await assert.rejects(executeTask(task, adapter, { signal: controller.signal, writeLimits }), aborted);
  assert.equal(writerCalls, 2);
  assert.equal(exists(root, 'first.js'), true);
  assert.equal(exists(root, 'second.js'), false);
});

test('edit writer aborts after path inspection and before temp-file mutation without WRITE_FAILED', async () => {
  const { root, task } = fixture();
  const controller = new AbortController();
  const temp = path.join(root, 'src', '.x-write-tmp-cancel-test');
  await assert.rejects(createFile(task, 'src/late.js', 'content', {
    signal: controller.signal,
    __testTempPathFor: () => { controller.abort(); return temp; },
  }), aborted);
  assert.equal(fs.existsSync(temp), false);
  assert.equal(exists(root, 'late.js'), false);
});

test('abort during temporary-file creation cleans up its own temp and never publishes the target', async () => {
  const { root, task } = fixture();
  const controller = new AbortController();
  const temp = path.join(root, 'src', '.x-write-tmp-cancel-during-write');
  await assert.rejects(createFile(task, 'src/late.js', 'content', {
    signal: controller.signal,
    __testTempPathFor: () => {
      queueMicrotask(() => controller.abort());
      return temp;
    },
  }), aborted);
  assert.equal(fs.existsSync(temp), false);
  assert.equal(exists(root, 'late.js'), false);
});

test('already-aborted writer signal blocks create, replace, and patch', async () => {
  const { root, task } = fixture();
  fs.writeFileSync(path.join(root, 'src', 'existing.js'), 'old');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(createFile(task, 'src/new.js', 'x', { signal: controller.signal }), aborted);
  await assert.rejects(replaceFile(task, 'src/existing.js', 'new', { expectedContent: 'old', signal: controller.signal }), aborted);
  await assert.rejects(applyEdits(task, 'src/existing.js', [{ old_string: 'old', new_string: 'new' }], { signal: controller.signal }), aborted);
  assert.equal(fs.readFileSync(path.join(root, 'src', 'existing.js'), 'utf8'), 'old');
});

test('abort after a successful edit but before validation prevents a validation spawn', async () => {
  const { root, task } = fixture({ validation: { required: ['node --test scripts/test-marker.mjs'], optional: [] } });
  const controller = new AbortController();
  fs.writeFileSync(path.join(root, 'scripts', 'test-marker.mjs'), "import fs from 'node:fs';\nfs.writeFileSync('validation-ran', 'yes');\n");
  const taskWithValidationBoundary = new Proxy(task, { get(target, key) {
    if (key === 'validation') controller.abort();
    return Reflect.get(target, key);
  } });
  const adapter = { generate: async () => response([create('first.js')]) };
  await assert.rejects(runTaskWithRepair(taskWithValidationBoundary, adapter, { signal: controller.signal }), aborted);
  assert.equal(exists(root, 'first.js'), true);
  assert.equal(fs.existsSync(path.join(root, 'validation-ran')), false);
});

test('already-aborted validation signal prevents process spawn', async () => {
  const { root, task } = fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runRequiredValidation(task, { signal: controller.signal }), aborted);
  assert.equal(fs.existsSync(path.join(root, 'validation-ran')), false);
});

test('abort during validation terminates the owned child and bubbles cancellation', async () => {
  const { root, task } = fixture({ validation: { required: ['node --test scripts/test-hang.mjs'], optional: [] } });
  fs.writeFileSync(path.join(root, 'scripts', 'test-hang.mjs'), [
    "import fs from 'node:fs';",
    "fs.writeFileSync('validation.pid', String(process.pid));",
    "setInterval(() => {}, 1000);",
  ].join('\n'));
  const controller = new AbortController();
  const run = runRequiredValidation(task, { signal: controller.signal });
  const pidPath = path.join(root, 'validation.pid');
  try {
    for (let i = 0; i < 200 && !fs.existsSync(pidPath); i += 1) await sleep(10);
    assert.equal(fs.existsSync(pidPath), true, 'validation child started');
    const pid = Number(fs.readFileSync(pidPath, 'utf8'));
    controller.abort();
    await assert.rejects(run, aborted);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    controller.abort();
    await run.catch(() => {});
  }
});

test('abort reaps validation even when its test file installs a SIGTERM handler', async () => {
  const { root, task } = fixture({ validation: { required: ['node --test scripts/test-ignore-term.mjs'], optional: [] } });
  fs.writeFileSync(path.join(root, 'scripts', 'test-ignore-term.mjs'), [
    "import fs from 'node:fs';",
    "process.on('SIGTERM', () => {});",
    "fs.writeFileSync('validation.pid', String(process.pid));",
    "setInterval(() => {}, 1000);",
  ].join('\n'));
  const controller = new AbortController();
  const run = runRequiredValidation(task, { signal: controller.signal });
  const pidPath = path.join(root, 'validation.pid');
  try {
    for (let i = 0; i < 200 && !fs.existsSync(pidPath); i += 1) await sleep(10);
    assert.equal(fs.existsSync(pidPath), true, 'validation child started');
    const pid = Number(fs.readFileSync(pidPath, 'utf8'));
    controller.abort();
    await assert.rejects(run, aborted);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    controller.abort();
    await run.catch(() => {});
  }
});

test('abort while preparing a repair task prevents the next model round', async () => {
  const { task } = fixture();
  const controller = new AbortController();
  let calls = 0;
  const taskWithRepairBoundary = new Proxy(task, { get(target, key) {
    if (key === 'known_evidence' && calls === 1) controller.abort();
    return Reflect.get(target, key);
  } });
  const adapter = { generate: async () => { calls += 1; return { ...response([]), text: 'not-json' }; } };
  await assert.rejects(runTaskWithRepair(taskWithRepairBoundary, adapter, { signal: controller.signal }), aborted);
  assert.equal(calls, 1);
});

test('normal no-signal Core X composition remains completed', async () => {
  const { root, task } = fixture();
  const result = await executeXTask(task, { generate: async () => response([create('normal.js')]) });
  assert.equal(result.gateResult.gate_status, 'COMPLETED');
  assert.equal(result.xResult.task_id, task.task_id);
  assert.equal(exists(root, 'normal.js'), true);
});
