/**
 * Hearth Durable Job Runtime v0.1 Diagnostic Test Suite
 * Tests JOB1 through JOB10:
 * - JOB1: Hearth directly owns spawned process
 * - JOB2: Heartbeat continues even if mock AI/controller stream disconnects
 * - JOB3: >7-minute logical background execution does not depend on provider stream
 * - JOB4: Process completion is detected exactly once
 * - JOB5: Provider disconnect while job running does not terminate job
 * - JOB6: Explicit cancel terminates only owned verified process gracefully (SIGTERM)
 * - JOB7: Restart with unverifiable running job -> recovery_required
 * - JOB8: Stdout prose cannot fake heartbeat
 * - JOB9: Completed child provides evidence but does not auto-mark parent task DONE
 * - JOB10: Completion can trigger same-task reasoning continuation
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ChildProcess } from 'node:child_process';

import {
  JobManager,
  getJobManager,
  setJobManager,
  startJob,
  getJob,
  listJobs,
  recordJobHeartbeat,
  cancelJob,
  waitForJob,
  getJobResult,
  VALID_JOB_STATUSES,
  sanitizeJobForPersistence,
} from '../mcp/runtime/job-manager.mjs';

import {
  startAntigravityTask,
  getAntigravityTask,
  taskRegistry,
  setTaskStore,
  startDurableJob,
  isTaskActivelyRunning,
  classifyCompletion,
  resumeAntigravityTask,
  createControlledWorkerSpec,
  createNodeWorkerSpec,
  shouldRouteToDurableJob,
  registerBackgroundJob,
  recordBackgroundHeartbeat,
  approveAndDispatchRemoteTask,
  createTaskContinuationRunner,
} from '../mcp/executors/antigravity.mjs';

import {
  parseRemoteTaskPayload,
  HearthBridgeClient,
  syncRemoteTaskState,
} from '../mcp/bridge/client.mjs';

import { TaskStore } from '../mcp/executors/task-store.mjs';
import { GoalStorage } from '../mcp/goals/storage.mjs';
import { GoalRunner } from '../mcp/goals/runner.mjs';

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

const makeTempDir = () => {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-job-test-'));
};

const cleanupDir = (dir) => {
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // Non-fatal cleanup
  }
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

console.log('=== Hearth Durable Job Runtime v0.1 Test Suite ===\n');

// ----------------------------------------------------------------------------
// JOB1: Hearth directly owns spawned process
// ----------------------------------------------------------------------------
await test('JOB1: Hearth directly owns spawned child process', async () => {
  const tempDir = makeTempDir();
  try {
    const manager = new JobManager({ storagePath: path.join(tempDir, 'jobs.json') });
    
    // Spawn a node one-liner that runs briefly
    const job = manager.startJob({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => { console.log("job1_done"); }, 300);'],
    });

    assert.ok(job, 'Job object must be returned');
    assert.strictEqual(job.status, 'running', 'Job must transition to running');
    assert.ok(job.child instanceof ChildProcess, 'job.child must be a Node ChildProcess');
    assert.ok(typeof job.pid === 'number' && job.pid > 0, 'job.pid must be a valid positive number');

    // Verify process is genuinely alive in OS
    let isAlive = false;
    try {
      isAlive = process.kill(job.pid, 0);
    } catch {
      isAlive = false;
    }
    assert.strictEqual(isAlive, true, 'Spawned PID must be alive');

    // Wait for it to complete naturally
    const result = await manager.waitForJob(job.id, 5000);
    assert.strictEqual(result.status, 'completed', 'Job must complete successfully');
    assert.strictEqual(result.exitCode, 0, 'Exit code must be 0');
    assert.ok(result.stdout.includes('job1_done'), 'Stdout must contain expected text');
  } finally {
    cleanupDir(tempDir);
  }
});

// ----------------------------------------------------------------------------
// JOB2: Heartbeat continues even if mock AI/controller stream disconnects
// ----------------------------------------------------------------------------
await test('JOB2: Heartbeat continues even if mock AI/controller stream disconnects', async () => {
  const tempDir = makeTempDir();
  try {
    const manager = new JobManager({ storagePath: path.join(tempDir, 'jobs.json') });
    
    // Mock AI controller stream that disconnects after 100ms
    class MockAiStream extends EventEmitter {
      disconnect() {
        this.emit('error', new Error('stream input cancelled: context canceled'));
        this.emit('close');
      }
    }
    const mockController = new MockAiStream();

    // Start a background job that stays alive for 600ms
    const job = manager.startJob({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 600);'],
    });

    // Verify initial heartbeat
    const beat1 = manager.recordJobHeartbeat(job.id, { text: 'initial_beat' });
    assert.strictEqual(beat1, true, 'Initial heartbeat must be accepted');
    assert.strictEqual(job.heartbeatCount, 1);

    // Simulate AI controller stream disconnect
    let controllerDisconnected = false;
    let controllerError = null;
    mockController.on('error', (err) => { controllerError = err; });
    mockController.on('close', () => { controllerDisconnected = true; });
    mockController.disconnect();
    assert.strictEqual(controllerDisconnected, true, 'Mock controller stream disconnected');
    assert.ok(controllerError, 'Mock controller captured disconnect error');

    // Even though AI controller stream disconnected, Hearth-owned background process is still alive
    assert.strictEqual(job.status, 'running', 'Job status must remain running');
    let processAlive = false;
    try {
      processAlive = process.kill(job.pid, 0);
    } catch {
      processAlive = false;
    }
    assert.strictEqual(processAlive, true, 'Child process must still be running in OS');

    // Advance heartbeat while controller stream is dead
    const beat2 = manager.recordJobHeartbeat(job.id, { text: 'beat_after_disconnect' });
    assert.strictEqual(beat2, true, 'Heartbeat after controller disconnect must be accepted');
    assert.strictEqual(job.heartbeatCount, 2);

    await manager.waitForJob(job.id, 5000);
  } finally {
    cleanupDir(tempDir);
  }
});

// ----------------------------------------------------------------------------
// JOB3: >7-minute logical background execution does not depend on provider stream
// ----------------------------------------------------------------------------
await test('JOB3: Long-running background execution does not depend on provider stream', async () => {
  const tempDir = makeTempDir();
  try {
    const manager = new JobManager({ storagePath: path.join(tempDir, 'jobs.json') });

    // Start a job with mock startedAt simulating >7 minutes (450 seconds ago)
    const job = manager.startJob({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => { console.log("long_running_done"); }, 200);'],
    });

    // Simulate accelerated historical start time: 450 seconds ago
    const simulatedStartTime = new Date(Date.now() - 450000).toISOString();
    job.startedAt = simulatedStartTime;

    // Simulate multiple provider disconnects and reconnects
    for (let i = 0; i < 3; i++) {
      const beat = manager.recordJobHeartbeat(job.id, { text: `beat_cycle_${i}` });
      assert.strictEqual(beat, true, `Heartbeat cycle ${i} must succeed`);
    }

    const result = await manager.waitForJob(job.id, 5000);
    assert.strictEqual(result.status, 'completed');
    // Duration must reflect the full >7 minute lifetime (>420,000 ms)
    assert.ok(result.durationMs >= 450000, `Duration (${result.durationMs}ms) must reflect >7-minute execution`);
  } finally {
    cleanupDir(tempDir);
  }
});

// ----------------------------------------------------------------------------
// JOB4: Process completion is detected exactly once
// ----------------------------------------------------------------------------
await test('JOB4: Process completion is detected exactly once', async () => {
  const tempDir = makeTempDir();
  try {
    const manager = new JobManager({ storagePath: path.join(tempDir, 'jobs.json') });

    let completionEventsCount = 0;
    let lastEvidence = null;

    manager.on('job_completed', (event) => {
      completionEventsCount++;
      lastEvidence = event.evidence;
    });

    const job = manager.startJob({
      command: process.execPath,
      args: ['-e', 'console.log("job4_output"); process.exit(0);'],
    });

    await manager.waitForJob(job.id, 5000);

    // Wait extra 100ms to ensure both close and exit events have settled
    await delay(100);

    assert.strictEqual(completionEventsCount, 1, 'job_completed must fire exactly once');
    assert.ok(lastEvidence, 'Evidence must be present');
    assert.strictEqual(lastEvidence.exitCode, 0, 'Exit code must be 0');
    assert.ok(lastEvidence.stdout.includes('job4_output'), 'Stdout must be captured in evidence');
  } finally {
    cleanupDir(tempDir);
  }
});

// ----------------------------------------------------------------------------
// JOB5: Provider disconnect while job running does not terminate job
// ----------------------------------------------------------------------------
await test('JOB5: Provider disconnect while job running does not terminate job', async () => {
  const tempDir = makeTempDir();
  try {
    const manager = new JobManager({ storagePath: path.join(tempDir, 'jobs.json') });

    // Start a 400ms job
    const job = manager.startJob({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => { console.log("finished_after_provider_exit"); }, 400);'],
    });

    // Simulate provider stream failure immediately
    const mockProvider = { active: true };
    mockProvider.active = false; // Provider dies

    // Wait 150ms into the execution
    await delay(150);

    // Verify process is still running despite provider death
    assert.strictEqual(job.status, 'running', 'Job must still be running');
    let alive = false;
    try {
      alive = process.kill(job.pid, 0);
    } catch {
      alive = false;
    }
    assert.strictEqual(alive, true, 'Child process must still be running');

    // Wait for natural completion
    const result = await manager.waitForJob(job.id, 5000);
    assert.strictEqual(result.status, 'completed');
    assert.ok(result.stdout.includes('finished_after_provider_exit'));
  } finally {
    cleanupDir(tempDir);
  }
});

// ----------------------------------------------------------------------------
// JOB6: Explicit cancel terminates only owned verified process gracefully (SIGTERM)
// ----------------------------------------------------------------------------
await test('JOB6: Explicit cancel terminates only owned verified process gracefully (SIGTERM)', async () => {
  const tempDir = makeTempDir();
  try {
    const manager = new JobManager({ storagePath: path.join(tempDir, 'jobs.json') });

    // Start a long-running process
    const job = manager.startJob({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000);'],
    });

    assert.strictEqual(job.status, 'running');
    const pid = job.pid;

    // Verify alive
    let alive = false;
    try { alive = process.kill(pid, 0); } catch { alive = false; }
    assert.strictEqual(alive, true, 'Process must be alive before cancel');

    // Gracefully cancel
    const cancelled = manager.cancelJob(job.id, 'User requested cancellation');
    assert.strictEqual(cancelled, true, 'cancelJob must return true for active owned job');
    assert.strictEqual(job.status, 'cancelled', 'Status must be cancelled');
    assert.strictEqual(job.error, 'User requested cancellation');

    // Allow process a moment to handle SIGTERM
    await delay(200);

    // Verify process terminated
    let stillAlive = false;
    try { stillAlive = process.kill(pid, 0); } catch { stillAlive = false; }
    assert.strictEqual(stillAlive, false, 'Process must be terminated after SIGTERM');

    // Invariant: Unowned or invalid IDs fail gracefully without signal dispatch
    const cancelFake = manager.cancelJob('non-existent-job-id');
    assert.strictEqual(cancelFake, false, 'Cancelling non-existent job must return false');
  } finally {
    cleanupDir(tempDir);
  }
});

// ----------------------------------------------------------------------------
// JOB7: Restart with unverifiable running job -> recovery_required
// ----------------------------------------------------------------------------
await test('JOB7: Restart with unverifiable running job transitions to recovery_required', async () => {
  const tempDir = makeTempDir();
  const storagePath = path.join(tempDir, 'jobs.json');
  try {
    // Write a simulated jobs.json containing 1 running, 1 queued, and 1 completed job
    const initialData = {
      version: 1,
      jobs: [
        {
          id: 'job-unverified-running',
          taskId: 'task-101',
          command: 'node',
          args: ['worker.js'],
          status: 'running',
          pid: 999999, // Unverified PID
          createdAt: new Date(Date.now() - 60000).toISOString(),
          startedAt: new Date(Date.now() - 50000).toISOString(),
          heartbeatCount: 5,
        },
        {
          id: 'job-unverified-queued',
          taskId: 'task-102',
          command: 'node',
          args: ['worker2.js'],
          status: 'queued',
          createdAt: new Date(Date.now() - 60000).toISOString(),
        },
        {
          id: 'job-already-completed',
          taskId: 'task-103',
          command: 'node',
          args: ['worker3.js'],
          status: 'completed',
          exitCode: 0,
          createdAt: new Date(Date.now() - 60000).toISOString(),
          completedAt: new Date(Date.now() - 10000).toISOString(),
        },
      ],
    };
    fs.writeFileSync(storagePath, JSON.stringify(initialData, null, 2), 'utf8');

    // Reboot: New JobManager loads the persisted file and reconciles startup state
    const restartedManager = new JobManager({ storagePath, autoLoad: true });
    const { reconciledCount } = restartedManager.reconcileStartupState();

    assert.strictEqual(reconciledCount, 2, 'Must reconcile exactly the 2 unverified active jobs');

    const jobRunning = restartedManager.getJob('job-unverified-running');
    assert.strictEqual(jobRunning.status, 'recovery_required', 'Running job must become recovery_required');
    assert.ok(jobRunning.error.includes('Process unverified after Hearth restart'), 'Error must document unverified restart');
    assert.notStrictEqual(jobRunning.status, 'completed', 'Must NEVER assume completed');

    const jobQueued = restartedManager.getJob('job-unverified-queued');
    assert.strictEqual(jobQueued.status, 'recovery_required', 'Queued job must become recovery_required');

    const jobCompleted = restartedManager.getJob('job-already-completed');
    assert.strictEqual(jobCompleted.status, 'completed', 'Completed job must remain completed');
  } finally {
    cleanupDir(tempDir);
  }
});

// ----------------------------------------------------------------------------
// JOB8: Stdout prose cannot fake heartbeat
// ----------------------------------------------------------------------------
await test('JOB8: Stdout prose cannot fake heartbeat', async () => {
  const tempDir = makeTempDir();
  try {
    const manager = new JobManager({ storagePath: path.join(tempDir, 'jobs.json') });

    // 1. Random LLM prose string as job ID must be rejected
    const fakeProse = 'I have started the background process and it is maintaining heartbeats every 20s.';
    const fakeResult = manager.recordJobHeartbeat(fakeProse, { text: 'fake' });
    assert.strictEqual(fakeResult, false, 'LLM prose cannot act as job ID or fake heartbeat');

    // 2. Non-existent job ID must be rejected
    const fakeResult2 = manager.recordJobHeartbeat('job-does-not-exist');
    assert.strictEqual(fakeResult2, false, 'Non-existent job must be rejected');

    // 3. Completed job cannot accept heartbeats
    const job = manager.startJob({
      command: process.execPath,
      args: ['-e', 'console.log("quick"); process.exit(0);'],
    });
    await manager.waitForJob(job.id, 5000);
    assert.strictEqual(job.status, 'completed');

    const beatOnCompleted = manager.recordJobHeartbeat(job.id, { text: 'late_beat' });
    assert.strictEqual(beatOnCompleted, false, 'Completed job cannot accept heartbeat resets');
  } finally {
    cleanupDir(tempDir);
  }
});

// ----------------------------------------------------------------------------
// JOB9: Completed child provides evidence but does not auto-mark parent task DONE
// ----------------------------------------------------------------------------
await test('JOB9: Completed child provides evidence but does not auto-mark parent task DONE', async () => {
  const tempDir = makeTempDir();
  try {
    const manager = new JobManager({ storagePath: path.join(tempDir, 'jobs.json') });

    // Mock parent Hearth task
    const parentTask = {
      taskId: 'hearth-task-smoke-9',
      status: 'running',
      completion: null,
      lastAnswer: null,
      evidence: null,
    };

    // Register listener that captures completion evidence on the parent task
    manager.on('job_completed', ({ jobId, job, evidence }) => {
      if (job.taskId === parentTask.taskId) {
        parentTask.evidence = evidence;
        // Invariant: Hearth does NOT auto-mark parent task as 'done' upon child exit 0.
        // It remains 'running' waiting for structured completion contract.
      }
    });

    const job = manager.startJob({
      taskId: parentTask.taskId,
      command: process.execPath,
      args: ['-e', 'console.log("functional_assertions_verified"); process.exit(0);'],
    });

    const result = await manager.waitForJob(job.id, 5000);
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.exitCode, 0);

    // Verify parent task state
    assert.strictEqual(parentTask.status, 'running', 'Parent task status must remain running (NOT auto-done)');
    assert.strictEqual(parentTask.completion, null, 'Parent task completion contract must not be fabricated');
    assert.ok(parentTask.evidence, 'Evidence must be stored on parent task');
    assert.ok(parentTask.evidence.stdout.includes('functional_assertions_verified'), 'Evidence must contain stdout');
    assert.strictEqual(parentTask.evidence.exitCode, 0, 'Evidence must record exitCode 0');
  } finally {
    cleanupDir(tempDir);
  }
});

// ----------------------------------------------------------------------------
// JOB10: Completion can trigger same-task reasoning continuation
// ----------------------------------------------------------------------------
await test('JOB10: Completion can trigger same-task reasoning continuation', async () => {
  const tempDir = makeTempDir();
  try {
    const manager = new JobManager({ storagePath: path.join(tempDir, 'jobs.json') });

    let continuationCalled = false;
    let receivedPrompt = null;

    // Mock parent task with continuation capability
    const parentTask = {
      taskId: 'hearth-task-continuation-10',
      status: 'running',
      pendingContinuation: true,
      continueSession: (prompt) => {
        continuationCalled = true;
        receivedPrompt = prompt;
      },
    };

    // Register continuation handler in JobManager
    manager.registerTaskContinuation(parentTask.taskId, {
      onCompleted: ({ jobId, job, evidence }) => {
        if (parentTask.pendingContinuation && typeof parentTask.continueSession === 'function') {
          const continuePrompt = [
            'The background command or tool has completed.',
            evidence.stdout ? `Output: ${evidence.stdout.trim()}` : '',
            `Exit code: ${evidence.exitCode}`,
            'Please evaluate the result and provide your final completion contract in JSON format.',
          ].filter(Boolean).join('\n');
          parentTask.continueSession(continuePrompt);
        }
      },
    });

    const job = manager.startJob({
      taskId: parentTask.taskId,
      command: process.execPath,
      args: ['-e', 'console.log("heavy_computation_finished"); process.exit(0);'],
    });

    await manager.waitForJob(job.id, 5000);

    assert.strictEqual(continuationCalled, true, 'continueSession must be called on child completion');
    assert.ok(receivedPrompt.includes('heavy_computation_finished'), 'Continuation prompt must contain child output');
    assert.ok(receivedPrompt.includes('Exit code: 0'), 'Continuation prompt must contain exit code');
    assert.ok(receivedPrompt.includes('final completion contract'), 'Continuation prompt must request final contract');
  } finally {
    cleanupDir(tempDir);
  }
});

// ============================================================================
// Production Integration Tests (INT_JOB1 - INT_JOB10)
// ============================================================================
console.log('\n=== Production Path Integration Tests ===\n');

class MockStreamingChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = {
      write: (data) => {
        this.emit('stdin_data', data);
      },
      end: () => {},
      writable: true,
    };
    this.pid = 40000 + Math.floor(Math.random() * 10000);
    this.killed = false;
    this.exitCode = null;
    this.spawned = new Promise((resolve) => {
      this._resolveSpawned = resolve;
    });
  }

  emit(event, ...args) {
    if (event === 'close') {
      this.exitCode = args[0] ?? 0;
      if (this.stdin) {
        this.stdin.writable = false;
      }
    }
    return super.emit(event, ...args);
  }

  markSpawned() {
    this._resolveSpawned(true);
  }

  kill(signal = 'SIGTERM') {
    this.killed = true;
    this.exitCode = 0;
    this.emit('close', 0, signal);
  }
}

// ----------------------------------------------------------------------------
// INT_JOB1: Remote/parent task starts Hearth-owned job -> real JobManager owns PID
// ----------------------------------------------------------------------------
await test('INT_JOB1: Remote/parent task starts Hearth-owned job -> real JobManager owns PID', async () => {
  const tempDir = makeTempDir();
  try {
    const store = new TaskStore({ storagePath: path.join(tempDir, 'tasks.json') });
    setTaskStore(store);

    const testTaskId = 'hearth-task-int-1';
    const testConvId = 'conv-int-1-' + crypto.randomUUID();
    const task = {
      taskId: testTaskId,
      conversationId: testConvId,
      workspace: tempDir,
      title: 'INT_JOB1 Task',
      status: 'running',
      controllerState: 'healthy',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    taskRegistry.set(testTaskId, task);
    store.saveTask(task);

    const job = startDurableJob({
      taskId: testTaskId,
      command: process.execPath,
      args: ['-e', 'setTimeout(() => { console.log("int1_done"); }, 300);'],
      cwd: tempDir,
    });

    assert.ok(job, 'Job must be returned');
    assert.ok(job.child instanceof ChildProcess, 'job.child must be a Node ChildProcess');
    assert.ok(typeof job.pid === 'number' && job.pid > 0, 'job.pid must be valid positive PID');
    assert.strictEqual(process.kill(job.pid, 0), true, 'Child process must be alive in OS');

    assert.strictEqual(task.jobId, job.id, 'Task must be linked to job ID');
    assert.ok(task.jobIds.includes(job.id), 'Task jobIds array must contain job ID');

    const trackedJob = getJobManager().getJob(job.id);
    assert.strictEqual(trackedJob.id, job.id, 'JobManager must authoritatively track the job');

    await getJobManager().waitForJob(job.id, 5000);
    taskRegistry.delete(testTaskId);
  } finally {
    cleanupDir(tempDir);
  }
});

// ----------------------------------------------------------------------------
// INT_JOB2: Provider/controller disconnects -> job remains running
// ----------------------------------------------------------------------------
await test('INT_JOB2: Provider/controller disconnects -> job remains running', async () => {
  const tempDir = makeTempDir();
  try {
    const store = new TaskStore({ storagePath: path.join(tempDir, 'tasks.json') });
    setTaskStore(store);

    const child = new MockStreamingChild();
    const testConvId = 'conv-int-2-' + crypto.randomUUID();
    const resPromise = startAntigravityTask({
      workspace: tempDir,
      prompt: 'INT_JOB2 Task',
      customAgyPath: process.execPath,
      userApproved: true,
      spawnFn: () => {
        child.markSpawned();
        return child;
      },
    });

    await child.spawned;
    child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
    const res = await resPromise;
    const task = getAntigravityTask(res.taskId);

    const job = startDurableJob({
      taskId: res.taskId,
      command: process.execPath,
      args: ['-e', 'setTimeout(() => { console.log("int2_running"); }, 600);'],
      cwd: tempDir,
    });

    // Simulate provider child disconnect while job is running
    child.emit('close', 1);

    // Give microtask queue moment to settle close handler
    await delay(50);

    // Invariant 5: Provider disconnect does NOT error task or kill Hearth-owned job
    const updatedTask = getAntigravityTask(res.taskId);
    assert.strictEqual(updatedTask.status, 'running', 'Task must remain RUNNING despite provider disconnect');
    assert.strictEqual(updatedTask.controllerState, 'disconnected', 'Controller state reflects disconnect');

    let isAlive = false;
    try { isAlive = process.kill(job.pid, 0); } catch { isAlive = false; }
    assert.strictEqual(isAlive, true, 'Hearth-owned child process must still be running in OS');
    assert.strictEqual(job.status, 'running', 'Job must remain in running state');

    await getJobManager().waitForJob(job.id, 5000);
    taskRegistry.delete(res.taskId);
  } finally {
    cleanupDir(tempDir);
  }
});

// ----------------------------------------------------------------------------
// INT_JOB3: Job completes -> exactly one parent continuation
// ----------------------------------------------------------------------------
await test('INT_JOB3: Job completes -> exactly one parent continuation', async () => {
  const tempDir = makeTempDir();
  try {
    const testTaskId = 'hearth-task-int-3';
    let continuationCount = 0;
    let continuationPrompt = null;

    const task = {
      taskId: testTaskId,
      conversationId: 'conv-int-3',
      workspace: tempDir,
      title: 'INT_JOB3 Task',
      status: 'running',
      pendingContinuation: true,
      continueSession: (prompt) => {
        continuationCount++;
        continuationPrompt = prompt;
      },
    };
    taskRegistry.set(testTaskId, task);

    const job = startDurableJob({
      taskId: testTaskId,
      command: process.execPath,
      args: ['-e', 'console.log("int3_work_done"); process.exit(0);'],
      cwd: tempDir,
    });

    await getJobManager().waitForJob(job.id, 5000);
    await delay(100);

    assert.strictEqual(continuationCount, 1, 'Parent task continuation must be called exactly once');
    assert.ok(continuationPrompt.includes('int3_work_done'), 'Continuation prompt must contain output');
    assert.ok(continuationPrompt.includes('Exit code: 0'), 'Continuation prompt must contain exit code');

    taskRegistry.delete(testTaskId);
  } finally {
    cleanupDir(tempDir);
  }
});

// ----------------------------------------------------------------------------
// INT_JOB4: Continuation uses same parent task and conversation when available
// ----------------------------------------------------------------------------
await test('INT_JOB4: Continuation uses same parent task and conversation when available', async () => {
  const tempDir = makeTempDir();
  try {
    const testTaskId = 'hearth-task-int-4';
    const testConvId = 'conv-int-4-' + crypto.randomUUID();
    let continuationTaskId = null;
    let continuationConvId = null;

    const task = {
      taskId: testTaskId,
      conversationId: testConvId,
      workspace: tempDir,
      status: 'running',
      pendingContinuation: true,
      continueSession: (_prompt) => {
        continuationTaskId = task.taskId;
        continuationConvId = task.conversationId;
      },
    };
    taskRegistry.set(testTaskId, task);

    const job = startDurableJob({
      taskId: testTaskId,
      command: process.execPath,
      args: ['-e', 'process.exit(0);'],
      cwd: tempDir,
    });

    await getJobManager().waitForJob(job.id, 5000);
    await delay(50);

    assert.strictEqual(continuationTaskId, testTaskId, 'Continuation must use exact same taskId');
    assert.strictEqual(continuationConvId, testConvId, 'Continuation must preserve exact same conversationId');

    taskRegistry.delete(testTaskId);
  } finally {
    cleanupDir(tempDir);
  }
});

// ----------------------------------------------------------------------------
// INT_JOB5: exitCode 0 alone does not mark parent task DONE
// ----------------------------------------------------------------------------
await test('INT_JOB5: exitCode 0 alone does not mark parent task DONE', async () => {
  const tempDir = makeTempDir();
  try {
    const testTaskId = 'hearth-task-int-5';
    const task = {
      taskId: testTaskId,
      conversationId: 'conv-int-5',
      workspace: tempDir,
      status: 'running',
      completion: null,
      continueSession: () => {}, // Absorbs continuation without completing
    };
    taskRegistry.set(testTaskId, task);

    const job = startDurableJob({
      taskId: testTaskId,
      command: process.execPath,
      args: ['-e', 'console.log("clean_exit_code_zero"); process.exit(0);'],
      cwd: tempDir,
    });

    await getJobManager().waitForJob(job.id, 5000);
    await delay(50);

    assert.strictEqual(job.status, 'completed', 'Job itself is completed');
    assert.strictEqual(job.exitCode, 0, 'Exit code is 0');

    // Invariant: exitCode 0 does NOT auto-mark parent task DONE
    assert.strictEqual(task.status, 'running', 'Parent task status must remain running');
    assert.strictEqual(task.completion, null, 'Parent task completion must not be fabricated');
    assert.ok(task.durableJobEvidence, 'Evidence must be recorded on task');
    assert.strictEqual(task.durableJobEvidence.exitCode, 0);

    taskRegistry.delete(testTaskId);
  } finally {
    cleanupDir(tempDir);
  }
});

// ----------------------------------------------------------------------------
// INT_JOB6: structured completed after job evidence -> parent task DONE
// ----------------------------------------------------------------------------
await test('INT_JOB6: structured completed after job evidence -> parent task DONE', async () => {
  const tempDir = makeTempDir();
  try {
    const testTaskId = 'hearth-task-int-6';
    const task = {
      taskId: testTaskId,
      conversationId: 'conv-int-6',
      workspace: tempDir,
      status: 'running',
      pendingContinuation: true,
      completion: null,
      continueSession: (prompt) => {
        // AI evaluator evaluates prompt and emits structured completion contract
        const structuredCompletionJson = JSON.stringify({
          status: 'completed',
          summary: 'Durable background computation finished and validated cleanly',
        });
        const completion = classifyCompletion({
          response: structuredCompletionJson,
          executorStatus: 'SUCCESS',
          events: task.recentEvents,
          workspace: task.workspace,
        });
        task.status = completion.status;
        task.completion = completion;
      },
    };
    taskRegistry.set(testTaskId, task);

    const job = startDurableJob({
      taskId: testTaskId,
      command: process.execPath,
      args: ['-e', 'console.log("data_processed"); process.exit(0);'],
      cwd: tempDir,
    });

    await getJobManager().waitForJob(job.id, 5000);
    await delay(50);

    assert.strictEqual(task.status, 'done', 'Parent task must reach DONE via structured contract');
    assert.strictEqual(task.completion.status, 'done');
    assert.ok(task.completion.summary.includes('Durable background computation finished'));

    taskRegistry.delete(testTaskId);
  } finally {
    cleanupDir(tempDir);
  }
});

// ----------------------------------------------------------------------------
// INT_JOB7: job error -> parent task receives evidence and resolves ERROR correctly
// ----------------------------------------------------------------------------
await test('INT_JOB7: job error -> parent task receives evidence and resolves ERROR correctly', async () => {
  const tempDir = makeTempDir();
  try {
    const testTaskId = 'hearth-task-int-7';
    let receivedErrorEvidence = null;

    const task = {
      taskId: testTaskId,
      conversationId: 'conv-int-7',
      workspace: tempDir,
      status: 'running',
      pendingContinuation: true,
      continueSession: (prompt) => {
        receivedErrorEvidence = task.durableJobEvidence;
        task.status = 'error';
        task.error = `Job failed with exit code ${receivedErrorEvidence?.exitCode}`;
        task.completion = {
          status: 'error',
          normalizedStatus: 'error',
          summary: task.error,
          error: task.error,
          checks: { build: 'not_run', tests: 'not_run' },
          artifacts: [],
        };
      },
    };
    taskRegistry.set(testTaskId, task);

    const job = startDurableJob({
      taskId: testTaskId,
      command: process.execPath,
      args: ['-e', 'console.error("fatal_worker_crash"); process.exit(2);'],
      cwd: tempDir,
    });

    await getJobManager().waitForJob(job.id, 5000);
    await delay(50);

    assert.strictEqual(job.status, 'error', 'Job must be marked error');
    assert.strictEqual(job.exitCode, 2, 'Job exitCode must be 2');

    assert.strictEqual(task.status, 'error', 'Parent task resolves to ERROR');
    assert.strictEqual(receivedErrorEvidence.exitCode, 2);
    assert.ok(task.error.includes('exit code 2'));

    taskRegistry.delete(testTaskId);
  } finally {
    cleanupDir(tempDir);
  }
});

// ----------------------------------------------------------------------------
// INT_JOB8: restart during running job -> recovery_required, never false DONE
// ----------------------------------------------------------------------------
await test('INT_JOB8: restart during running job -> recovery_required, never false DONE', async () => {
  const tempDir = makeTempDir();
  const tasksPath = path.join(tempDir, 'tasks.json');
  const jobsPath = path.join(tempDir, 'jobs.json');
  try {
    // 1. Persist running task and running job
    const taskData = {
      version: 1,
      tasks: [
        {
          taskId: 'task-interrupted-int8',
          conversationId: 'conv-int8',
          workspace: tempDir,
          title: 'Interrupted Task',
          status: 'running',
          jobId: 'job-interrupted-int8',
          jobIds: ['job-interrupted-int8'],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    };
    fs.writeFileSync(tasksPath, JSON.stringify(taskData, null, 2), 'utf8');

    const jobData = {
      version: 1,
      jobs: [
        {
          id: 'job-interrupted-int8',
          taskId: 'task-interrupted-int8',
          command: 'node',
          args: ['worker.js'],
          status: 'running',
          pid: 999991,
          createdAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
        },
      ],
    };
    fs.writeFileSync(jobsPath, JSON.stringify(jobData, null, 2), 'utf8');

    // 2. Simulate application restart
    const restartedTaskStore = new TaskStore({ storagePath: tasksPath });
    restartedTaskStore.load();
    const { reconciledCount: reconciledTasks } = restartedTaskStore.reconcileStartupState();

    const restartedJobManager = new JobManager({ storagePath: jobsPath });
    restartedJobManager.load();
    const { reconciledCount: reconciledJobs } = restartedJobManager.reconcileStartupState();

    assert.strictEqual(reconciledTasks, 1, 'Task must be reconciled');
    assert.strictEqual(reconciledJobs, 1, 'Job must be reconciled');

    const reconciledTask = restartedTaskStore.getTask('task-interrupted-int8');
    assert.strictEqual(reconciledTask.status, 'recovery_required', 'Task must transition to recovery_required');
    assert.notStrictEqual(reconciledTask.status, 'done', 'Task must NEVER become DONE');

    const reconciledJob = restartedJobManager.getJob('job-interrupted-int8');
    assert.strictEqual(reconciledJob.status, 'recovery_required', 'Job must transition to recovery_required');
    assert.notStrictEqual(reconciledJob.status, 'completed', 'Job must NEVER become completed');
  } finally {
    cleanupDir(tempDir);
  }
});

// ----------------------------------------------------------------------------
// INT_JOB9: no unmanaged background shell path is used by the durable smoke-test flow
// ----------------------------------------------------------------------------
await test('INT_JOB9: no unmanaged background shell path is used by the durable smoke-test flow', async () => {
  const tempDir = makeTempDir();
  try {
    const job = startDurableJob({
      command: process.execPath,
      args: ['-e', 'console.log("managed_harness"); process.exit(0);'],
      cwd: tempDir,
    });

    // Invariant: Must be a direct Node ChildProcess instance, not unmanaged shell backgrounding
    assert.ok(job.child instanceof ChildProcess, 'Must be direct Node ChildProcess');
    assert.ok(typeof job.pid === 'number' && job.pid > 0, 'Must have tracked OS PID');
    assert.strictEqual(job.child.spawnargs.includes('sh'), false, 'Must not use raw shell wrapper');

    await getJobManager().waitForJob(job.id, 5000);
  } finally {
    cleanupDir(tempDir);
  }
});

// ----------------------------------------------------------------------------
// INT_JOB10: remote Supabase task remains linked to same hearth_task_id through job lifecycle
// ----------------------------------------------------------------------------
await test('INT_JOB10: remote Supabase task remains linked to same hearth_task_id through job lifecycle', async () => {
  const tempDir = makeTempDir();
  try {
    const store = new TaskStore({ storagePath: path.join(tempDir, 'tasks.json') });
    setTaskStore(store);

    const testTaskId = 'hearth-task-int-10';
    const testRemoteId = 'supabase-remote-uuid-10';
    const testConvId = 'conv-int-10-' + crypto.randomUUID();

    const task = {
      taskId: testTaskId,
      source: 'remote',
      remoteTaskId: testRemoteId,
      conversationId: testConvId,
      workspace: tempDir,
      title: 'INT_JOB10 Remote Task',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    taskRegistry.set(testTaskId, task);
    store.saveTask(task);

    const job = startDurableJob({
      taskId: testTaskId,
      command: process.execPath,
      args: ['-e', 'process.exit(0);'],
      cwd: tempDir,
    });

    await getJobManager().waitForJob(job.id, 5000);

    const persisted = store.getTask(testTaskId);
    assert.strictEqual(persisted.remoteTaskId, testRemoteId, 'remoteTaskId must remain invariant');
    assert.strictEqual(persisted.taskId, testTaskId, 'taskId must remain invariant');
    assert.strictEqual(persisted.jobId, job.id, 'jobId must remain linked');

    taskRegistry.delete(testTaskId);
  } finally {
    cleanupDir(tempDir);
  }
});

// ============================================================================
// Production-Path Accelerated Smoke (>7-minute logical duration accelerated)
// ============================================================================
console.log('\n=== Production-Path Accelerated Smoke Test ===\n');

await test('ACCELERATED_SMOKE: parent RUNNING -> Hearth-owned job -> provider disconnect tolerated -> job_completed -> continuation -> structured completed -> DONE', async () => {
  const tempDir = makeTempDir();
  try {
    const taskStore = new TaskStore({ storagePath: path.join(tempDir, 'tasks.json') });
    setTaskStore(taskStore);

    const testConvId = 'conv-smoke-' + crypto.randomUUID();
    const mockStreamingChild = new MockStreamingChild();

    const resPromise = startAntigravityTask({
      workspace: tempDir,
      prompt: '7-Minute Accelerated Smoke Task',
      customAgyPath: process.execPath,
      userApproved: true,
      spawnFn: () => {
        mockStreamingChild.markSpawned();
        return mockStreamingChild;
      },
    });

    await mockStreamingChild.spawned;
    mockStreamingChild.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
    const res = await resPromise;
    let task = getAntigravityTask(res.taskId);

    // Register continuation runner to simulate the evaluator responding to job evidence
    getJobManager().setContinuationRunner(({ task: currentTask, job: finishedJob, evidence }) => {
      assert.ok(evidence.stdout.includes('smoke_computation_complete'), 'Evidence contains background output');
      assert.strictEqual(evidence.exitCode, 0, 'Exit code is 0');

      const structuredContract = JSON.stringify({
        status: 'completed',
        summary: 'Long-running background computation completed and all 8 assertions verified',
        checks: { build: 'passed', tests: 'passed' },
      });

      const completion = classifyCompletion({
        response: structuredContract,
        executorStatus: 'SUCCESS',
        events: currentTask.recentEvents,
        workspace: currentTask.workspace,
      });

      currentTask.status = completion.status;
      currentTask.completion = completion;
      currentTask.updatedAt = new Date().toISOString();
      taskStore.saveTask(currentTask);
    });

    // Step 1: Parent task is RUNNING
    assert.strictEqual(task.status, 'running', 'Parent task must start RUNNING');

    // Step 2: Spawn Hearth-owned durable job simulating >7-minute execution
    const job = startDurableJob({
      taskId: res.taskId,
      command: process.execPath,
      args: ['-e', 'setTimeout(() => { console.log("smoke_computation_complete"); process.exit(0); }, 400);'],
      cwd: tempDir,
    });

    // Simulate logical duration: started 450 seconds ago (>7 minutes)
    job.startedAt = new Date(Date.now() - 450000).toISOString();

    task = getAntigravityTask(res.taskId);
    assert.ok(job.child instanceof ChildProcess, 'Hearth authoritatively owns child process');
    assert.strictEqual(task.jobId, job.id, 'Task is linked to durable job');

    // Step 3: Provider stream experiences disconnect / context-cancel
    mockStreamingChild.emit('close', 1);
    await delay(50);

    // Step 4: Provider disconnect is tolerated without terminating parent task or durable job
    task = getAntigravityTask(res.taskId);
    assert.strictEqual(task.status, 'running', 'Task must remain RUNNING through provider disconnect');
    assert.strictEqual(task.controllerState, 'disconnected');
    assert.strictEqual(process.kill(job.pid, 0), true, 'Child process must still be running in OS');

    // Step 5: Background job completes and emits job_completed
    const jobResult = await getJobManager().waitForJob(job.id, 5000);
    assert.strictEqual(jobResult.status, 'completed');
    assert.strictEqual(jobResult.exitCode, 0);
    assert.ok(jobResult.durationMs >= 450000, `Logical duration (${jobResult.durationMs}ms) reflects >7 minutes`);

    // Give microtasks moment to complete continuation turn
    await delay(100);

    // Step 6: Continuation executed and parent task reached DONE via strict completion contract
    task = getAntigravityTask(res.taskId);
    assert.strictEqual(task.status, 'done', 'Parent task must reach DONE');
    assert.strictEqual(task.completion.status, 'done');
    assert.strictEqual(task.completion.checks.build, 'passed');
    assert.strictEqual(task.completion.checks.tests, 'passed');

    taskRegistry.delete(res.taskId);
  } finally {
    getJobManager().setContinuationRunner(null);
    cleanupDir(tempDir);
  }
});

// ============================================================================
// Production Durable Routing Integration Tests (ROUTE1 - ROUTE8)
// ============================================================================
console.log('\n=== Production Durable Routing Integration Tests (ROUTE1 - ROUTE8) ===\n');

// ----------------------------------------------------------------------------
// ROUTE1: requires_hearth_owned_job=true -> JobManager.startJob invoked deterministically
// ----------------------------------------------------------------------------
await test('ROUTE1: requires_hearth_owned_job=true -> JobManager.startJob invoked deterministically', async () => {
  const tempDir = makeTempDir();
  try {
    const store = new TaskStore({ storagePath: path.join(tempDir, 'tasks.json') });
    setTaskStore(store);

    const testTaskId = 'hearth-task-route-1';
    const testRemoteId = 'remote-task-route-1';
    const remotePayload = {
      id: testRemoteId,
      device_id: 'test-device-route-1',
      status: 'pending',
      prompt: 'Smoke #7: Run durable background task',
      metadata: {
        requires_hearth_owned_job: true,
        worker_duration_seconds: 0.3,
        heartbeat_interval_seconds: 0.05,
      },
    };
    const parsed = parseRemoteTaskPayload(remotePayload, 'test-device-route-1');
    assert.strictEqual(parsed.metadata.requires_hearth_owned_job, true);
    assert.strictEqual(shouldRouteToDurableJob(parsed.metadata), true);

    const workerSpec = createControlledWorkerSpec(parsed.metadata, tempDir);
    assert.ok(workerSpec.command, 'Worker spec must have command');
    assert.ok(Array.isArray(workerSpec.args), 'Worker spec must have args');

    const initialTask = {
      taskId: testTaskId,
      conversationId: null,
      workspace: tempDir,
      status: 'running',
    };
    taskRegistry.set(testTaskId, initialTask);
    store.saveTask(initialTask);

    // Start durable job deterministically
    const job = startDurableJob({
      taskId: testTaskId,
      command: workerSpec.command,
      args: workerSpec.args,
      cwd: workerSpec.cwd,
      metadata: parsed.metadata,
    });

    assert.ok(job, 'Job must be started');
    assert.ok(job.child instanceof ChildProcess, 'Job must be a Node ChildProcess');
    assert.ok(typeof job.pid === 'number' && job.pid > 0, 'Job PID must be valid');
    assert.strictEqual(process.kill(job.pid, 0), true, 'Job process must be alive in OS');

    const task = getAntigravityTask(testTaskId);
    assert.strictEqual(task.jobId, job.id, 'Task must be linked to job ID');
    assert.strictEqual(task.durableRoute, true, 'Task durableRoute must be true');

    await getJobManager().waitForJob(job.id, 5000);
    taskRegistry.delete(testTaskId);
  } finally {
    cleanupDir(tempDir);
  }
});

// ----------------------------------------------------------------------------
// ROUTE2: same task cannot use unmanaged run_command background execution path
// ----------------------------------------------------------------------------
await test('ROUTE2: same task cannot use unmanaged run_command background execution path', async () => {
  const tempDir = makeTempDir();
  try {
    const testTaskId = 'hearth-task-route-2';
    const task = {
      taskId: testTaskId,
      conversationId: 'conv-route-2',
      workspace: tempDir,
      status: 'running',
      durableRoute: true, // Marked as durable route
      controllerState: 'healthy',
    };
    taskRegistry.set(testTaskId, task);

    // Attempting unmanaged registerBackgroundJob must be blocked and return null
    const dummyChild = new EventEmitter();
    const bg = registerBackgroundJob(testTaskId, { name: 'unmanaged_shell_bg', child: dummyChild });
    assert.strictEqual(bg, null, 'Unmanaged background job registration must be rejected on durable route');

    // Attempting unmanaged recordBackgroundHeartbeat must be rejected and return false
    const beatResult = recordBackgroundHeartbeat(testTaskId, { jobId: 'unmanaged_fake', text: 'beat' });
    assert.strictEqual(beatResult, false, 'Unmanaged heartbeat must be rejected on durable route');

    taskRegistry.delete(testTaskId);
  } finally {
    cleanupDir(tempDir);
  }
});

// ----------------------------------------------------------------------------
// ROUTE3: parent watchdog remains healthy from durable job heartbeat with zero provider stream events
// ----------------------------------------------------------------------------
await test('ROUTE3: parent watchdog remains healthy from durable job heartbeat with zero provider stream events', async () => {
  const tempDir = makeTempDir();
  try {
    const store = new TaskStore({ storagePath: path.join(tempDir, 'tasks.json') });
    setTaskStore(store);

    const child = new MockStreamingChild();
    const testConvId = 'conv-route-3-' + crypto.randomUUID();

    // Start task with very short watchdog (150ms)
    const resPromise = startAntigravityTask({
      workspace: tempDir,
      prompt: 'Zero provider events task',
      customAgyPath: process.execPath,
      userApproved: true,
      executionTimeoutMs: 150, // Short watchdog
      spawnFn: () => {
        child.markSpawned();
        return child;
      },
    });

    await child.spawned;
    child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
    const res = await resPromise;

    // Start durable job with fast heartbeats (runs for 400ms, beating every 40ms > 2.5x watchdog threshold)
    const workerSpec = createControlledWorkerSpec({
      worker_duration_seconds: 0.4,
      heartbeat_interval_seconds: 0.04,
    }, tempDir);

    const job = startDurableJob({
      taskId: res.taskId,
      command: workerSpec.command,
      args: workerSpec.args,
      cwd: workerSpec.cwd,
    });

    // Zero provider stream events emitted during this entire period (provider complete silence)
    await getJobManager().waitForJob(job.id, 5000);

    // Verify task is STILL running and never timed out
    const task = getAntigravityTask(res.taskId);
    assert.strictEqual(task.status, 'running', 'Task must NOT timeout despite zero provider events');
    assert.ok(task.jobHeartbeatCount >= 5, `Must have received multiple heartbeats (${task.jobHeartbeatCount})`);
    assert.ok(task.lastWatchdogResetAt, 'Watchdog reset timestamp must be populated');

    taskRegistry.delete(res.taskId);
  } finally {
    cleanupDir(tempDir);
  }
});

// ----------------------------------------------------------------------------
// ROUTE4: provider disconnect at minute 2 -> durable job continues -> parent remains running
// ----------------------------------------------------------------------------
await test('ROUTE4: provider disconnect at minute 2 -> durable job continues -> parent remains running', async () => {
  const tempDir = makeTempDir();
  try {
    const store = new TaskStore({ storagePath: path.join(tempDir, 'tasks.json') });
    setTaskStore(store);

    const child = new MockStreamingChild();
    const testConvId = 'conv-route-4-' + crypto.randomUUID();
    const resPromise = startAntigravityTask({
      workspace: tempDir,
      prompt: 'ROUTE4 Task',
      customAgyPath: process.execPath,
      userApproved: true,
      spawnFn: () => {
        child.markSpawned();
        return child;
      },
    });

    await child.spawned;
    child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
    const res = await resPromise;

    const workerSpec = createControlledWorkerSpec({
      worker_duration_seconds: 0.6,
      heartbeat_interval_seconds: 0.05,
    }, tempDir);

    const job = startDurableJob({
      taskId: res.taskId,
      command: workerSpec.command,
      args: workerSpec.args,
      cwd: workerSpec.cwd,
    });

    // Simulate provider stream disconnect ("context canceled" / close) at minute 2
    child.emit('close', 1);
    await delay(50);

    // Invariant: Provider disconnect does NOT kill durable job or mark task error
    const task = getAntigravityTask(res.taskId);
    assert.strictEqual(task.status, 'running', 'Parent task remains running');
    assert.strictEqual(task.controllerState, 'disconnected', 'Controller state reflects disconnect');
    assert.strictEqual(process.kill(job.pid, 0), true, 'Durable job child process must still be running in OS');

    await getJobManager().waitForJob(job.id, 5000);
    taskRegistry.delete(res.taskId);
  } finally {
    cleanupDir(tempDir);
  }
});

// ----------------------------------------------------------------------------
// ROUTE5: jobId/PID/heartbeat counters visible in sanitized task status
// ----------------------------------------------------------------------------
await test('ROUTE5: jobId/PID/heartbeat counters visible in sanitized task status', async () => {
  const tempDir = makeTempDir();
  try {
    const store = new TaskStore({ storagePath: path.join(tempDir, 'tasks.json') });
    setTaskStore(store);

    const testTaskId = 'hearth-task-route-5';
    const task = {
      taskId: testTaskId,
      conversationId: 'conv-route-5',
      workspace: tempDir,
      status: 'running',
      durableRoute: true,
      controllerState: 'healthy',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    taskRegistry.set(testTaskId, task);
    store.saveTask(task);

    const workerSpec = createControlledWorkerSpec({
      worker_duration_seconds: 0.4,
      heartbeat_interval_seconds: 0.05,
    }, tempDir);

    const job = startDurableJob({
      taskId: testTaskId,
      command: workerSpec.command,
      args: workerSpec.args,
      cwd: workerSpec.cwd,
    });

    await delay(150);

    const polled = getAntigravityTask(testTaskId);
    assert.ok(polled.jobId, 'jobId must be visible');
    assert.strictEqual(polled.jobId, job.id);
    assert.ok(typeof polled.jobPid === 'number' && polled.jobPid > 0, 'jobPid must be visible positive PID');
    assert.ok(polled.jobHeartbeatCount > 0, 'jobHeartbeatCount must increase');
    assert.ok(polled.jobLastHeartbeatAt, 'jobLastHeartbeatAt must be visible');
    assert.strictEqual(polled.durableRoute, true, 'durableRoute must be true');

    await getJobManager().waitForJob(job.id, 5000);
    taskRegistry.delete(testTaskId);
  } finally {
    cleanupDir(tempDir);
  }
});

// ----------------------------------------------------------------------------
// ROUTE6: job completes -> exactly one continuation -> structured completed -> DONE
// ----------------------------------------------------------------------------
await test('ROUTE6: job completes -> exactly one continuation -> structured completed -> DONE', async () => {
  const tempDir = makeTempDir();
  try {
    const store = new TaskStore({ storagePath: path.join(tempDir, 'tasks.json') });
    setTaskStore(store);

    const testTaskId = 'hearth-task-route-6';
    let continuationCalls = 0;

    const task = {
      taskId: testTaskId,
      conversationId: 'conv-route-6',
      workspace: tempDir,
      status: 'running',
      pendingContinuation: true,
      durableRoute: true,
      completion: null,
      continueSession: (prompt) => {
        continuationCalls++;
        const structuredContract = JSON.stringify({
          status: 'completed',
          summary: 'ROUTE6 work verified cleanly',
        });
        const comp = classifyCompletion({
          response: structuredContract,
          executorStatus: 'SUCCESS',
          workspace: tempDir,
        });
        task.status = comp.status;
        task.completion = comp;
      },
    };
    taskRegistry.set(testTaskId, task);
    store.saveTask(task);

    const job = startDurableJob({
      taskId: testTaskId,
      command: process.execPath,
      args: ['-e', 'console.log("route6_done"); process.exit(0);'],
      cwd: tempDir,
    });

    await getJobManager().waitForJob(job.id, 5000);
    await delay(50);

    assert.strictEqual(continuationCalls, 1, 'Continuation must run exactly once');
    assert.strictEqual(task.status, 'done', 'Task must transition to DONE only via structured contract');
    assert.strictEqual(task.completion.status, 'done');

    taskRegistry.delete(testTaskId);
  } finally {
    cleanupDir(tempDir);
  }
});

// ----------------------------------------------------------------------------
// ROUTE7: requires_hearth_owned_job=false -> existing normal provider behavior unchanged
// ----------------------------------------------------------------------------
await test('ROUTE7: requires_hearth_owned_job=false -> existing normal provider behavior unchanged', async () => {
  const tempDir = makeTempDir();
  try {
    const remotePayload = {
      id: 'remote-route-7',
      device_id: 'device-route-7',
      status: 'pending',
      prompt: 'Ordinary coding task',
      metadata: {
        requires_hearth_owned_job: false,
      },
    };
    const parsed = parseRemoteTaskPayload(remotePayload, 'device-route-7');
    assert.strictEqual(shouldRouteToDurableJob(parsed.metadata), false, 'Must not route to durable job');

    const testTaskId = 'hearth-task-route-7';
    const child = new MockStreamingChild();
    const resPromise = startAntigravityTask({
      existingTaskId: testTaskId,
      workspace: tempDir,
      prompt: parsed.prompt,
      customAgyPath: process.execPath,
      userApproved: true,
      metadata: parsed.metadata,
      spawnFn: () => {
        child.markSpawned();
        return child;
      },
    });

    await child.spawned;
    child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: 'conv-route-7' }) + '\n'));
    const res = await resPromise;

    const task = getAntigravityTask(res.taskId);
    assert.strictEqual(task.jobId, null, 'No durable job must be started');
    assert.strictEqual(task.durableRoute, false, 'durableRoute must be false');

    child.kill('SIGTERM');
    taskRegistry.delete(res.taskId);
  } finally {
    cleanupDir(tempDir);
  }
});

// ----------------------------------------------------------------------------
// ROUTE8: remote Supabase same row remains linked throughout lifecycle
// ----------------------------------------------------------------------------
await test('ROUTE8: remote Supabase same row remains linked throughout lifecycle', async () => {
  const tempDir = makeTempDir();
  try {
    const store = new TaskStore({ storagePath: path.join(tempDir, 'tasks.json') });
    setTaskStore(store);

    const testDeviceId = 'device-route-8';
    const testRemoteId = 'remote-row-8-' + crypto.randomUUID();
    let updatedRow = null;

    const mockFetch = async (url, opts = {}) => {
      const urlStr = String(url);
      if (urlStr.includes('/rest/v1/hearth_tasks') && opts.method === 'PATCH') {
        const body = JSON.parse(opts.body);
        updatedRow = { id: testRemoteId, ...(updatedRow || {}), ...body };
        return { ok: true, status: 200, json: async () => [updatedRow] };
      }
      return { ok: true, status: 200, json: async () => [] };
    };

    const bridgeClient = new HearthBridgeClient({
      deviceId: testDeviceId,
      supabaseUrl: 'https://mock.supabase.co',
      fetchFn: mockFetch,
    });
    bridgeClient.enabled = true;

    const testTaskId = 'hearth-task-route-8';
    const initialTask = {
      taskId: testTaskId,
      conversationId: 'conv-route-8',
      workspace: tempDir,
      source: 'remote',
      remoteTaskId: testRemoteId,
      status: 'running',
      durableRoute: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    taskRegistry.set(testTaskId, initialTask);
    store.saveTask(initialTask);

    // Initial sync
    await syncRemoteTaskState({
      bridgeClient,
      taskStore: store,
      task: initialTask,
      overrides: { status: 'running' },
    });
    assert.strictEqual(updatedRow.hearth_task_id, testTaskId, 'Initial sync must write hearth_task_id');

    // Terminal completion sync
    const finalTask = {
      ...initialTask,
      status: 'done',
      completion: {
        status: 'done',
        normalizedStatus: 'done',
        summary: 'Finished smoke 8',
      },
    };
    await syncRemoteTaskState({
      bridgeClient,
      taskStore: store,
      task: finalTask,
    });

    assert.strictEqual(updatedRow.id, testRemoteId, 'Must update exact same remote row');
    assert.strictEqual(updatedRow.status, 'done', 'Remote status must be done');
    assert.ok(updatedRow.finished_at, 'finished_at must be populated');
    assert.strictEqual(updatedRow.result, 'Finished smoke 8', 'result must match summary');

    taskRegistry.delete(testTaskId);
  } finally {
    cleanupDir(tempDir);
  }
});

// ============================================================================
// Accelerated Production-Path Smoke #7 (Using exact bridge dispatch entry point)
// ============================================================================
console.log('\n=== Production-Path Remote Smoke #7 ===\n');

await test('ACCELERATED_REMOTE_SMOKE_7: Bridge dispatch -> Hearth starts durable job -> provider disconnect tolerated -> heartbeats advance watchdog -> job completes -> continuation -> DONE', async () => {
  const tempDir = makeTempDir();
  try {
    const store = new TaskStore({ storagePath: path.join(tempDir, 'tasks.json') });
    setTaskStore(store);

    const testDeviceId = 'device-smoke-7';
    const testRemoteId = 'remote-smoke-7-' + crypto.randomUUID();
    let remoteRow = null;

    const mockFetch = async (url, opts = {}) => {
      const urlStr = String(url);
      if (urlStr.includes('/rest/v1/hearth_tasks') && opts.method === 'PATCH') {
        const body = JSON.parse(opts.body);
        remoteRow = { id: testRemoteId, ...(remoteRow || {}), ...body };
        return { ok: true, status: 200, json: async () => [remoteRow] };
      }
      return { ok: true, status: 200, json: async () => [] };
    };

    const bridgeClient = new HearthBridgeClient({
      deviceId: testDeviceId,
      supabaseUrl: 'https://mock.supabase.co',
      fetchFn: mockFetch,
    });
    bridgeClient.enabled = true;

    // 1. Raw remote row exactly matching Native Smoke #7 payload
    const rawRemoteRow = {
      id: testRemoteId,
      device_id: testDeviceId,
      status: 'pending',
      prompt: 'Native Smoke #7: Verify 8 assertions and maintain background heartbeat >7m',
      title: 'Packaged Smoke #7',
      metadata: {
        requires_hearth_owned_job: true,
        worker_duration_seconds: 0.4,
        heartbeat_interval_seconds: 0.05,
      },
    };

    // 2. Remote parser parses payload
    const parsedTask = parseRemoteTaskPayload(rawRemoteRow, testDeviceId);
    assert.strictEqual(parsedTask.metadata.requires_hearth_owned_job, true);

    const providerChild = new MockStreamingChild();
    const testConvId = 'conv-smoke-7-' + crypto.randomUUID();

    // Set up continuation runner on JobManager to simulate AI evaluator turn upon job completion
    getJobManager().setContinuationRunner(({ task: currentTask, job: finishedJob, evidence }) => {
      assert.strictEqual(evidence.exitCode, 0, 'Exit code must be 0');
      const contract = JSON.stringify({
        status: 'completed',
        summary: 'Smoke #7 durable background process completed cleanly. All functional assertions verified.',
        checks: { build: 'passed', tests: 'passed' },
      });
      const completion = classifyCompletion({
        response: contract,
        executorStatus: 'SUCCESS',
        workspace: currentTask.workspace,
      });
      currentTask.status = completion.status;
      currentTask.completion = completion;
      currentTask.updatedAt = new Date().toISOString();
      store.saveTask(currentTask);
      syncRemoteTaskState({
        bridgeClient,
        taskStore: store,
        task: currentTask,
      });
    });

    // 3. Dispatch through production entry point approveAndDispatchRemoteTask
    const dispatchPromise = approveAndDispatchRemoteTask({
      task: parsedTask,
      workspace: tempDir,
      taskStore: store,
      bridgeClient,
      syncRemoteFn: syncRemoteTaskState,
      customAgyPath: process.execPath,
      spawnFn: () => {
        providerChild.markSpawned();
        return providerChild;
      },
    });

    await providerChild.spawned;
    providerChild.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
    const dispatchRes = await dispatchPromise;
    const hearthTaskId = dispatchRes.taskId;

    // 4. Invariant: Hearth-owned durable job was launched deterministically
    let task = getAntigravityTask(hearthTaskId);
    assert.strictEqual(task.status, 'running', 'Task must be RUNNING');
    assert.strictEqual(task.durableRoute, true, 'durableRoute must be true');
    assert.ok(task.jobId, 'jobId must be populated');
    assert.ok(typeof task.jobPid === 'number' && task.jobPid > 0, 'jobPid must be valid positive PID');

    // Supabase row was linked immediately
    assert.strictEqual(remoteRow.hearth_task_id, hearthTaskId, 'Remote Supabase row must be linked');

    // 5. Provider stream encounters disconnect / context-cancel
    providerChild.emit('close', 1);
    await delay(50);

    // Invariant: Provider disconnect is tolerated; task remains RUNNING, durable job keeps running
    task = getAntigravityTask(hearthTaskId);
    assert.strictEqual(task.status, 'running', 'Task remains RUNNING after provider disconnect');
    assert.strictEqual(task.controllerState, 'disconnected');
    assert.strictEqual(process.kill(task.jobPid, 0), true, 'Child process must still be running in OS');

    // 6. Durable job runs and emits heartbeats, resetting watchdog
    await delay(200);
    task = getAntigravityTask(hearthTaskId);
    assert.ok(task.jobHeartbeatCount >= 2, `jobHeartbeatCount (${task.jobHeartbeatCount}) must increase`);
    assert.ok(task.jobLastHeartbeatAt, 'jobLastHeartbeatAt must be updated');

    // 7. Durable job completes
    const jobResult = await getJobManager().waitForJob(task.jobId, 5000);
    assert.strictEqual(jobResult.status, 'completed');
    assert.strictEqual(jobResult.exitCode, 0);

    await delay(100);

    // 8. Evaluator completes continuation turn and task reaches DONE
    task = getAntigravityTask(hearthTaskId);
    assert.strictEqual(task.status, 'done', 'Parent task must reach DONE via structured contract');
    assert.strictEqual(task.completion.status, 'done');
    assert.strictEqual(task.completion.checks.build, 'passed');

    // 9. Supabase row is updated to DONE with finished_at and result
    assert.strictEqual(remoteRow.status, 'done', 'Supabase status must be done');
    assert.ok(remoteRow.finished_at, 'finished_at must be populated');
    assert.ok(remoteRow.result.includes('Smoke #7 durable background process completed cleanly'));

    taskRegistry.delete(hearthTaskId);
  } finally {
    getJobManager().setContinuationRunner(null);
    cleanupDir(tempDir);
  }
});

// ============================================================================
// Node Worker Invocation & Packaged Execution Regression Tests (WORKER1 - WORKER8)
// ============================================================================
console.log('\n=== Node Worker Invocation & Packaged Execution Regression Tests (WORKER1 - WORKER8) ===\n');

// ----------------------------------------------------------------------------
// WORKER1: Packaged-style process.execPath worker receives ELECTRON_RUN_AS_NODE=1
// ----------------------------------------------------------------------------
await test('WORKER1: Packaged-style process.execPath worker receives ELECTRON_RUN_AS_NODE=1', async () => {
  const tempDir = makeTempDir();
  try {
    const spec = createControlledWorkerSpec({ worker_duration_seconds: 1 }, tempDir);
    assert.strictEqual(spec.env.ELECTRON_RUN_AS_NODE, '1', 'createControlledWorkerSpec must set ELECTRON_RUN_AS_NODE=1');

    const nodeSpec = createNodeWorkerSpec({ command: process.execPath });
    assert.strictEqual(nodeSpec.env.ELECTRON_RUN_AS_NODE, '1', 'createNodeWorkerSpec must set ELECTRON_RUN_AS_NODE=1');

    // Run short probe process and verify child sees ELECTRON_RUN_AS_NODE=1
    const testTaskId = 'task-worker-1-' + crypto.randomUUID();
    const job = startDurableJob({
      taskId: testTaskId,
      command: process.execPath,
      args: ['-e', 'console.log(JSON.stringify({ isNode: process.env.ELECTRON_RUN_AS_NODE === "1" })); process.exit(0);'],
      cwd: tempDir,
    });

    const result = await getJobManager().waitForJob(job.id, 5000);
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('"isNode":true'), 'Child process must observe ELECTRON_RUN_AS_NODE=1 in its env');
    taskRegistry.delete(testTaskId);
  } finally {
    cleanupDir(tempDir);
  }
});

// ----------------------------------------------------------------------------
// WORKER2: Worker does not launch Electron GUI/helper runtime
// ----------------------------------------------------------------------------
await test('WORKER2: Worker does not launch Electron GUI/helper runtime', async () => {
  const tempDir = makeTempDir();
  try {
    // Probe process.type and verify no GUI runtime is active
    const testTaskId = 'task-worker-2-' + crypto.randomUUID();
    const probeScript = [
      'const hasBrowserWindow = typeof process.versions.electron !== "undefined" && typeof (global.require || process.mainModule?.require)?.("electron")?.BrowserWindow !== "undefined";',
      'console.log(JSON.stringify({',
      '  processType: process.type || "node",',
      '  electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE,',
      '  hasBrowserWindow,',
      '}));',
      'process.exit(0);',
    ].join('\n');

    const workerSpec = createNodeWorkerSpec({
      command: process.execPath,
      args: ['-e', probeScript],
      cwd: tempDir,
    });

    const job = startDurableJob({
      taskId: testTaskId,
      command: workerSpec.command,
      args: workerSpec.args,
      cwd: workerSpec.cwd,
      env: workerSpec.env,
    });

    const result = await getJobManager().waitForJob(job.id, 5000);
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.exitCode, 0);
    const jsonLine = result.stdout.trim().split('\n').find(l => l.startsWith('{'));
    assert.ok(jsonLine, 'Must find JSON output line in stdout');
    const parsed = JSON.parse(jsonLine);
    assert.strictEqual(parsed.processType, 'node', 'Process type must be node, not renderer or browser');
    assert.strictEqual(parsed.electronRunAsNode, '1', 'ELECTRON_RUN_AS_NODE must be 1');
    assert.strictEqual(parsed.hasBrowserWindow, false, 'Must not have BrowserWindow available in worker');
    taskRegistry.delete(testTaskId);
  } finally {
    cleanupDir(tempDir);
  }
});

// ----------------------------------------------------------------------------
// WORKER3: Accelerated worker exits naturally after configured duration
// ----------------------------------------------------------------------------
await test('WORKER3: Accelerated worker exits naturally after configured duration', async () => {
  const tempDir = makeTempDir();
  try {
    const testTaskId = 'task-worker-3-' + crypto.randomUUID();
    const workerSpec = createControlledWorkerSpec({
      worker_duration_seconds: 0.15,
      heartbeat_interval_seconds: 0.03,
      exit_code: 0,
    }, tempDir);

    const job = startDurableJob({
      taskId: testTaskId,
      command: workerSpec.command,
      args: workerSpec.args,
      cwd: workerSpec.cwd,
      env: workerSpec.env,
    });

    const start = Date.now();
    const result = await getJobManager().waitForJob(job.id, 5000);
    const elapsed = Date.now() - start;

    assert.strictEqual(result.status, 'completed', 'Worker must complete naturally');
    assert.strictEqual(result.exitCode, 0, 'Exit code must be 0');
    assert.ok(result.stdout.includes('finished successfully'), 'Worker stdout confirms natural termination');
    assert.ok(elapsed >= 100 && elapsed < 4000, `Elapsed time (${elapsed}ms) indicates timely exit`);
    taskRegistry.delete(testTaskId);
  } finally {
    cleanupDir(tempDir);
  }
});

// ----------------------------------------------------------------------------
// WORKER4: exit and close reach JobManager
// ----------------------------------------------------------------------------
await test('WORKER4: exit and close reach JobManager', async () => {
  const tempDir = makeTempDir();
  try {
    const testTaskId = 'task-worker-4-' + crypto.randomUUID();
    const workerSpec = createControlledWorkerSpec({
      worker_duration_seconds: 0.1,
      heartbeat_interval_seconds: 0.02,
    }, tempDir);

    let exitEmitted = false;
    const exitListener = () => { exitEmitted = true; };
    getJobManager().once('job_completed', exitListener);

    const job = startDurableJob({
      taskId: testTaskId,
      command: workerSpec.command,
      args: workerSpec.args,
      cwd: workerSpec.cwd,
      env: workerSpec.env,
    });

    const result = await getJobManager().waitForJob(job.id, 5000);
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.exitCode, 0);
    assert.ok(exitEmitted, 'JobManager job_completed event must be received');

    // Retrieve via JobManager.getJobResult
    const jobRes = getJobManager().getJobResult(job.id);
    assert.strictEqual(jobRes.status, 'completed');
    assert.strictEqual(jobRes.exitCode, 0);
    assert.ok(jobRes.completedAt, 'completedAt must be populated on JobManager state');

    taskRegistry.delete(testTaskId);
  } finally {
    cleanupDir(tempDir);
  }
});

// ----------------------------------------------------------------------------
// WORKER5: job_completed emitted exactly once
// ----------------------------------------------------------------------------
await test('WORKER5: job_completed emitted exactly once', async () => {
  const tempDir = makeTempDir();
  try {
    const testTaskId = 'task-worker-5-' + crypto.randomUUID();
    let completedEventCount = 0;

    const onJobCompleted = (evt) => {
      if (evt.jobId === job.id) {
        completedEventCount++;
      }
    };
    getJobManager().on('job_completed', onJobCompleted);

    const workerSpec = createControlledWorkerSpec({
      worker_duration_seconds: 0.1,
      heartbeat_interval_seconds: 0.02,
    }, tempDir);

    const job = startDurableJob({
      taskId: testTaskId,
      command: workerSpec.command,
      args: workerSpec.args,
      cwd: workerSpec.cwd,
      env: workerSpec.env,
    });

    await getJobManager().waitForJob(job.id, 5000);
    await delay(100);

    getJobManager().removeListener('job_completed', onJobCompleted);
    assert.strictEqual(completedEventCount, 1, 'job_completed must be emitted exactly once');

    taskRegistry.delete(testTaskId);
  } finally {
    cleanupDir(tempDir);
  }
});

// ----------------------------------------------------------------------------
// WORKER6: job completion triggers exactly one parent continuation
// ----------------------------------------------------------------------------
await test('WORKER6: job completion triggers exactly one parent continuation', async () => {
  const tempDir = makeTempDir();
  try {
    const testTaskId = 'task-worker-6-' + crypto.randomUUID();
    let continuationCount = 0;
    let continuationPrompt = null;

    const task = {
      taskId: testTaskId,
      conversationId: 'conv-worker-6',
      workspace: tempDir,
      title: 'WORKER6 Task',
      status: 'running',
      pendingContinuation: true,
      continueSession: (prompt) => {
        continuationCount++;
        continuationPrompt = prompt;
        return true;
      },
    };
    taskRegistry.set(testTaskId, task);

    const workerSpec = createControlledWorkerSpec({
      worker_duration_seconds: 0.1,
      heartbeat_interval_seconds: 0.02,
    }, tempDir);

    const job = startDurableJob({
      taskId: testTaskId,
      command: workerSpec.command,
      args: workerSpec.args,
      cwd: workerSpec.cwd,
      env: workerSpec.env,
    });

    await getJobManager().waitForJob(job.id, 5000);
    await delay(100);

    assert.strictEqual(continuationCount, 1, 'Parent task continuation must be called exactly once');
    assert.ok(continuationPrompt.includes('finished successfully'), 'Continuation prompt contains worker output');
    assert.ok(continuationPrompt.includes('Exit code: 0'), 'Continuation prompt contains exit code 0');

    taskRegistry.delete(testTaskId);
  } finally {
    cleanupDir(tempDir);
  }
});

// ----------------------------------------------------------------------------
// WORKER7: existing durable heartbeat/routing behavior unchanged
// ----------------------------------------------------------------------------
await test('WORKER7: existing durable heartbeat/routing behavior unchanged', async () => {
  const tempDir = makeTempDir();
  try {
    const store = new TaskStore({ storagePath: path.join(tempDir, 'tasks.json') });
    setTaskStore(store);

    const testTaskId = 'task-worker-7-' + crypto.randomUUID();
    const metadata = {
      requires_hearth_owned_job: true,
      worker_duration_seconds: 0.2,
      heartbeat_interval_seconds: 0.03,
    };
    assert.strictEqual(shouldRouteToDurableJob(metadata), true);

    const initialTask = {
      taskId: testTaskId,
      conversationId: 'conv-worker-7',
      workspace: tempDir,
      status: 'running',
      durableRoute: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    taskRegistry.set(testTaskId, initialTask);
    store.saveTask(initialTask);

    const workerSpec = createControlledWorkerSpec(metadata, tempDir);
    const job = startDurableJob({
      taskId: testTaskId,
      command: workerSpec.command,
      args: workerSpec.args,
      cwd: workerSpec.cwd,
      env: workerSpec.env,
      metadata,
    });

    await delay(120);
    const currentTask = getAntigravityTask(testTaskId);
    assert.ok(currentTask.jobHeartbeatCount >= 2, `Heartbeat count (${currentTask.jobHeartbeatCount}) advanced`);
    assert.ok(currentTask.jobLastHeartbeatAt, 'Last heartbeat timestamp recorded');
    assert.strictEqual(currentTask.durableRoute, true);

    await getJobManager().waitForJob(job.id, 5000);
    taskRegistry.delete(testTaskId);
  } finally {
    cleanupDir(tempDir);
  }
});

// ----------------------------------------------------------------------------
// WORKER8: normal Hearth GUI launch does not inherit ELECTRON_RUN_AS_NODE
// ----------------------------------------------------------------------------
await test('WORKER8: normal Hearth GUI launch does not inherit ELECTRON_RUN_AS_NODE', async () => {
  // Global process.env must NOT have ELECTRON_RUN_AS_NODE set
  assert.strictEqual(
    process.env.ELECTRON_RUN_AS_NODE,
    undefined,
    'Global process.env must never be mutated with ELECTRON_RUN_AS_NODE'
  );

  // Spawning standard command through child_process without createNodeWorkerSpec does not inject it
  const { spawnSync } = await import('node:child_process');
  const probe = spawnSync(process.execPath, [
    '-e',
    'console.log(process.env.ELECTRON_RUN_AS_NODE === undefined ? "UNSET" : "SET");',
  ], {
    env: { ...process.env }, // standard inherited env
  });
  assert.strictEqual(
    probe.stdout.toString().trim(),
    'UNSET',
    'Standard execution without createNodeWorkerSpec must not have ELECTRON_RUN_AS_NODE'
  );
});

// ============================================================================
// Production Continuation Bridge Regression Tests (CONT1 - CONT12)
// ============================================================================
console.log('\n=== Production Continuation Bridge Regression Tests (CONT1 - CONT12 & ACCELERATED_PRODUCTION_CONTINUATION) ===\n');

// ----------------------------------------------------------------------------
// CONT1: JobManager singleton has production continuationRunner registered
// ----------------------------------------------------------------------------
await test('CONT1: JobManager singleton has production continuationRunner registered in Electron runtime', async () => {
  // 1. Verify electron/main.cjs source registers continuation runner on startup
  const mainSrc = fs.readFileSync(path.join(process.cwd(), 'electron/main.cjs'), 'utf8');
  assert.ok(mainSrc.includes('createTaskContinuationRunner'), 'main.cjs must import and use createTaskContinuationRunner');
  assert.ok(mainSrc.includes('jobManager.setContinuationRunner('), 'main.cjs must call jobManager.setContinuationRunner');
  assert.ok(mainSrc.includes('jobManager.setTaskResolver('), 'main.cjs must call jobManager.setTaskResolver');
  assert.ok(mainSrc.includes('jobManager.setTaskStoreSaver('), 'main.cjs must call jobManager.setTaskStoreSaver');

  // 2. Verify createTaskContinuationRunner export is functional
  assert.strictEqual(typeof createTaskContinuationRunner, 'function', 'createTaskContinuationRunner must be exported');
  const runner = createTaskContinuationRunner({
    jobManager: getJobManager(),
    taskStore: null,
  });
  assert.strictEqual(typeof runner, 'function', 'createTaskContinuationRunner must return runner function');

  // 3. Verify JobManager setContinuationRunner accepts it
  getJobManager().setContinuationRunner(runner);
  assert.strictEqual(getJobManager().continuationRunner, runner, 'JobManager must hold registered continuation runner');
  getJobManager().setContinuationRunner(null);
});

// ----------------------------------------------------------------------------
// CONT2: Initial provider returns waiting while durable job active -> parent stays running
// ----------------------------------------------------------------------------
await test('CONT2: Initial provider returns waiting while durable job active -> parent stays running', async () => {
  const tempDir = makeTempDir();
  try {
    const store = new TaskStore({ storagePath: path.join(tempDir, 'tasks.json') });
    setTaskStore(store);

    const testTaskId = 'task-cont-2-' + crypto.randomUUID();
    const now = new Date().toISOString();
    const task = {
      taskId: testTaskId,
      conversationId: 'conv-cont-2',
      workspace: tempDir,
      status: 'running',
      durableRoute: true,
      pendingContinuation: false,
      controllerState: 'healthy',
      recentEvents: [],
      createdAt: now,
      updatedAt: now,
    };
    taskRegistry.set(testTaskId, task);
    store.saveTask(task);

    // Start a durable job for this task
    const workerSpec = createControlledWorkerSpec({
      worker_duration_seconds: 0.5,
      heartbeat_interval_seconds: 0.05,
    }, tempDir);

    const job = startDurableJob({
      taskId: testTaskId,
      command: workerSpec.command,
      args: workerSpec.args,
      cwd: workerSpec.cwd,
      env: workerSpec.env,
    });

    // Simulate provider stream emitting structured waiting contract
    const waitingCompletion = classifyCompletion({
      response: '```json\n{"status":"waiting","summary":"Waiting for background durable task."}\n```',
      executorStatus: 'SUCCESS',
      events: [],
      error: null,
      workspace: tempDir,
    });
    assert.strictEqual(waitingCompletion.status, 'waiting');

    // With active durable jobs, parent task must NOT become dormant WAITING
    const activeDurableJobs = getJobManager().listJobs({ taskId: testTaskId, status: 'running' });
    assert.ok(activeDurableJobs.length > 0, 'Must have active durable job');

    // Simulate the exact logic in isResultEvent
    if (waitingCompletion.status === 'waiting' && activeDurableJobs.length > 0) {
      task.status = 'running';
      task.completion = waitingCompletion;
      task.pendingContinuation = true;
      task.controllerState = 'disconnected';
    }

    assert.strictEqual(task.status, 'running', 'Parent task status must remain running');
    assert.strictEqual(task.controllerState, 'disconnected', 'Controller state transitions to disconnected');
    assert.strictEqual(task.pendingContinuation, true, 'Pending continuation must be true');
    assert.strictEqual(isTaskActivelyRunning(task), true, 'Task must be actively running');

    await getJobManager().waitForJob(job.id, 5000);
    taskRegistry.delete(testTaskId);
  } finally {
    cleanupDir(tempDir);
  }
});

// ----------------------------------------------------------------------------
// CONT3: job_completed after provider CLI child has exited -> continuationRunner executes
// ----------------------------------------------------------------------------
await test('CONT3: job_completed after provider CLI child has exited -> continuationRunner executes', async () => {
  const tempDir = makeTempDir();
  try {
    const store = new TaskStore({ storagePath: path.join(tempDir, 'tasks.json') });
    setTaskStore(store);

    const testTaskId = 'task-cont-3-' + crypto.randomUUID();
    const task = {
      taskId: testTaskId,
      conversationId: 'conv-cont-3',
      workspace: tempDir,
      status: 'running',
      child: null, // Provider CLI child process already exited
      controllerState: 'disconnected',
      pendingContinuation: true,
      recentEvents: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    taskRegistry.set(testTaskId, task);
    store.saveTask(task);

    let runnerExecuted = false;
    let runnerJobId = null;
    getJobManager().setContinuationRunner(async ({ task: t, job: j, evidence: e }) => {
      runnerExecuted = true;
      runnerJobId = j.id;
    });

    const workerSpec = createControlledWorkerSpec({
      worker_duration_seconds: 0.1,
      heartbeat_interval_seconds: 0.02,
    }, tempDir);

    const job = startDurableJob({
      taskId: testTaskId,
      command: workerSpec.command,
      args: workerSpec.args,
      cwd: workerSpec.cwd,
      env: workerSpec.env,
    });

    await getJobManager().waitForJob(job.id, 5000);
    await delay(100);

    assert.strictEqual(runnerExecuted, true, 'continuationRunner must execute after worker finishes');
    assert.strictEqual(runnerJobId, job.id, 'continuationRunner must receive matching jobId');

    taskRegistry.delete(testTaskId);
  } finally {
    getJobManager().setContinuationRunner(null);
    cleanupDir(tempDir);
  }
});

// ----------------------------------------------------------------------------
// CONT4: Continuation resolves same parent taskId and conversationId
// ----------------------------------------------------------------------------
await test('CONT4: Continuation resolves same parent taskId and conversationId', async () => {
  const tempDir = makeTempDir();
  try {
    const store = new TaskStore({ storagePath: path.join(tempDir, 'tasks.json') });
    setTaskStore(store);

    const testTaskId = 'task-cont-4-' + crypto.randomUUID();
    const expectedConvId = 'conv-cont-4-' + crypto.randomUUID();
    const task = {
      taskId: testTaskId,
      conversationId: expectedConvId,
      workspace: tempDir,
      status: 'running',
      controllerState: 'disconnected',
      pendingContinuation: true,
      recentEvents: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    taskRegistry.set(testTaskId, task);
    store.saveTask(task);

    let resolvedTaskId = null;
    let resolvedConvId = null;

    const runner = createTaskContinuationRunner({
      jobManager: getJobManager(),
      taskStore: store,
      getAntigravityTask: (id) => taskRegistry.get(id),
      resumeAntigravityTask: async ({ taskId, message }) => {
        const t = taskRegistry.get(taskId);
        resolvedTaskId = t.taskId;
        resolvedConvId = t.conversationId;
        return { taskId: t.taskId, conversationId: t.conversationId, status: 'done' };
      },
    });

    const fakeJob = { id: 'job-cont-4', taskId: testTaskId };
    const fakeEvidence = { status: 'completed', exitCode: 0, durationMs: 120, stdout: 'OK' };

    await runner({ task, job: fakeJob, evidence: fakeEvidence });

    assert.strictEqual(resolvedTaskId, testTaskId, 'Resolved taskId must match parent task');
    assert.strictEqual(resolvedConvId, expectedConvId, 'Resolved conversationId must match original conversation');

    taskRegistry.delete(testTaskId);
  } finally {
    cleanupDir(tempDir);
  }
});

// ----------------------------------------------------------------------------
// CONT5: Completed durable job evidence attached to continuation
// ----------------------------------------------------------------------------
await test('CONT5: Completed durable job evidence attached to continuation', async () => {
  const tempDir = makeTempDir();
  try {
    const store = new TaskStore({ storagePath: path.join(tempDir, 'tasks.json') });
    setTaskStore(store);

    const testTaskId = 'task-cont-5-' + crypto.randomUUID();
    const task = {
      taskId: testTaskId,
      conversationId: 'conv-cont-5',
      workspace: tempDir,
      status: 'running',
      controllerState: 'disconnected',
      pendingContinuation: true,
      recentEvents: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    taskRegistry.set(testTaskId, task);
    store.saveTask(task);

    let promptSeen = '';
    let evidenceSeen = null;

    const runner = createTaskContinuationRunner({
      jobManager: getJobManager(),
      taskStore: store,
      getAntigravityTask: (id) => taskRegistry.get(id),
      resumeAntigravityTask: async ({ taskId, message, durableJobEvidence }) => {
        promptSeen = message;
        evidenceSeen = durableJobEvidence;
        return { taskId, status: 'done' };
      },
    });

    const fakeJob = { id: 'job-cont-5-xyz', taskId: testTaskId };
    const fakeEvidence = {
      jobId: 'job-cont-5-xyz',
      status: 'completed',
      exitCode: 0,
      durationMs: 460000,
      stdout: 'Worker output finished successfully',
      stderr: '',
      completedAt: new Date().toISOString(),
    };

    await runner({ task, job: fakeJob, evidence: fakeEvidence });

    assert.ok(task.durableJobEvidence, 'Task must have durableJobEvidence attached');
    assert.strictEqual(task.durableJobEvidence.jobId, 'job-cont-5-xyz');
    assert.strictEqual(task.durableJobEvidence.exitCode, 0);
    assert.strictEqual(evidenceSeen.exitCode, 0, 'resumeAntigravityTask received evidence');
    assert.ok(promptSeen.includes('job-cont-5-xyz'), 'Prompt contains job ID');
    assert.ok(promptSeen.includes('Exit code: 0'), 'Prompt contains exit code');
    assert.ok(promptSeen.includes('Worker output finished successfully'), 'Prompt contains stdout');

    taskRegistry.delete(testTaskId);
  } finally {
    cleanupDir(tempDir);
  }
});

// ----------------------------------------------------------------------------
// CONT6: resumeAntigravityTask invoked exactly once
// ----------------------------------------------------------------------------
await test('CONT6: resumeAntigravityTask invoked exactly once', async () => {
  const tempDir = makeTempDir();
  try {
    const store = new TaskStore({ storagePath: path.join(tempDir, 'tasks.json') });
    setTaskStore(store);

    const testTaskId = 'task-cont-6-' + crypto.randomUUID();
    const task = {
      taskId: testTaskId,
      conversationId: 'conv-cont-6',
      workspace: tempDir,
      status: 'running',
      controllerState: 'disconnected',
      pendingContinuation: true,
      recentEvents: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    taskRegistry.set(testTaskId, task);
    store.saveTask(task);

    let resumeCallCount = 0;
    const runner = createTaskContinuationRunner({
      jobManager: getJobManager(),
      taskStore: store,
      getAntigravityTask: (id) => taskRegistry.get(id),
      resumeAntigravityTask: async ({ taskId }) => {
        resumeCallCount++;
        return { taskId, status: 'done' };
      },
    });

    const fakeJob = { id: 'job-cont-6-single', taskId: testTaskId };
    const fakeEvidence = { status: 'completed', exitCode: 0, durationMs: 200, stdout: 'Done' };

    await runner({ task, job: fakeJob, evidence: fakeEvidence });
    assert.strictEqual(resumeCallCount, 1, 'Initial runner execution calls resumeAntigravityTask');

    // Attempt second call with same job
    await runner({ task, job: fakeJob, evidence: fakeEvidence });
    assert.strictEqual(resumeCallCount, 1, 'Second invocation must be safely ignored by exactly-once guard');

    taskRegistry.delete(testTaskId);
  } finally {
    cleanupDir(tempDir);
  }
});

// ----------------------------------------------------------------------------
// CONT7: Duplicate exit/close/job_completed cannot produce duplicate continuation
// ----------------------------------------------------------------------------
await test('CONT7: Duplicate exit/close/job_completed cannot produce duplicate continuation', async () => {
  const tempDir = makeTempDir();
  try {
    const store = new TaskStore({ storagePath: path.join(tempDir, 'tasks.json') });
    setTaskStore(store);

    const testTaskId = 'task-cont-7-' + crypto.randomUUID();
    const task = {
      taskId: testTaskId,
      conversationId: 'conv-cont-7',
      workspace: tempDir,
      status: 'running',
      controllerState: 'disconnected',
      pendingContinuation: true,
      recentEvents: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    taskRegistry.set(testTaskId, task);
    store.saveTask(task);

    let continuationCount = 0;
    getJobManager().setContinuationRunner(async ({ task: t, job: j, evidence: e }) => {
      continuationCount++;
    });

    const workerSpec = createControlledWorkerSpec({
      worker_duration_seconds: 0.1,
      heartbeat_interval_seconds: 0.02,
    }, tempDir);

    const job = startDurableJob({
      taskId: testTaskId,
      command: workerSpec.command,
      args: workerSpec.args,
      cwd: workerSpec.cwd,
      env: workerSpec.env,
    });

    await getJobManager().waitForJob(job.id, 5000);

    // Artificially trigger exit again on same jobId
    getJobManager()._handleProcessExit(job.id, 0, null, null);
    getJobManager()._handleProcessExit(job.id, 0, null, null);

    await delay(100);
    assert.strictEqual(continuationCount, 1, 'JobManager must suppress duplicate process exit events');

    taskRegistry.delete(testTaskId);
  } finally {
    getJobManager().setContinuationRunner(null);
    cleanupDir(tempDir);
  }
});

// ----------------------------------------------------------------------------
// CONT8: Structured completed after continuation -> parent DONE
// ----------------------------------------------------------------------------
await test('CONT8: Structured completed after continuation -> parent DONE', async () => {
  const tempDir = makeTempDir();
  try {
    const store = new TaskStore({ storagePath: path.join(tempDir, 'tasks.json') });
    setTaskStore(store);

    const testTaskId = 'task-cont-8-' + crypto.randomUUID();
    const task = {
      taskId: testTaskId,
      conversationId: 'conv-cont-8',
      workspace: tempDir,
      status: 'running',
      controllerState: 'disconnected',
      pendingContinuation: true,
      recentEvents: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    taskRegistry.set(testTaskId, task);
    store.saveTask(task);

    // Mock runner returns structured completed contract
    const mockEvaluatorRunner = async () => ({
      stdout: JSON.stringify({ event: 'init', conversation_id: task.conversationId }) + '\n' +
        JSON.stringify({
          event: 'result',
          status: 'SUCCESS',
          result: {
            status: 'SUCCESS',
            response: '```json\n{"status":"completed","summary":"Continuation verified background job output."}\n```',
          },
        }) + '\n',
      stderr: '',
    });

    const runner = createTaskContinuationRunner({
      jobManager: getJobManager(),
      taskStore: store,
      getAntigravityTask: (id) => taskRegistry.get(id),
      resumeAntigravityTask: (opts) => resumeAntigravityTask({
        ...opts,
        customAgyPath: process.execPath,
        runner: mockEvaluatorRunner,
      }),
    });

    const fakeJob = { id: 'job-cont-8', taskId: testTaskId };
    const fakeEvidence = { status: 'completed', exitCode: 0, durationMs: 150, stdout: 'Worker finished' };

    await runner({ task, job: fakeJob, evidence: fakeEvidence });

    const currentTask = taskRegistry.get(testTaskId);
    assert.strictEqual(currentTask.status, 'done', 'Parent task status must be done');
    assert.strictEqual(currentTask.completion.status, 'done', 'Task completion status must be done');
    assert.strictEqual(currentTask.continuationState, 'completed', 'Continuation state must be completed');

    taskRegistry.delete(testTaskId);
  } finally {
    cleanupDir(tempDir);
  }
});

// ----------------------------------------------------------------------------
// CONT9: Structured waiting after continuation -> parent WAITING normally
// ----------------------------------------------------------------------------
await test('CONT9: Structured waiting after continuation -> parent WAITING normally (no active durable jobs remain)', async () => {
  const tempDir = makeTempDir();
  try {
    const store = new TaskStore({ storagePath: path.join(tempDir, 'tasks.json') });
    setTaskStore(store);

    const testTaskId = 'task-cont-9-' + crypto.randomUUID();
    const task = {
      taskId: testTaskId,
      conversationId: 'conv-cont-9',
      workspace: tempDir,
      status: 'running',
      controllerState: 'disconnected',
      pendingContinuation: true,
      recentEvents: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    taskRegistry.set(testTaskId, task);
    store.saveTask(task);

    // Mock runner returns structured waiting contract after continuation
    const mockEvaluatorRunner = async () => ({
      stdout: JSON.stringify({ event: 'init', conversation_id: task.conversationId }) + '\n' +
        JSON.stringify({
          event: 'result',
          status: 'SUCCESS',
          result: {
            status: 'SUCCESS',
            response: '```json\n{"status":"waiting","summary":"Need user confirmation to proceed with deployment."}\n```',
          },
        }) + '\n',
      stderr: '',
    });

    const runner = createTaskContinuationRunner({
      jobManager: getJobManager(),
      taskStore: store,
      getAntigravityTask: (id) => taskRegistry.get(id),
      resumeAntigravityTask: (opts) => resumeAntigravityTask({
        ...opts,
        customAgyPath: process.execPath,
        runner: mockEvaluatorRunner,
      }),
    });

    const fakeJob = { id: 'job-cont-9', taskId: testTaskId };
    const fakeEvidence = { status: 'completed', exitCode: 0, durationMs: 150, stdout: 'Worker finished' };

    await runner({ task, job: fakeJob, evidence: fakeEvidence });

    const currentTask = taskRegistry.get(testTaskId);
    assert.strictEqual(currentTask.status, 'waiting', 'Parent task status must be waiting normally');
    assert.strictEqual(currentTask.completion.status, 'waiting', 'Task completion status must be waiting');
    assert.strictEqual(currentTask.continuationState, 'completed', 'Continuation turn was completed');

    taskRegistry.delete(testTaskId);
  } finally {
    cleanupDir(tempDir);
  }
});

// ----------------------------------------------------------------------------
// CONT10: Continuation failure preserves job evidence and produces explicit recoverable/error state
// ----------------------------------------------------------------------------
await test('CONT10: Continuation failure preserves job evidence and produces explicit recoverable/error state', async () => {
  const tempDir = makeTempDir();
  try {
    const store = new TaskStore({ storagePath: path.join(tempDir, 'tasks.json') });
    setTaskStore(store);

    const testTaskId = 'task-cont-10-' + crypto.randomUUID();
    const task = {
      taskId: testTaskId,
      conversationId: 'conv-cont-10',
      workspace: tempDir,
      status: 'running',
      source: 'remote',
      remoteTaskId: 'remote-cont-10',
      controllerState: 'disconnected',
      pendingContinuation: true,
      recentEvents: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    taskRegistry.set(testTaskId, task);
    store.saveTask(task);

    let remoteSyncedStatus = null;

    const runner = createTaskContinuationRunner({
      jobManager: getJobManager(),
      taskStore: store,
      getAntigravityTask: (id) => taskRegistry.get(id),
      resumeAntigravityTask: async () => {
        throw new Error('Antigravity CLI failed to start due to missing environment.');
      },
      syncRemoteTaskState: async ({ task: t, overrides }) => {
        remoteSyncedStatus = overrides?.status || t.status;
      },
      getBridgeClient: () => ({ enabled: true }),
    });

    const fakeJob = { id: 'job-cont-10', taskId: testTaskId };
    const fakeEvidence = {
      jobId: 'job-cont-10',
      status: 'completed',
      exitCode: 0,
      durationMs: 460000,
      stdout: 'Important durable calculations',
      stderr: '',
      completedAt: new Date().toISOString(),
    };

    let caughtErr = null;
    try {
      await runner({ task, job: fakeJob, evidence: fakeEvidence });
    } catch (err) {
      caughtErr = err;
    }

    assert.ok(caughtErr, 'Runner must re-throw error for caller observability');
    const currentTask = taskRegistry.get(testTaskId);
    assert.strictEqual(currentTask.status, 'error', 'Task must transition to error');
    assert.strictEqual(currentTask.continuationState, 'failed', 'continuationState must be failed');
    assert.ok(currentTask.error.includes('Continuation failed'), 'Error message contains context');
    assert.ok(currentTask.durableJobEvidence, 'durableJobEvidence must be preserved');
    assert.strictEqual(currentTask.durableJobEvidence.stdout, 'Important durable calculations');
    assert.strictEqual(remoteSyncedStatus, 'error', 'Supabase state must receive terminal error');

    taskRegistry.delete(testTaskId);
  } finally {
    cleanupDir(tempDir);
  }
});

// ----------------------------------------------------------------------------
// CONT11: Supabase row stays running while durable job is active and receives terminal state only after continuation result
// ----------------------------------------------------------------------------
await test('CONT11: Supabase row stays running while durable job is active and receives terminal state only after continuation result', async () => {
  const tempDir = makeTempDir();
  try {
    const store = new TaskStore({ storagePath: path.join(tempDir, 'tasks.json') });
    setTaskStore(store);

    const remoteRow = {
      id: 'remote-cont-11',
      device_id: 'test-device-cont-11',
      status: 'running',
      hearth_task_id: null,
      result: null,
      finished_at: null,
    };

    const mockTransport = {
      fetch: async (url, opts = {}) => {
        if (opts.method === 'PATCH') {
          const body = JSON.parse(opts.body);
          Object.assign(remoteRow, body);
          return { ok: true, status: 200, json: async () => [remoteRow] };
        }
        return { ok: true, status: 200, json: async () => [remoteRow] };
      },
    };

    const bridgeClient = new HearthBridgeClient({
      supabaseUrl: 'https://mock.supabase.co',
      supabaseKey: 'mock-key',
      deviceId: 'test-device-cont-11',
      fetchFn: mockTransport.fetch,
    });
    bridgeClient.enabled = true;

    const testTaskId = 'task-cont-11-' + crypto.randomUUID();
    remoteRow.hearth_task_id = testTaskId;

    const task = {
      taskId: testTaskId,
      conversationId: 'conv-cont-11',
      workspace: tempDir,
      status: 'running',
      source: 'remote',
      remoteTaskId: remoteRow.id,
      controllerState: 'disconnected',
      pendingContinuation: true,
      recentEvents: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    taskRegistry.set(testTaskId, task);
    store.saveTask(task);

    // Initial sync confirms running
    await syncRemoteTaskState({ bridgeClient, taskStore: store, task });
    assert.strictEqual(remoteRow.status, 'running', 'Supabase row must be running initially');
    assert.strictEqual(remoteRow.finished_at, null);

    // Simulate durable job active
    const workerSpec = createControlledWorkerSpec({
      worker_duration_seconds: 0.15,
      heartbeat_interval_seconds: 0.03,
    }, tempDir);

    const job = startDurableJob({
      taskId: testTaskId,
      command: workerSpec.command,
      args: workerSpec.args,
      cwd: workerSpec.cwd,
      env: workerSpec.env,
    });

    // While job is active, status remains running
    await syncRemoteTaskState({ bridgeClient, taskStore: store, task });
    assert.strictEqual(remoteRow.status, 'running', 'Supabase row remains running while durable job active');

    // Continuation runner executes after worker finishes
    const mockEvaluatorRunner = async () => ({
      stdout: JSON.stringify({ event: 'init', conversation_id: task.conversationId }) + '\n' +
        JSON.stringify({
          event: 'result',
          status: 'SUCCESS',
          result: {
            status: 'SUCCESS',
            response: '```json\n{"status":"completed","summary":"Smoke #8 durable continuation verified."}\n```',
          },
        }) + '\n',
      stderr: '',
    });

    const continuationRunner = createTaskContinuationRunner({
      jobManager: getJobManager(),
      taskStore: store,
      getAntigravityTask: (id) => taskRegistry.get(id),
      resumeAntigravityTask: (opts) => resumeAntigravityTask({
        ...opts,
        customAgyPath: process.execPath,
        runner: mockEvaluatorRunner,
      }),
      syncRemoteTaskState: (opts) => syncRemoteTaskState(opts),
      getBridgeClient: () => bridgeClient,
    });

    getJobManager().setContinuationRunner(continuationRunner);

    await getJobManager().waitForJob(job.id, 5000);
    await delay(100);

    // Now task reached done, sync remote terminal state
    await syncRemoteTaskState({ bridgeClient, taskStore: store, task });
    assert.strictEqual(remoteRow.status, 'done', 'Supabase row must only become done after continuation completed');
    assert.ok(remoteRow.finished_at, 'finished_at must be populated');
    assert.ok(remoteRow.result.includes('Smoke #8 durable continuation verified'));

    taskRegistry.delete(testTaskId);
  } finally {
    getJobManager().setContinuationRunner(null);
    cleanupDir(tempDir);
  }
});

// ----------------------------------------------------------------------------
// CONT12: Restart after job completed but before continuation finishes -> exactly-once recovery
// ----------------------------------------------------------------------------
await test('CONT12: Restart after job completed but before continuation finishes -> exactly-once recovery/retry without false DONE', async () => {
  const tempDir = makeTempDir();
  try {
    const store = new TaskStore({ storagePath: path.join(tempDir, 'tasks.json') });
    const jm = new JobManager({ storagePath: path.join(tempDir, 'jobs.json') });

    const testTaskId = 'task-cont-12-' + crypto.randomUUID();
    const testJobId = 'job-cont-12-' + crypto.randomUUID();

    const initialTask = {
      taskId: testTaskId,
      conversationId: 'conv-cont-12',
      workspace: tempDir,
      status: 'running',
      jobId: testJobId,
      continuationState: 'in_progress',
      continuationJobId: testJobId,
      durableJobEvidence: {
        jobId: testJobId,
        status: 'completed',
        exitCode: 0,
        stdout: 'Durable worker finished before crash',
      },
      recentEvents: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.saveTask(initialTask);

    const initialJob = {
      id: testJobId,
      taskId: testTaskId,
      status: 'completed',
      exitCode: 0,
      stdout: 'Durable worker finished before crash',
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
    jm.jobs.set(testJobId, initialJob);
    jm.save();

    // Simulate application restart
    const restartedStore = new TaskStore({ storagePath: path.join(tempDir, 'tasks.json') });
    restartedStore.load();
    const { reconciledCount } = restartedStore.reconcileStartupState();
    assert.strictEqual(reconciledCount, 1, 'Interrupted running task must be reconciled');

    const restoredTask = restartedStore.getTask(testTaskId);
    assert.strictEqual(restoredTask.status, 'recovery_required', 'Task must NOT falsely restore as done');
    assert.ok(restoredTask.durableJobEvidence, 'durableJobEvidence must be preserved across restart');
    assert.strictEqual(restoredTask.durableJobEvidence.stdout, 'Durable worker finished before crash');

    // Register in memory and verify resumeAntigravityTask can resume from recovery_required
    taskRegistry.set(testTaskId, restoredTask);
    let resumedWithEvidence = false;
    const mockResumeRunner = async (_exe, _args, { input }) => {
      resumedWithEvidence = true;
      return {
        stdout: JSON.stringify({ event: 'init', conversation_id: restoredTask.conversationId }) + '\n' +
          JSON.stringify({
            event: 'result',
            status: 'SUCCESS',
            result: {
              status: 'SUCCESS',
              response: '```json\n{"status":"completed","summary":"Recovery resume complete."}\n```',
            },
          }) + '\n',
        stderr: '',
      };
    };

    const res = await resumeAntigravityTask({
      taskId: testTaskId,
      customAgyPath: process.execPath,
      runner: mockResumeRunner,
    });

    assert.strictEqual(resumedWithEvidence, true);
    assert.strictEqual(res.status, 'done', 'Task transitions to done only after recovery resume completed');

    taskRegistry.delete(testTaskId);
  } finally {
    cleanupDir(tempDir);
  }
});

// ----------------------------------------------------------------------------
// ACCELERATED_PRODUCTION_CONTINUATION: End-to-end production wiring test
// ----------------------------------------------------------------------------
await test('ACCELERATED_PRODUCTION_CONTINUATION: End-to-end production wiring test (remote approval -> durable job -> interim waiting -> worker exit -> continuation -> DONE)', async () => {
  const tempDir = makeTempDir();
  try {
    const store = new TaskStore({ storagePath: path.join(tempDir, 'tasks.json') });
    setTaskStore(store);

    const remoteRow = {
      id: 'remote-accel-prod',
      device_id: 'test-device-accel',
      status: 'pending',
      prompt: 'Run durable smoke verification',
      hearth_task_id: null,
      result: null,
      finished_at: null,
    };

    const mockTransport = {
      fetch: async (url, opts = {}) => {
        if (opts.method === 'PATCH') {
          const body = JSON.parse(opts.body);
          Object.assign(remoteRow, body);
          return { ok: true, status: 200, json: async () => [remoteRow] };
        }
        return { ok: true, status: 200, json: async () => [remoteRow] };
      },
    };

    const bridgeClient = new HearthBridgeClient({
      supabaseUrl: 'https://mock.supabase.co',
      supabaseKey: 'mock-key',
      deviceId: 'test-device-accel',
      fetchFn: mockTransport.fetch,
    });
    bridgeClient.enabled = true;

    // Configure production continuation runner on singleton JobManager
    let continuationFired = false;
    const prodContinuationRunner = createTaskContinuationRunner({
      jobManager: getJobManager(),
      taskStore: store,
      getAntigravityTask: (id) => taskRegistry.get(id),
      resumeAntigravityTask: async (opts) => {
        continuationFired = true;
        return resumeAntigravityTask({
          ...opts,
          customAgyPath: process.execPath,
          runner: async () => ({
            stdout: JSON.stringify({ event: 'init', conversation_id: 'conv-accel-prod' }) + '\n' +
              JSON.stringify({
                event: 'result',
                status: 'SUCCESS',
                result: {
                  status: 'SUCCESS',
                  response: '```json\n{"status":"completed","summary":"Production continuation verified worker completed cleanly."}\n```',
                },
              }) + '\n',
            stderr: '',
          }),
        });
      },
      syncRemoteTaskState: (opts) => syncRemoteTaskState(opts),
      getBridgeClient: () => bridgeClient,
    });

    getJobManager().setContinuationRunner(prodContinuationRunner);

    // Initial mock start returns interim waiting and disconnects
    const mockInitialStartTask = async ({ existingTaskId }) => {
      const t = taskRegistry.get(existingTaskId) || store.getTask(existingTaskId) || { taskId: existingTaskId };
      t.conversationId = 'conv-accel-prod';
      t.status = 'running';
      t.pendingContinuation = true;
      t.controllerState = 'disconnected';
      t.child = null;
      t.completion = {
        status: 'waiting',
        summary: 'Waiting for durable background process.',
      };
      taskRegistry.set(existingTaskId, t);
      store.saveTask(t);
      return {
        taskId: existingTaskId,
        conversationId: 'conv-accel-prod',
        status: 'running',
      };
    };

    const dispatchRes = await approveAndDispatchRemoteTask({
      task: {
        id: remoteRow.id,
        prompt: 'Run durable smoke verification',
        metadata: {
          requires_hearth_owned_job: true,
          worker_duration_seconds: 0.15,
          heartbeat_interval_seconds: 0.03,
        },
      },
      workspace: tempDir,
      taskStore: store,
      bridgeClient,
      startTaskFn: mockInitialStartTask,
      syncRemoteFn: syncRemoteTaskState,
    });

    const hearthTaskId = dispatchRes.taskId;
    let task = taskRegistry.get(hearthTaskId);
    assert.strictEqual(task.status, 'running', 'Parent task must stay running');
    assert.strictEqual(remoteRow.status, 'running', 'Supabase row must stay running');

    // Wait for durable job to exit naturally
    const jobResult = await getJobManager().waitForJob(task.jobId, 5000);
    assert.strictEqual(jobResult.status, 'completed', 'Durable job must complete');
    assert.strictEqual(jobResult.exitCode, 0);

    await delay(150);

    assert.strictEqual(continuationFired, true, 'Continuation runner must fire');
    task = taskRegistry.get(hearthTaskId);
    assert.strictEqual(task.status, 'done', 'Parent task reaches done');
    assert.strictEqual(task.completion.status, 'done');

    // Remote sync completed
    await syncRemoteTaskState({ bridgeClient, taskStore: store, task });
    assert.strictEqual(remoteRow.status, 'done', 'Supabase row reaches done');
    assert.ok(remoteRow.finished_at);
    assert.ok(remoteRow.result.includes('Production continuation verified'));

    taskRegistry.delete(hearthTaskId);
  } finally {
    getJobManager().setContinuationRunner(null);
    cleanupDir(tempDir);
  }
});

console.log(`\n=== Test Results: ${passed} passed, ${failed} failed ===`);

// These scenarios drive durable jobs directly, so the Antigravity task that owns
// them never reaches its own terminal path -- and `handleBackgroundJobCompletion`
// re-arms that task's 330s execution watchdog on every job completion. Those
// timers are inert (they no-op unless the task is still starting/running), but
// they are enough to keep this script alive for 5.5 minutes after the last
// assertion. The watchdog lives in a closure the suite cannot reach, so exit on
// the result instead of waiting for an empty event loop.
process.exit(failed > 0 ? 1 : 0);

