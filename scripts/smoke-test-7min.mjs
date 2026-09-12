/**
 * Native >7 Minute Antigravity Execution Smoke Test
 *
 * Verifies that an actively streaming process running longer than 7 minutes:
 * 1. Remains RUNNING at 0:00 - 4:59
 * 2. Emits progress prose at ~5:05 ("I will wait...") without transitioning to WAITING
 * 3. Remains RUNNING through min 5 (5:10, 5:30) with heartbeat watchdog reset
 * 4. Collects background command exit results at ~6:00
 * 5. Remains RUNNING past min 7 (7:05)
 * 6. Transitions strictly to DONE upon receiving explicit completion contract at 7:15
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  startAntigravityTask,
  getAntigravityTask,
  isTaskActivelyRunning,
  taskRegistry,
} from '../mcp/executors/antigravity.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workerScript = path.resolve(__dirname, 'smoke-7min-worker.cjs');

const startTime = Date.now();
const formatElapsed = () => {
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  return `${m}m${s.toString().padStart(2, '0')}s (${elapsed}s)`;
};

const log = (msg) => {
  console.log(`[SmokeTest @ ${formatElapsed()}] ${msg}`);
};

console.log('\n═══ Native >7 Minute Antigravity Execution Smoke Test ═══\n');
log(`Starting native smoke test using worker script: ${workerScript}`);

let childProcess = null;

const res = await startAntigravityTask({
  workspace: process.cwd(),
  prompt: 'Execute long-running regression test suites (>7 minutes)',
  title: 'Native 7-Minute Smoke Test',
  customAgyPath: process.execPath,
  userApproved: true,
  // Default watchdog is 330000 (330s = 5m30s)
  executionTimeoutMs: 330000,
  spawnFn: (execPath, args, opts) => {
    // Spawn real node process running workerScript
    childProcess = spawn(process.execPath, [workerScript], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: opts.stdio,
    });
    return childProcess;
  },
});

const taskId = res.taskId;
log(`Task initialized with taskId: ${taskId}, child PID: ${childProcess.pid}`);

const checkpoints = [
  { atSeconds: 10, label: 'T+10s Startup Check' },
  { atSeconds: 120, label: 'T+2m00s Mid-Run Check' },
  { atSeconds: 299, label: 'T+4m59s Pre-5m Check' },
  { atSeconds: 310, label: 'T+5m10s Post-Progress Prose Check (must NOT be WAITING)' },
  { atSeconds: 335, label: 'T+5m35s Past Static Watchdog Deadline Check (heartbeat reset)' },
  { atSeconds: 370, label: 'T+6m10s Post-Background Command Check' },
  { atSeconds: 425, label: 'T+7m05s Past 7-Minute Check (still RUNNING)' },
  { atSeconds: 442, label: 'T+7m22s Post-Completion Check (must be DONE)' },
];

let checkIndex = 0;
const runChecks = async () => {
  for (const cp of checkpoints) {
    const targetMs = cp.atSeconds * 1000;
    const now = Date.now() - startTime;
    const delay = Math.max(0, targetMs - now);
    await new Promise((r) => setTimeout(r, delay));

    const task = getAntigravityTask(taskId);
    const active = isTaskActivelyRunning(taskId);
    log(`CHECKPOINT [${cp.label}]: status=${task.status}, active=${active}, events=${task.recentEvents.length}, childAlive=${!childProcess.killed && childProcess.exitCode === null}`);

    if (cp.atSeconds <= 425) {
      if (task.status !== 'running') {
        throw new Error(`FAILURE at ${cp.label}: Expected status 'running', got '${task.status}' (error: ${task.error})`);
      }
      if (!active) {
        throw new Error(`FAILURE at ${cp.label}: Task is not actively running!`);
      }
      if (task.status === 'waiting') {
        throw new Error(`FAILURE at ${cp.label}: Task entered WAITING prematurely!`);
      }
    } else {
      // Final checkpoint at T+7m22s
      if (task.status !== 'done') {
        throw new Error(`FAILURE at ${cp.label}: Expected status 'done', got '${task.status}' (error: ${task.error})`);
      }
      if (task.completion?.status !== 'done') {
        throw new Error(`FAILURE at ${cp.label}: Expected completion status 'done', got '${task.completion?.status}'`);
      }
      if (!task.lastAnswer?.includes('All 200 regression tests passed successfully')) {
        throw new Error(`FAILURE at ${cp.label}: Unexpected lastAnswer: '${task.lastAnswer}'`);
      }
      log(`SUCCESS! Final answer: "${task.lastAnswer}"`);
    }
  }
};

await runChecks();

log('All checkpoints passed! Cleaning up task.');
taskRegistry.delete(taskId);

console.log('\n══════════════════════════════════════════════════════════');
console.log(`  Native 7-minute smoke test PASSED: total elapsed ${formatElapsed()}`);
console.log('══════════════════════════════════════════════════════════\n');
process.exit(0);
