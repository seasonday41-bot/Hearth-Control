import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getAuthoritativeAntigravityTask, reconcileDurableContinuations,
  resumeAntigravityTask, setTaskStore, startAntigravityTask,
  stopAntigravityTask, taskRegistry,
} from '../mcp/executors/antigravity.mjs';
import { TaskStore } from '../mcp/executors/task-store.mjs';
import { getJobManager, JobManager, setJobManager } from '../mcp/runtime/job-manager.mjs';

const originalManager = getJobManager();
const fixtures = [];

class OwnedChild extends EventEmitter {
  constructor({ exits = true } = {}) {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = { writable: true, write: () => true, end: () => { this.stdin.writable = false; } };
    this.pid = 90001;
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.killCount = 0;
    this.exits = exits;
  }

  kill(signal = 'SIGTERM') {
    this.killed = true;
    this.killCount += 1;
    if (this.exits) queueMicrotask(() => {
      this.signalCode = signal;
      this.emit('exit', null, signal);
      this.emit('close', null, signal);
    });
    return true;
  }
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-stop-'));
  const store = new TaskStore({ storagePath: path.join(dir, 'tasks.json') });
  const manager = new JobManager({ storagePath: path.join(dir, 'jobs.json') });
  setJobManager(manager);
  setTaskStore(store);
  fixtures.push({ dir, store });
  return { dir, store, manager };
}

async function startLive(dir, options = {}) {
  const child = new OwnedChild(options);
  const started = startAntigravityTask({
    workspace: dir, prompt: 'Focused stop test', customAgyPath: process.execPath,
    spawnFn: () => child,
  });
  child.stdout.write(`${JSON.stringify({ event: 'init', conversation_id: 'stop-conversation' })}\n`);
  return { child, result: await started };
}

async function resumeLive(store, dir) {
  const taskId = 'resumed-stop-task';
  store.saveTask({ taskId, conversationId: 'resumed-conversation', workspace: dir,
    status: 'waiting', source: 'local' });
  const child = new OwnedChild();
  const resumed = resumeAntigravityTask({ taskId, customAgyPath: process.execPath, spawnFn: () => child });
  child.stdout.write(`${JSON.stringify({ event: 'init', conversation_id: 'resumed-conversation' })}\n`);
  return { child, taskId, result: await resumed };
}

afterEach(() => {
  taskRegistry.clear();
  setTaskStore(null);
  setJobManager(originalManager);
  for (const f of fixtures.splice(0)) {
    f.store.continuationDb?.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('STOP1 live run stops its owned controller without completion', async () => {
  const { dir, store } = fixture();
  const { child, result } = await startLive(dir);
  await stopAntigravityTask(result.taskId);
  assert.equal(child.killCount, 1);
  assert.equal(child.signalCode, 'SIGTERM');
  const saved = store.getTask(result.taskId);
  assert.equal(saved.status, 'error');
  assert.equal(saved.completion, null);
  assert.ok(saved.stopRequestedAt);
});

test('STOP2 live resume uses the same verified stop entry point', async () => {
  const { dir, store } = fixture();
  const { child, taskId } = await resumeLive(store, dir);
  await stopAntigravityTask(taskId);
  assert.equal(child.killCount, 1);
  assert.equal(store.getTask(taskId).status, 'error');
});

test('STOP2b resumed task cancellation also stops its owned durable job', async () => {
  const { dir, store, manager } = fixture();
  const { taskId } = await resumeLive(store, dir);
  const job = manager.startJob({ taskId, command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'], cwd: dir });
  await stopAntigravityTask(taskId);
  assert.equal(manager.getJob(job.id).status, 'cancelled');
  assert.equal(manager.isJobProcessStopped(job.id), true);
  assert.equal(store.getTask(taskId).status, 'error');
});

test('STOP3 durable job is cancelled by JobManager, persisted, and never continued', async () => {
  const { dir, store, manager } = fixture();
  const { result } = await startLive(dir);
  let continued = 0;
  manager.setContinuationRunner(() => { continued += 1; });
  const job = manager.startJob({ taskId: result.taskId, command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'], cwd: dir });
  assert.equal(job.status, 'running');
  await stopAntigravityTask(result.taskId);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.getJob(job.id).status, 'cancelled');
  assert.equal(manager.isJobProcessStopped(job.id), true);
  const reloaded = new JobManager({ storagePath: manager.storagePath });
  assert.equal(reloaded.getJob(job.id).status, 'cancelled');
  assert.ok(reloaded.getJob(job.id).completedAt);
  assert.equal(continued, 0);
  assert.equal(store.getTask(result.taskId).status, 'error');
  assert.deepEqual(await reconcileDurableContinuations({
    taskStore: store, jobManager: manager, continuationRunner: () => { continued += 1; },
  }), []);
  assert.equal(continued, 0);
});

test('STOP4 direct cancelled job still emits evidence but invokes no continuation', async () => {
  const { dir, store, manager } = fixture();
  const taskId = 'cancelled-job-task';
  store.saveTask({ taskId, conversationId: 'cancelled-conversation', workspace: dir,
    status: 'running', pendingContinuation: true });
  let continued = 0;
  manager.setContinuationRunner(() => { continued += 1; });
  const completed = new Promise((resolve) => manager.once('job_completed', resolve));
  const job = manager.startJob({ taskId, command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'], cwd: dir });
  manager.cancelJob(job.id, 'Explicit test cancellation');
  const event = await completed;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(event.job.status, 'cancelled');
  assert.equal(continued, 0);
  assert.deepEqual(await reconcileDurableContinuations({
    taskStore: store, jobManager: manager, continuationRunner: () => { continued += 1; },
  }), []);
});

for (const [name, exitCode, expectedStatus] of [
  ['STOP5 natural success', 0, 'completed'],
  ['STOP6 natural error', 3, 'error'],
]) {
  test(`${name} retains the existing continuation bridge`, async () => {
    const { dir, store, manager } = fixture();
    const taskId = `${name.replaceAll(' ', '-')}-task`;
    store.saveTask({ taskId, conversationId: 'natural-conversation', workspace: dir,
      status: 'running', pendingContinuation: true });
    let continued = 0;
    manager.setContinuationRunner(() => { continued += 1; });
    const completed = new Promise((resolve) => manager.once('job_completed', resolve));
    manager.startJob({ taskId, command: process.execPath,
      args: ['-e', `process.exit(${exitCode})`], cwd: dir });
    const event = await completed;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(event.job.status, expectedStatus);
    assert.equal(continued, 1);
  });
}

test('STOP7 repeated stop and already-terminal stop have no new effects', async () => {
  const { dir, store } = fixture();
  const { child, result } = await startLive(dir);
  await stopAntigravityTask(result.taskId);
  const before = store.getTask(result.taskId).updatedAt;
  await stopAntigravityTask(result.taskId);
  assert.equal(child.killCount, 1);
  assert.equal(store.getTask(result.taskId).updatedAt, before);
  store.saveTask({ taskId: 'already-done', workspace: dir, status: 'done' });
  await stopAntigravityTask('already-done');
  assert.equal(store.getTask('already-done').status, 'done');
});

test('STOP8 restart with lost process ownership returns STOP_UNVERIFIED', async () => {
  const { dir, store, manager } = fixture();
  const taskId = 'lost-owner-task';
  store.saveTask({ taskId, conversationId: 'lost-conversation', workspace: dir,
    status: 'running', jobId: 'lost-job', jobIds: ['lost-job'] });
  manager.jobs.set('lost-job', { id: 'lost-job', taskId, status: 'running', pid: 999999,
    createdAt: new Date().toISOString() });
  manager.save();
  store.reconcileStartupState();
  manager.reconcileStartupState();
  await assert.rejects(stopAntigravityTask(taskId), { code: 'STOP_UNVERIFIED' });
  assert.equal(store.getTask(taskId).status, 'recovery_required');
  assert.equal(manager.getJob('lost-job').status, 'recovery_required');
});

test('STOP9 SIGTERM without verified exit preserves a reviewable stop request', async () => {
  const { dir, store } = fixture();
  const { child, result } = await startLive(dir, { exits: false });
  await assert.rejects(stopAntigravityTask(result.taskId, { verificationTimeoutMs: 50 }),
    { code: 'STOP_UNVERIFIED' });
  const saved = store.getTask(result.taskId);
  assert.equal(saved.status, 'recovery_required');
  assert.ok(saved.stopRequestedAt);
  assert.notEqual(saved.status, 'done');
  // End the mock controller so its real Antigravity watchdog timer is released.
  child.signalCode = 'SIGTERM';
  child.emit('close', null, 'SIGTERM');
});

test('STOP10 a missing task returns typed NOT_FOUND', async () => {
  fixture();
  await assert.rejects(stopAntigravityTask('missing-task'), { code: 'NOT_FOUND' });
});

test('STOP11 in-progress continuation is fenced before stopped task can complete', async () => {
  const { dir, store, manager } = fixture();
  const { taskId } = await resumeLive(store, dir);
  const jobId = 'completed-before-stop';
  const completedAt = new Date().toISOString();
  manager.jobs.set(jobId, { id: jobId, taskId, status: 'completed', completedAt });
  manager.save();
  const task = getAuthoritativeAntigravityTask(taskId);
  task.jobId = jobId;
  task.jobIds = [jobId];
  store.saveTask(task);
  const claim = store.claimContinuation({ taskId, jobId,
    evidence: { taskId, jobId, status: 'completed', completedAt } });
  assert.ok(claim?.attemptId);
  Object.assign(task, claim.task);

  await stopAntigravityTask(taskId);
  const saved = store.getTask(taskId);
  assert.equal(saved.status, 'error');
  assert.equal(saved.continuationState, 'failed');
  assert.ok(saved.stopRequestedAt);
  assert.equal(store.isContinuationOwner(taskId, jobId, claim.attemptId), false);
  assert.equal(store.finishContinuation({ taskId, jobId, attemptId: claim.attemptId,
    state: 'completed', resultStatus: 'done' }), false);
  assert.equal(store.claimContinuation({ taskId, jobId,
    evidence: { taskId, jobId, status: 'completed', completedAt } }), null);
  assert.equal(store.getTask(taskId).status, 'error');
});

test('STOP12 cancelled durable status without child exit remains STOP_UNVERIFIED', async () => {
  const { dir, store, manager } = fixture();
  const { result } = await startLive(dir);
  const jobId = 'job-without-exit';
  const child = { killed: false, exitCode: null, signalCode: null,
    kill() { this.killed = true; return true; } };
  manager.jobs.set(jobId, { id: jobId, taskId: result.taskId, status: 'running',
    pid: 90002, createdAt: new Date().toISOString(), completedAt: null });
  manager.children.set(jobId, child);
  const task = getAuthoritativeAntigravityTask(result.taskId);
  task.jobId = jobId;
  task.jobIds = [jobId];
  store.saveTask(task);

  await assert.rejects(stopAntigravityTask(result.taskId, { verificationTimeoutMs: 50 }),
    { code: 'STOP_UNVERIFIED' });
  assert.equal(manager.getJob(jobId).status, 'cancelled');
  assert.equal(manager.isJobProcessStopped(jobId), false);
  assert.equal(store.getTask(result.taskId).status, 'recovery_required');
});
