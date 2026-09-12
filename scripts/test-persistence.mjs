/**
 * Hearth Crash & Resume Persistence Test Suite (v0.4.3)
 * Tests durable storage, atomic saves, backup fallback, startup reconciliation,
 * safe resume with original conversationId and Hearth taskId, duplicate protection,
 * workspace locking, Goal Runner checkpoint persistence, and safety invariants.
 *
 * SAFETY GUARANTEES:
 * - Pure in-memory mocks for process runners (NO live Antigravity CLI invocations)
 * - Temporary test directories isolated in os.tmpdir()
 * - Clean teardown of temporary files
 * - Zero modification of ~/.gemini or user directories
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';

import {
  TaskStore,
  sanitizeTaskForPersistence,
} from '../mcp/executors/task-store.mjs';

import {
  startAntigravityTask,
  getAntigravityTask,
  resumeAntigravityTask,
  markTaskFailed,
  dismissRecoveryTask,
  setTaskStore,
  hasRunningTask,
  taskRegistry,
  buildAgyPrompt,
  classifyCompletion,
  HEARTH_COMPLETION_INSTRUCTION,
} from '../mcp/executors/antigravity.mjs';

import {
  GoalStorage,
} from '../mcp/goals/storage.mjs';

import {
  GoalRunner,
} from '../mcp/goals/runner.mjs';

let passed = 0;
let failed = 0;
const results = [];

const test = async (name, fn) => {
  try {
    await fn();
    console.log(`  ✅ PASS  ${name}`);
    results.push({ name, status: 'PASS' });
    passed++;
  } catch (err) {
    console.error(`  ❌ FAIL  ${name}`);
    console.error(`           ${err.stack || err.message}`);
    results.push({ name, status: 'FAIL', error: err.message });
    failed++;
  }
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message || 'Assertion failed');
};
assert.equal = (actual, expected, message) => {
  if (actual !== expected) {
    throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};

console.log('\n═══ Test Suite: Hearth Crash / Resume Persistence (v0.4.3) ═══\n');

// Helper to create isolated test dir
const createTempDir = () => {
  const dir = path.join(os.tmpdir(), `hearth-persist-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

// ── 1. Running task persisted to disk ─────────────────────────────────────────
await test('1. Running task is persisted to disk immediately upon start', async () => {
  const tempDir = createTempDir();
  const filePath = path.join(tempDir, 'tasks.json');
  const store = new TaskStore(filePath);
  setTaskStore(store);

  let finishRunner;
  const pendingPromise = new Promise((resolve) => { finishRunner = resolve; });

  const mockRunner = async () => {
    await pendingPromise;
    return {
      stdout: [
        JSON.stringify({ event: 'init', conversation_id: 'conv-init-1' }),
        JSON.stringify({ event: 'result', result: { conversation_id: 'conv-init-1', status: 'SUCCESS', response: '```json\n{"status":"completed"}\n```' } }),
      ].join('\n'),
      stderr: '',
    };
  };

  const startRes = await startAntigravityTask({
    workspace: tempDir,
    prompt: 'Check codebase status',
    title: 'Check codebase status',
    customAgyPath: process.execPath,
    userApproved: true,
    awaitCompletion: false,
    runner: mockRunner,
  });

  const stored = store.getTask(startRes.taskId);
  assert(stored, 'Task must be stored in TaskStore');
  assert.equal(stored.taskId, startRes.taskId);
  assert(stored.status === 'running' || stored.status === 'starting', `Status should be starting/running, got ${stored.status}`);

  const rawFile = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert(Array.isArray(rawFile.tasks) && rawFile.tasks.some((t) => t.taskId === startRes.taskId), 'Task must exist in tasks.json on disk');

  finishRunner();
  await new Promise((r) => setTimeout(r, 50));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ── 2. Waiting task persisted to disk ─────────────────────────────────────────
await test('2. Waiting task is persisted to disk with interim reason', async () => {
  const tempDir = createTempDir();
  const filePath = path.join(tempDir, 'tasks.json');
  const store = new TaskStore(filePath);
  setTaskStore(store);

  const mockRunner = async () => {
    const contractObj = {
      status: 'waiting',
      summary: 'Awaiting API credentials confirmation',
      interimReason: 'API credentials needed',
    };
    const contractJson = JSON.stringify(contractObj);
    const fencedContract = `\`\`\`json\n${contractJson}\n\`\`\``;
    return {
      stdout: [
        JSON.stringify({ event: 'init', conversation_id: 'conv-wait-2' }),
        JSON.stringify({ event: 'agent_response', message: fencedContract }),
        JSON.stringify({ event: 'result', result: { conversation_id: 'conv-wait-2', status: 'SUCCESS', response: fencedContract } }),
      ].join('\n'),
      stderr: '',
    };
  };

  const startRes = await startAntigravityTask({
    workspace: tempDir,
    prompt: 'Setup API keys',
    title: 'Setup API keys',
    customAgyPath: process.execPath,
    userApproved: true,
    awaitCompletion: false,
    runner: mockRunner,
  });

  await new Promise((r) => setTimeout(r, 60));
  const task = getAntigravityTask(startRes.taskId);
  assert.equal(task.status, 'waiting', 'Task must transition to waiting');

  const stored = store.getTask(startRes.taskId);
  assert.equal(stored.status, 'waiting');
  assert.equal(stored.completion?.status, 'waiting');
  assert.equal(stored.completion?.interimReason, 'API credentials needed');

  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ── 3. Restart restores state from disk ──────────────────────────────────────
await test('3. Restart restores state correctly from tasks.json', async () => {
  const tempDir = createTempDir();
  const filePath = path.join(tempDir, 'tasks.json');

  const initialStore = new TaskStore(filePath);
  initialStore.saveTask({
    taskId: 'task-test-restored-1',
    conversationId: 'conv-test-1',
    workspace: tempDir,
    title: 'Saved task',
    status: 'waiting',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastAnswer: 'Some interim reply',
  });

  // Simulate reboot with fresh TaskStore reading same file
  const restartedStore = new TaskStore(filePath);
  const reconciled = restartedStore.reconcileStartupState();
  assert.equal(reconciled.reconciledCount, 0, 'Waiting task should not be forced into recovery_required');

  const task = restartedStore.getTask('task-test-restored-1');
  assert(task, 'Task must be restored');
  assert.equal(task.status, 'waiting');
  assert.equal(task.conversationId, 'conv-test-1');
  assert.equal(task.title, 'Saved task');

  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ── 4. Running before restart -> recovery_required when unconfirmed ───────────
await test('4. Interrupted running task transitions strictly to recovery_required on restart', async () => {
  const tempDir = createTempDir();
  const filePath = path.join(tempDir, 'tasks.json');

  const store1 = new TaskStore(filePath);
  store1.saveTask({
    taskId: 'task-crashed-1',
    conversationId: 'conv-crashed-1',
    workspace: tempDir,
    title: 'Unfinished work',
    status: 'running',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  store1.saveTask({
    taskId: 'task-crashed-2',
    conversationId: 'conv-crashed-2',
    workspace: tempDir,
    title: 'Unfinished work 2',
    status: 'starting',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  // Reconcile on startup
  const store2 = new TaskStore(filePath);
  const changed = store2.reconcileStartupState();
  assert.equal(changed.reconciledCount, 2);

  const t1 = store2.getTask('task-crashed-1');
  assert.equal(t1.status, 'recovery_required', 'Running task must become recovery_required');
  assert(t1.error?.includes('interrupted'), 'Error message should explain shutdown interruption');

  const t2 = store2.getTask('task-crashed-2');
  assert.equal(t2.status, 'recovery_required', 'Starting task must become recovery_required');

  // Verify it is NEVER auto-DONE
  assert(t1.status !== 'done', 'Never auto-DONE');
  assert(t2.status !== 'done', 'Never auto-DONE');

  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ── 5. Resume uses same conversationId ───────────────────────────────────────
await test('5. Resume task re-uses original conversationId and never creates new conversation', async () => {
  const tempDir = createTempDir();
  const filePath = path.join(tempDir, 'tasks.json');
  const store = new TaskStore(filePath);
  setTaskStore(store);

  const taskId = 'task-recover-conv-5';
  const originalConvId = 'conv-original-session-12345';
  store.saveTask({
    taskId,
    conversationId: originalConvId,
    workspace: tempDir,
    title: 'Task needing resume',
    status: 'recovery_required',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  let runnerInvokedWithConv = null;
  let runnerInvokedPrompt = null;

  const mockResumeRunner = async (execPath, args, opts) => {
    runnerInvokedWithConv = args[args.indexOf('--conversation') + 1];
    runnerInvokedPrompt = opts.input;
    const contract = JSON.stringify({
      status: 'completed',
      summary: 'Resumed task finished cleanly',
    });
    return {
      stdout: JSON.stringify({ event: 'result', result: { conversation_id: originalConvId, status: 'SUCCESS', response: contract } }),
      stderr: '',
    };
  };

  const resumeRes = await resumeAntigravityTask({
    taskId,
    customAgyPath: process.execPath,
    runner: mockResumeRunner,
  });

  assert.equal(resumeRes.taskId, taskId);
  assert.equal(resumeRes.conversationId, originalConvId);
  assert.equal(runnerInvokedWithConv, originalConvId, 'Runner must receive original conversationId');
  assert(
    (() => { try { return JSON.parse(runnerInvokedPrompt).message.content.includes(HEARTH_COMPLETION_INSTRUCTION); } catch { return runnerInvokedPrompt.includes(HEARTH_COMPLETION_INSTRUCTION); } })(),
    'Must inject completion contract into message content'
  );

  const finishedTask = store.getTask(taskId);
  assert.equal(finishedTask.status, 'done');
  assert.equal(finishedTask.conversationId, originalConvId);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ── 6. Resume keeps same Hearth taskId ───────────────────────────────────────
await test('6. Resume retains original Hearth taskId across polling and persistence', async () => {
  const tempDir = createTempDir();
  const filePath = path.join(tempDir, 'tasks.json');
  const store = new TaskStore(filePath);
  setTaskStore(store);

  const originalTaskId = 'task-stable-id-443';
  store.saveTask({
    taskId: originalTaskId,
    conversationId: 'conv-stable-443',
    workspace: tempDir,
    title: 'Stable ID task',
    status: 'recovery_required',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const mockResumeRunner = async () => ({
    stdout: JSON.stringify({ event: 'result', result: { conversation_id: 'conv-stable-443', status: 'SUCCESS', response: '```json\n{"status":"completed"}\n```' } }),
    stderr: '',
  });

  const res = await resumeAntigravityTask({
    taskId: originalTaskId,
    customAgyPath: process.execPath,
    runner: mockResumeRunner,
  });

  assert.equal(res.taskId, originalTaskId, 'Must keep identical Hearth taskId');
  const fetched = getAntigravityTask(originalTaskId);
  assert.equal(fetched.taskId, originalTaskId);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ── 7. Duplicate resume blocked by mutex guard ───────────────────────────────
await test('7. Rapid duplicate resume calls are blocked by mutex guard', async () => {
  const tempDir = createTempDir();
  const filePath = path.join(tempDir, 'tasks.json');
  const store = new TaskStore(filePath);
  setTaskStore(store);

  const taskId = 'task-mutex-test-7';
  store.saveTask({
    taskId,
    conversationId: 'conv-mutex-7',
    workspace: tempDir,
    title: 'Mutex task',
    status: 'recovery_required',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  let finishSlowResume;
  const pendingPromise = new Promise((resolve) => { finishSlowResume = resolve; });

  const slowRunner = async () => {
    await pendingPromise;
    return {
      stdout: JSON.stringify({ event: 'result', result: { conversation_id: 'conv-mutex-7', status: 'SUCCESS', response: '```json\n{"status":"completed","summary":"Mutex test task done"}\n```' } }),
      stderr: '',
    };
  };

  // p1 starts; because mutex is set synchronously (before any await), p2 is
  // rejected immediately in the same microtask turn without needing p1 to finish.
  const p1 = resumeAntigravityTask({ taskId, customAgyPath: process.execPath, runner: slowRunner });
  let p2Rejected = false;
  try {
    // p2 must reject synchronously (mutex already locked by p1 before first await)
    await resumeAntigravityTask({ taskId, customAgyPath: process.execPath, runner: slowRunner });
  } catch (err) {
    p2Rejected = true;
    assert(err.message.includes('already in progress') || err.message.includes('already running'), `Unexpected error: ${err.message}`);
  }

  // Now unblock p1 and wait for it to finish
  finishSlowResume();
  await p1;
  assert(p2Rejected, 'Second concurrent resume call must be rejected');

  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ── 8. Remote request not duplicated after restart (findTaskByRemoteLink) ─────
await test('8. Remote task deduplication prevents re-processing after restart', async () => {
  const tempDir = createTempDir();
  const filePath = path.join(tempDir, 'tasks.json');
  const store = new TaskStore(filePath);

  store.saveTask({
    taskId: 'hearth-task-remote-100',
    conversationId: 'conv-rem-100',
    remoteTaskId: 'remote-uuid-999',
    requestId: 'req-link-888',
    workspace: tempDir,
    title: 'Remote job',
    status: 'done',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  // Querying by remote link matches existing task
  const existing1 = store.findTaskByRemoteLink({ remoteTaskId: 'remote-uuid-999' });
  assert(existing1, 'Must find by remoteTaskId');
  assert.equal(existing1.taskId, 'hearth-task-remote-100');

  const existing2 = store.findTaskByRemoteLink({ requestId: 'req-link-888' });
  assert(existing2, 'Must find by requestId');
  assert.equal(existing2.taskId, 'hearth-task-remote-100');

  const notFound = store.findTaskByRemoteLink({ remoteTaskId: 'different-uuid' });
  assert.equal(notFound, null);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ── 9. Completed/error terminal state restored correctly ─────────────────────
await test('9. Completed and error terminal states are restored unchanged', async () => {
  const tempDir = createTempDir();
  const filePath = path.join(tempDir, 'tasks.json');

  const store = new TaskStore(filePath);
  store.saveTask({
    taskId: 't-done',
    conversationId: 'c-done',
    workspace: tempDir,
    title: 'Done task',
    status: 'done',
    lastAnswer: 'Success answer',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  store.saveTask({
    taskId: 't-error',
    conversationId: 'c-error',
    workspace: tempDir,
    title: 'Error task',
    status: 'error',
    error: 'Fatal test error',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const store2 = new TaskStore(filePath);
  store2.reconcileStartupState();

  const restoredDone = store2.getTask('t-done');
  assert.equal(restoredDone.status, 'done');
  assert.equal(restoredDone.lastAnswer, 'Success answer');

  const restoredErr = store2.getTask('t-error');
  assert.equal(restoredErr.status, 'error');
  assert.equal(restoredErr.error, 'Fatal test error');

  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ── 10. Corrupt state recovers safely from .bak ──────────────────────────────
await test('10. Corrupt primary tasks.json safely falls back to valid .bak file', async () => {
  const tempDir = createTempDir();
  const filePath = path.join(tempDir, 'tasks.json');
  const bakPath = `${filePath}.bak`;

  const validBackupData = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    tasks: {
      'task-from-bak': {
        taskId: 'task-from-bak',
        title: 'Task rescued from backup',
        status: 'done',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    },
  };

  // Corrupt primary file, good .bak file
  fs.writeFileSync(filePath, '{{INVALID JSON CORRUPTED DATA', 'utf8');
  fs.writeFileSync(bakPath, JSON.stringify(validBackupData, null, 2), 'utf8');

  const store = new TaskStore(filePath);
  const rescued = store.getTask('task-from-bak');
  assert(rescued, 'Must rescue data from backup file');
  assert.equal(rescued.title, 'Task rescued from backup');
  assert.equal(rescued.status, 'done');

  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ── 11. Corrupt primary + no backup fails safely to empty store ──────────────
await test('11. Corrupt primary file with no backup falls back safely to empty state', async () => {
  const tempDir = createTempDir();
  const filePath = path.join(tempDir, 'tasks.json');

  fs.writeFileSync(filePath, '###TOTAL_GARBAGE###', 'utf8');

  const store = new TaskStore(filePath);
  const all = store.listTasks();
  assert(Array.isArray(all) && all.length === 0, 'Should initialize empty without throwing');

  // Should be writable now
  store.saveTask({
    taskId: 'new-task-1',
    status: 'running',
  });
  assert.equal(store.getTask('new-task-1')?.status, 'running');

  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ── 12. Secrets/raw transcript not persisted ─────────────────────────────────
await test('12. Credentials redacted and raw transcript excluded from persistent state', async () => {
  const rawSecretPrompt = 'API_KEY=AIzaSyA_SecretKey1234567890abcdefgh and Bearer ya29.a0AfH6SMDfake-token-secret-123456789';
  const testJwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeakThisSignature';
  const taskWithSecrets = {
    taskId: 'task-secret-check',
    workspace: '/test/workspace',
    title: 'Secret check',
    status: 'running',
    lastAnswer: `Here is token Bearer ya29.a0AfH6SMDfake-token-secret-123456789 and raw prompt: ${rawSecretPrompt} and JWT ${testJwt}`,
    error: 'Failed with key AIzaSyA_SecretKey1234567890abcdefgh',
    recentEvents: [
      { stepIndex: 1, type: 'OUTPUT', summary: `Found token ${testJwt}` },
    ],
    // Deliberately attached internal large buffer or objects
    _rawTranscript: 'MASSIVE LOG DATA WITH CREDENTIALS',
    _child: { pid: 1234 },
  };

  const sanitized = sanitizeTaskForPersistence(taskWithSecrets);

  assert(!sanitized._rawTranscript, 'Raw transcript must be excluded');
  assert(!sanitized._child, 'Child process handles must be excluded');
  assert(!sanitized.lastAnswer.includes('ya29.a0AfH6SMDfake'), 'Bearer token must be redacted');
  assert(!sanitized.lastAnswer.includes('AIzaSyA_SecretKey'), 'API key must be redacted');
  assert(!sanitized.error.includes('AIzaSyA_SecretKey'), 'Error message must redact secret key');
  assert(!sanitized.recentEvents[0].summary.includes('doNotLeakThisSignature'), 'Event summary must redact token');
  assert(sanitized.lastAnswer.includes('[REDACTED'), 'Redacted marker must be present');
});

// ── 13. Workspace lock survives active recovery ──────────────────────────────
await test('13. Workspace lock blocks workspace change while recovery_required is pending', async () => {
  const tempDir = createTempDir();
  const filePath = path.join(tempDir, 'tasks.json');
  const store = new TaskStore(filePath);
  setTaskStore(store);

  // Clear in-memory taskRegistry
  for (const k of taskRegistry.keys()) taskRegistry.delete(k);

  // No tasks: running task false
  assert.equal(hasRunningTask(), false);

  // Task in recovery_required (undismissed)
  store.saveTask({
    taskId: 'task-locking-1',
    conversationId: 'c-lock-1',
    workspace: tempDir,
    status: 'recovery_required',
    dismissed: false,
  });

  assert.equal(hasRunningTask(), true, 'hasRunningTask must return true for pending recovery_required');

  // Once dismissed, workspace lock is released
  store.dismissTask('task-locking-1');
  assert.equal(hasRunningTask(), false, 'Dismissing recovery task releases lock');

  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ── 14. Goal checkpoint & currentStepId survive restart ──────────────────────
await test('14. Goal checkpoints and currentStepId survive simulated application restart', async () => {
  const tempDir = createTempDir();
  const goalsPath = path.join(tempDir, 'goals.json');

  const initialStorage = new GoalStorage(goalsPath);
  const created = initialStorage.createGoal({
    title: 'Persistence Test Goal',
    objective: 'Test surviving crashes',
    workspace: tempDir,
    steps: [
      { id: 'step-1', title: 'Step 1', route: 'manual', required: true },
      { id: 'step-2', title: 'Step 2', route: 'manual', required: true },
    ],
  });

  // Save checkpoint and advance step
  initialStorage.updateStep(created.id, 'step-1', {
    status: 'completed',
    output: 'Step 1 done',
  });
  initialStorage.saveCheckpoint(created.id, {
    summary: 'Step 1 checkpoint completed cleanly',
    checks: ['check-1', 'check-2'],
  });
  initialStorage.updateGoal(created.id, {
    currentStepId: 'step-2',
    status: 'running',
  });

  // Re-instantiate GoalStorage and reconcile startup state
  const restartedStorage = new GoalStorage(goalsPath);
  const runner = new GoalRunner(restartedStorage);
  const reconciledGoals = runner.reconcileStartupState();

  assert.equal(reconciledGoals.length, 1);
  assert.equal(reconciledGoals[0].status, 'paused', 'Running goal should transition to paused on restart');

  const restored = restartedStorage.getGoal(created.id);
  assert.equal(restored.currentStepId, 'step-2', 'currentStepId step-2 must survive restart');
  assert.equal(restored.checkpoints.length, 1, 'Checkpoints must survive restart');
  assert.equal(restored.checkpoints[0].summary, 'Step 1 checkpoint completed cleanly');
  assert.equal(restored.steps[0].status, 'completed');

  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ── 15. Manual waiting goal still requires explicit sign-off after restart ───
await test('15. Manual waiting goal step strictly enforces explicit sign-off after restart', async () => {
  const tempDir = createTempDir();
  const goalsPath = path.join(tempDir, 'goals.json');

  const storage = new GoalStorage(goalsPath);
  const goal = storage.createGoal({
    title: 'Manual Gate Goal',
    objective: 'Require human approval',
    workspace: tempDir,
    steps: [
      { id: 'step-manual', title: 'Manual Review', route: 'manual', required: true },
      { id: 'step-auto', title: 'Auto Execution', route: 'antigravity', required: true },
    ],
  });

  storage.updateStep(goal.id, 'step-manual', { status: 'waiting' });
  storage.updateGoal(goal.id, { status: 'waiting', currentStepId: 'step-manual' });

  // Simulate reboot
  const restartedStorage = new GoalStorage(goalsPath);
  const runner = new GoalRunner(restartedStorage);
  runner.reconcileStartupState();

  // Attempting resume directly MUST NOT auto-complete or bypass manual sign-off
  let resumeRejected = false;
  try {
    await runner.resumeGoal(goal.id);
  } catch (err) {
    resumeRejected = true;
    assert(err.message.includes('manual') || err.message.includes('sign-off'), `Unexpected error: ${err.message}`);
  }
  const currentGoal = restartedStorage.getGoal(goal.id);
  assert(resumeRejected, 'Attempting resume directly must be rejected on waiting manual step');
  assert.equal(currentGoal.status, 'waiting', 'Goal must remain waiting on manual step');
  const manualStep = currentGoal.steps.find((s) => s.id === 'step-manual');
  assert.equal(manualStep.status, 'waiting', 'Manual step must still be waiting');
  assert.equal(currentGoal.currentStepId, 'step-manual', 'Must not have advanced to next step');

  // Explicit sign-off completes the step
  const signedOffGoal = await runner.signoffStep({
    goalId: goal.id,
    stepId: 'step-manual',
    action: 'complete',
    autoRun: false,
  });

  assert.equal(signedOffGoal.steps[0].status, 'completed', 'Step completes only after explicit sign-off');
  assert.equal(signedOffGoal.currentStepId, 'step-auto', 'Advances to next step only after sign-off');

  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ── 16. No false-DONE after restart ──────────────────────────────────────────
await test('16. Restart reconciliation and parser strictly preserve no false-DONE invariant', async () => {
  const tempDir = createTempDir();
  const filePath = path.join(tempDir, 'tasks.json');
  const store = new TaskStore(filePath);

  // Store task that had status 'running' and non-contract prose in lastAnswer
  store.saveTask({
    taskId: 'task-no-false-done',
    conversationId: 'c-nfd',
    workspace: tempDir,
    title: 'Prose only task',
    status: 'running',
    lastAnswer: 'All steps done! Everything completed successfully! All good!',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  store.reconcileStartupState();
  const task = store.getTask('task-no-false-done');
  assert.equal(task.status, 'recovery_required', 'Must be recovery_required, NEVER done');
  assert(task.status !== 'done', 'No false DONE');

  // Verify classifier rejects conversational prose even with words like "done"
  const classification = classifyCompletion(task.lastAnswer);
  assert(classification.status !== 'completed', 'Classifier must reject ordinary prose as not completed');

  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ── 17. Remote terminal state sync works after recovery (markTaskFailed) ─────
await test('17. Mark Failed transitions task and enables terminal error state', async () => {
  const tempDir = createTempDir();
  const filePath = path.join(tempDir, 'tasks.json');
  const store = new TaskStore(filePath);
  setTaskStore(store);

  const taskId = 'task-remote-fail-test';
  store.saveTask({
    taskId,
    conversationId: 'conv-remote-fail',
    remoteTaskId: 'remote-777',
    source: 'remote',
    workspace: tempDir,
    title: 'Remote failing task',
    status: 'recovery_required',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const updated = markTaskFailed({ taskId, reason: 'Remote device restarted unexpectedly' });
  assert.equal(updated.status, 'error');
  assert.equal(updated.error, 'Remote device restarted unexpectedly');

  const onDisk = store.getTask(taskId);
  assert.equal(onDisk.status, 'error');
  assert.equal(onDisk.error, 'Remote device restarted unexpectedly');

  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ── 18. Dismiss removes from active view without destroying history ──────────
await test('18. Dismiss marks dismissed=true without destroying task history or marking done', async () => {
  const tempDir = createTempDir();
  const filePath = path.join(tempDir, 'tasks.json');
  const store = new TaskStore(filePath);
  setTaskStore(store);

  const taskId = 'task-dismiss-test';
  store.saveTask({
    taskId,
    conversationId: 'conv-dismiss',
    workspace: tempDir,
    title: 'Task to dismiss',
    status: 'recovery_required',
    lastAnswer: 'Evidence of previous work',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const dismissed = dismissRecoveryTask(taskId);
  assert.equal(dismissed.dismissed, true);
  assert.equal(dismissed.status, 'recovery_required', 'Dismiss must NOT change status to done');

  // Still exists in store with all history intact
  const onDisk = store.getTask(taskId);
  assert(onDisk, 'Task must not be deleted from disk');
  assert.equal(onDisk.dismissed, true);
  assert.equal(onDisk.lastAnswer, 'Evidence of previous work');

  fs.rmSync(tempDir, { recursive: true, force: true });
});

console.log('\n══════════════════════════════════════════════════════════');
console.log(`  Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
console.log('══════════════════════════════════════════════════════════\n');

if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
