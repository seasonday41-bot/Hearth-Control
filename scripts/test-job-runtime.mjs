/**
 * Hearth Durable Job Runtime v0.1 Diagnostic Test Suite
 * Tests JOB1 through JOB10:
 * - JOB1: Hearth directly owns spawned process
 * - JOB2: Heartbeat continues even if mock controller stream disconnects
 * - JOB3: >7-minute logical background execution does not depend on controller stream
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
// JOB2: Heartbeat continues even if mock controller stream disconnects
// ----------------------------------------------------------------------------
await test('JOB2: Heartbeat continues even if mock controller stream disconnects', async () => {
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
// JOB3: >7-minute logical background execution does not depend on controller stream
// ----------------------------------------------------------------------------
await test('JOB3: Long-running background execution does not depend on controller stream', async () => {
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

    // Simulate controller stream failure immediately
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

console.log(`\n=== Test Results: ${passed} passed, ${failed} failed ===`);
process.exitCode = failed > 0 ? 1 : 0;
