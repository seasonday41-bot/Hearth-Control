import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { TaskStore } from '../mcp/executors/task-store.mjs';
import { JobManager, setJobManager } from '../mcp/runtime/job-manager.mjs';
import {
  createTaskContinuationRunner, reconcileDurableContinuations,
  resumeAntigravityTask, setTaskStore, taskRegistry,
} from '../mcp/executors/antigravity.mjs';

const fixtures = [];
function fixture(status = 'running', extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-rec-'));
  const store = new TaskStore({ storagePath: path.join(dir, 'tasks.json') });
  const jm = new JobManager({ storagePath: path.join(dir, 'jobs.json') });
  const taskId = `task-${path.basename(dir)}`;
  const jobId = `job-${path.basename(dir)}`;
  const task = {
    taskId, conversationId: `conv-${path.basename(dir)}`, workspace: dir,
    source: 'local', status, jobId, jobIds: [jobId],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...extra,
  };
  const job = {
    id: jobId, taskId, conversationId: task.conversationId, status: 'completed',
    exitCode: 0, durationMs: 460000, stdout: 'Durable result', stderr: '',
    createdAt: new Date().toISOString(), completedAt: new Date().toISOString(),
  };
  store.saveTask(task);
  jm.jobs.set(jobId, job);
  jm.save();
  fixtures.push({ dir, stores: [store] });
  setTaskStore(store);
  return { dir, store, jm, task, job, taskId, jobId, evidence: jm.getJobResult(jobId) };
}
function runnerFor(f, resumeFn) {
  return createTaskContinuationRunner({
    taskStore: f.store, jobManager: f.jm,
    resumeAntigravityTask: resumeFn,
    emitTaskTransition: () => {},
  });
}
afterEach(() => {
  taskRegistry.clear();
  setTaskStore(null);
  for (const f of fixtures.splice(0)) {
    for (const store of f.stores) store.continuationDb?.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

for (const [name, status, extra] of [
  ['REC1 historical terminal job after restart', 'running', {}],
  ['REC2 waiting parent from old smoke state', 'waiting', {}],
  ['REC3 running pending/disconnected parent after restart', 'running', { pendingContinuation: true, controllerState: 'disconnected' }],
]) {
  test(name, async () => {
    const f = fixture(status, extra);
    const restarted = new TaskStore({ storagePath: f.store.storagePath });
    fixtures.at(-1).stores.push(restarted);
    restarted.load();
    restarted.reconcileStartupState();
    f.store = restarted;
    setTaskStore(restarted);
    let count = 0;
    const runner = runnerFor(f, async ({ taskId, durableJobEvidence }) => {
      count++;
      assert.equal(taskId, f.taskId);
      assert.equal(durableJobEvidence.stdout, 'Durable result');
      return { taskId, conversationId: f.task.conversationId, status: 'done' };
    });
    const results = await reconcileDurableContinuations({ taskStore: restarted, jobManager: f.jm, continuationRunner: runner });
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(count, 1);
    assert.equal(restarted.getTask(f.taskId).status, 'done');
  });
}

test('REC4 continuation fields survive save/load', () => {
  const f = fixture('running', {
    pendingContinuation: true, controllerState: 'disconnected',
  });
  const claim = f.store.claimContinuation({ taskId: f.taskId, jobId: f.jobId, evidence: f.evidence });
  assert.ok(claim);
  const saved = new TaskStore({ storagePath: f.store.storagePath }).getTask(f.taskId);
  assert.equal(saved.pendingContinuation, true);
  assert.equal(saved.controllerState, 'disconnected');
  assert.equal(saved.continuationJobId, f.jobId);
  assert.equal(saved.continuationState, 'in_progress');
  assert.ok(saved.continuationRequestedAt);
  assert.equal(saved.continuationAttemptId, claim.attemptId);
  assert.equal(saved.continuationOwnerPid, process.pid);
  assert.equal(saved.durableJobEvidence.stdout, 'Durable result');
});

test('REC5 concurrent attempts acquire one claim and invoke provider once', async () => {
  const f = fixture();
  let release;
  let entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const runner = runnerFor(f, async () => {
    entered();
    return new Promise((resolve) => { release = resolve; });
  });
  const first = runner({ job: f.job, evidence: f.evidence });
  await enteredPromise;
  const second = await runner({ job: f.job, evidence: f.evidence });
  assert.equal(second, null);
  release({ taskId: f.taskId, status: 'done' });
  await first;
  assert.equal(f.store.getTask(f.taskId).status, 'done');
});

test('REC5b separate processes cannot claim the same live continuation', async () => {
  const f = fixture();
  const moduleUrl = pathToFileURL(path.resolve('mcp/executors/task-store.mjs')).href;
  const source = `import { TaskStore } from ${JSON.stringify(moduleUrl)};
    const store = new TaskStore({ storagePath: process.argv[1] });
    const claimed = store.claimContinuation({ taskId: process.argv[2], jobId: process.argv[3],
      evidence: { taskId: process.argv[2], jobId: process.argv[3], status: 'completed' } });
    console.log(claimed ? 'claimed' : 'skipped');
    await new Promise((resolve) => setTimeout(resolve, 500));`;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, f.store.storagePath, f.taskId, f.jobId]);
    let output = '';
    let error = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { error += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(output.trim()) : reject(new Error(error)));
  });
  const outcomes = await Promise.all([run(), run()]);
  assert.deepEqual(outcomes.sort(), ['claimed', 'skipped']);
});

test('REC5c manual resume cannot bypass an active continuation claim', async () => {
  const f = fixture();
  const claim = f.store.claimContinuation({ taskId: f.taskId, jobId: f.jobId, evidence: f.evidence });
  assert.ok(claim);
  await assert.rejects(resumeAntigravityTask({ taskId: f.taskId }), /active durable continuation/);
});

test('REC5d unwritable live provider is not replaced by a second provider', async () => {
  const f = fixture();
  f.task.child = { pid: process.pid, killed: false, exitCode: null };
  f.task.continueSession = () => false;
  taskRegistry.set(f.taskId, f.task);
  let resumes = 0;
  const runner = runnerFor(f, async () => { resumes++; return { taskId: f.taskId, status: 'done' }; });
  assert.equal(await runner({ task: f.task, job: f.job, evidence: f.evidence }), null);
  assert.equal(resumes, 0);
  assert.equal(f.store.getTask(f.taskId).continuationState, 'in_progress');
});

test('REC6 dead owner with dead provider child is reclaimed after restart', () => {
  const f = fixture();
  const first = f.store.claimContinuation({ taskId: f.taskId, jobId: f.jobId, evidence: f.evidence });
  assert.ok(first);
  f.store._getContinuationDb().prepare(`UPDATE continuation_claims SET owner_pid=99999999,
    child_pid=99999998, phase='running', lease_expires_at=0 WHERE task_id=?`).run(f.taskId);
  const restarted = new TaskStore({ storagePath: f.store.storagePath });
  fixtures.at(-1).stores.push(restarted);
  const next = restarted.claimContinuation({ taskId: f.taskId, jobId: f.jobId, evidence: f.evidence });
  assert.ok(next);
  assert.notEqual(next.attemptId, first.attemptId);
});

test('REC6b reconciliation retries after an orphaned provider child exits', async () => {
  const f = fixture();
  f.store.claimContinuation({ taskId: f.taskId, jobId: f.jobId, evidence: f.evidence });
  f.store._getContinuationDb().prepare(`UPDATE continuation_claims SET owner_pid=99999999,
    child_pid=?, phase='running', lease_expires_at=0 WHERE task_id=?`).run(process.pid, f.taskId);
  let count = 0;
  const runner = runnerFor(f, async () => {
    count++;
    return { taskId: f.taskId, status: 'done' };
  });
  await reconcileDurableContinuations({ taskStore: f.store, jobManager: f.jm, continuationRunner: runner });
  assert.equal(count, 0);
  f.store._getContinuationDb().prepare('UPDATE continuation_claims SET child_pid=99999998 WHERE task_id=?').run(f.taskId);
  await reconcileDurableContinuations({ taskStore: f.store, jobManager: f.jm, continuationRunner: runner });
  assert.equal(count, 1);
});

test('REC7 old attempt cannot commit after a newer claim', async () => {
  const f = fixture();
  let release;
  let entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const oldRunner = runnerFor(f, async () => {
    entered();
    return new Promise((resolve) => { release = resolve; });
  });
  const old = oldRunner({ job: f.job, evidence: f.evidence });
  await enteredPromise;
  f.store._getContinuationDb().prepare(`UPDATE continuation_claims SET child_pid=99999998,
    phase='running', lease_expires_at=0 WHERE task_id=?`).run(f.taskId);
  const newerStore = new TaskStore({ storagePath: f.store.storagePath });
  fixtures.at(-1).stores.push(newerStore);
  const newRunner = createTaskContinuationRunner({
    taskStore: newerStore, jobManager: f.jm, emitTaskTransition: () => {},
    resumeAntigravityTask: async () => ({ taskId: f.taskId, status: 'waiting' }),
  });
  await newRunner({ job: f.job, evidence: f.evidence });
  release({ taskId: f.taskId, status: 'done' });
  assert.equal(await old, null);
  assert.equal(newerStore.getTask(f.taskId).status, 'waiting');
});

test('REC8 duplicate job completion invokes continuation once', async () => {
  const f = fixture();
  f.job.status = 'running';
  f.jm.jobs.set(f.jobId, f.job);
  f.jm.setTaskResolver((id) => f.store.getTask(id));
  let count = 0;
  f.jm.setContinuationRunner(runnerFor(f, async () => {
    count++;
    return { taskId: f.taskId, status: 'done' };
  }));
  f.jm._handleProcessExit(f.jobId, 0, null, null);
  f.jm._handleProcessExit(f.jobId, 0, null, null);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(count, 1);
});

test('REC9 Electron rejects a second instance', () => {
  const source = fs.readFileSync(path.resolve('electron/main.cjs'), 'utf8');
  assert.match(source, /app\.requestSingleInstanceLock\(\)/);
  assert.match(source, /if \(!hasSingleInstanceLock\)\s*\{\s*app\.quit\(\)/);
  assert.match(source, /app\.on\('second-instance'/);
});

test('REC10 runner rejection is persisted with sanitized evidence', async () => {
  const f = fixture();
  const runner = runnerFor(f, async () => { throw new Error('provider unavailable'); });
  await assert.rejects(runner({ job: f.job, evidence: f.evidence }), /provider unavailable/);
  const saved = new TaskStore({ storagePath: f.store.storagePath }).getTask(f.taskId);
  assert.equal(saved.status, 'error');
  assert.equal(saved.continuationState, 'failed');
  assert.match(saved.error, /Continuation failed/);
  assert.equal(saved.durableJobEvidence.stdout, 'Durable result');
});

test('REC10b JobManager handles asynchronous continuation rejection', async () => {
  const f = fixture();
  f.job.status = 'running';
  f.jm.jobs.set(f.jobId, f.job);
  f.jm.setTaskResolver((id) => f.store.getTask(id));
  f.jm.setTaskStoreSaver((task) => f.store.saveTask(task));
  f.jm.setContinuationRunner(runnerFor(f, async () => { throw new Error('provider rejected'); }));
  let unhandled = 0;
  const onUnhandled = () => { unhandled++; };
  process.on('unhandledRejection', onUnhandled);
  try {
    f.jm._handleProcessExit(f.jobId, 1, null, new Error('worker failed'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(unhandled, 0);
    assert.equal(f.store.getTask(f.taskId).status, 'error');
    assert.equal(f.store.getTask(f.taskId).continuationState, 'failed');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('REC11 durable continuation cannot mark plain-text DONE', async () => {
  const f = fixture();
  setJobManager(f.jm);
  taskRegistry.set(f.taskId, f.task);
  const mock = async () => ({
    stdout: JSON.stringify({ event: 'init', conversation_id: f.task.conversationId }) + '\n' +
      JSON.stringify({ event: 'result', status: 'SUCCESS', result: {
        status: 'SUCCESS', response: 'FINAL STATUS: COMPLETED',
      } }) + '\n',
    stderr: '',
  });
  const runner = createTaskContinuationRunner({
    taskStore: f.store, jobManager: f.jm, emitTaskTransition: () => {},
    resumeAntigravityTask: (opts) => resumeAntigravityTask({ ...opts, customAgyPath: process.execPath, runner: mock }),
  });
  await runner({ task: f.task, job: f.job, evidence: f.evidence });
  assert.equal(f.store.getTask(f.taskId).status, 'waiting');
  assert.notEqual(f.store.getTask(f.taskId).status, 'done');
});

test('REC11b manual durable recovery also rejects plain-text DONE', async () => {
  const f = fixture('waiting');
  f.task.durableJobEvidence = f.evidence;
  f.store.saveTask(f.task);
  taskRegistry.set(f.taskId, f.task);
  setJobManager(f.jm);
  const mock = async () => ({
    stdout: JSON.stringify({ event: 'init', conversation_id: f.task.conversationId }) + '\n' +
      JSON.stringify({ event: 'result', status: 'SUCCESS', result: {
        status: 'SUCCESS', response: 'FINAL STATUS: COMPLETED',
      } }) + '\n',
  });
  const result = await resumeAntigravityTask({ taskId: f.taskId, customAgyPath: process.execPath, runner: mock });
  assert.equal(result.status, 'waiting');
});

test('REC12 task, job, and conversation identities remain stable', async () => {
  const f = fixture('waiting');
  const runner = runnerFor(f, async ({ taskId, durableJobEvidence }) => {
    assert.equal(taskId, f.taskId);
    assert.equal(durableJobEvidence.jobId, f.jobId);
    assert.equal(f.store.getTask(taskId).conversationId, f.task.conversationId);
    return { taskId, conversationId: f.task.conversationId, status: 'done' };
  });
  await runner({ job: f.job, evidence: f.evidence });
  const saved = f.store.getTask(f.taskId);
  assert.equal(saved.taskId, f.taskId);
  assert.equal(saved.jobId, f.jobId);
  assert.equal(saved.conversationId, f.task.conversationId);
});
