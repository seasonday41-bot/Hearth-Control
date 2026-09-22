/**
 * Hearth Crash & Resume Persistence Test Suite (v0.4.3)
 * Tests durable storage, atomic saves, backup fallback, startup reconciliation,
 * startup recovery, Goal checkpoint persistence, and redaction invariants.
 *
 * SAFETY GUARANTEES:
 * - Temporary test directories isolated in os.tmpdir()
 * - Clean teardown of temporary files
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
      { id: 'step-auto', title: 'Auto Execution', route: 'manual', required: true },
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

console.log('\n══════════════════════════════════════════════════════════');
console.log(`  Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
console.log('══════════════════════════════════════════════════════════\n');

if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
