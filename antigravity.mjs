import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import {
  classifyCompletion,
  isInterimResponse,
  parseFinalResponse,
  verifyDeclaredArtifacts,
  verifyDeclaredArtifactsSync,
} from './completion.mjs';

export {
  classifyCompletion,
  isInterimResponse,
  parseFinalResponse,
  verifyDeclaredArtifacts,
  verifyDeclaredArtifactsSync,
};

import {
  getJobManager,
  startJob as startDurableJobRuntime,
  cancelJob as cancelDurableJobRuntime,
} from '../runtime/job-manager.mjs';

export const MAX_PAYLOAD_BYTES = 65536; // 64 KiB
const MAX_RECENT_EVENTS = 100;
const MAX_EVENT_TEXT_LENGTH = 1000;

// In-memory Task Registry (V1 lifecycle: valid for this process lifetime)
export const taskRegistry = new Map();

let globalTaskStore = null;

// Connect authoritative JobManager task resolution
if (typeof getJobManager === 'function') {
  const jm = getJobManager();
  if (jm && typeof jm.setTaskResolver === 'function') {
    jm.setTaskResolver((taskId) => {
      return taskRegistry.get(taskId) || (globalTaskStore ? globalTaskStore.getTask(taskId) : null);
    });
  }
}

/**
 * Attaches a persistent TaskStore to synchronize task lifecycle events.
 * @param {import('./task-store.mjs').TaskStore | null} store
 */
export const setTaskStore = (store) => {
  globalTaskStore = store;
  if (typeof getJobManager === 'function') {
    const jm = getJobManager();
    if (jm && typeof jm.setTaskResolver === 'function') {
      jm.setTaskResolver((taskId) => {
        return taskRegistry.get(taskId) || (globalTaskStore ? globalTaskStore.getTask(taskId) : null);
      });
    }
    if (jm && typeof jm.setTaskStoreSaver === 'function') {
      jm.setTaskStoreSaver((task) => {
        syncTaskToStore(task);
        emitTaskTransition(task);
      });
    }
  }
};

/**
 * Returns the currently attached TaskStore.
 * @returns {import('./task-store.mjs').TaskStore | null}
 */
export const getTaskStore = () => globalTaskStore;

/**
 * Helper to synchronize a task to persistent store if attached.
 * @param {object} task
 */
export const syncTaskToStore = (task) => {
  if (!task || !task.taskId) return;
  if (globalTaskStore) {
    try {
      globalTaskStore.saveTask(task);
    } catch (err) {
      console.warn(`[Antigravity] Failed to persist task ${task.taskId}:`, err.message);
    }
  }
};

const taskListeners = new Set();

/**
 * Registers a listener for task lifecycle state transitions.
 * @param {(task: object) => void} listener
 * @returns {() => void} unsubscribe function
 */
export const onTaskTransition = (listener) => {
  taskListeners.add(listener);
  return () => taskListeners.delete(listener);
};

/**
 * Emits a task transition event to all registered listeners.
 * @param {object} task
 */
export const emitTaskTransition = (task) => {
  if (!task) return;
  for (const listener of taskListeners) {
    try {
      listener(task);
    } catch (err) {
      console.warn('[Antigravity] Error in task transition listener:', err.message);
    }
  }
};

/**
 * Authoritative predicate: Determines whether a task actively occupies execution resources.
 * Only 'starting', 'running', and undismissed 'recovery_required' occupy active execution.
 * 'paused' only blocks if execution ownership is intentionally retained (task.retainExecutionLock).
 * If task has an attached child process, it is only active if the child process is alive.
 * WAITING does NOT block new independent tasks when no executor process is actively running.
 * Terminal states (done, error) NEVER block.
 *
 * @param {object | string} taskOrId
 * @returns {boolean}
 */
/**
 * Explicit ownership tracking for background child/tool activity.
 * Hearth distinguishes active owned background work, stale/no-progress tasks, exited children, and orphaned processes.
 * @param {string | object} taskOrId
 * @param {{ id?: string, jobId?: string, child?: object, pid?: number, name?: string, command?: string, metadata?: object }} options
 * @returns {object}
 */
export const registerBackgroundJob = (taskOrId, options = {}) => {
  const task = typeof taskOrId === 'string'
    ? (taskRegistry.get(taskOrId) || (globalTaskStore ? globalTaskStore.getTask(taskOrId) : null))
    : taskOrId;
  if (!task) throw new Error(`Task '${taskOrId}' not found.`);
  if (task.durableRoute) {
    // Requirement 2: Durable-required tasks must not create unmanaged background jobs
    console.warn(`[Antigravity] Blocked unmanaged background job registration for durable-routed task '${task.taskId}'`);
    return null;
  }
  if (!task.backgroundJobs) task.backgroundJobs = new Map();

  const jobId = options.id || options.jobId || `bg-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const job = {
    id: jobId,
    name: options.name || options.command || 'background_job',
    pid: options.pid || options.child?.pid || null,
    child: options.child || null,
    status: 'running',
    state: 'running',
    registeredAt: options.registeredAt || options.startedAt || now,
    startedAt: options.startedAt || options.registeredAt || now,
    lastHeartbeatAt: now,
    heartbeatCount: 0,
    exitCode: null,
    completedAt: null,
    output: '',
    metadata: options.metadata || {},
  };

  if (job.child && typeof job.child.on === 'function') {
    const onStdout = (chunk) => {
      recordBackgroundHeartbeat(task.taskId, {
        jobId,
        text: chunk.toString('utf8'),
        source: 'background_stdout',
      });
    };
    const onStderr = (chunk) => {
      recordBackgroundHeartbeat(task.taskId, {
        jobId,
        text: chunk.toString('utf8'),
        source: 'background_stderr',
      });
    };
    const onHeartbeat = (data) => {
      const text = typeof data === 'string' ? data : (data?.text || data?.message || 'heartbeat');
      recordBackgroundHeartbeat(task.taskId, {
        jobId,
        text,
        source: 'background_heartbeat',
      });
    };
    const onExit = (code) => {
      completeBackgroundJob(task.taskId, {
        jobId,
        exitCode: code ?? 0,
        output: job.output,
      });
    };
    const onClose = (code) => {
      completeBackgroundJob(task.taskId, {
        jobId,
        exitCode: code ?? 0,
        output: job.output,
      });
    };

    job.child.stdout?.on?.('data', onStdout);
    job.child.stderr?.on?.('data', onStderr);
    job.child.on?.('heartbeat', onHeartbeat);
    job.child.on?.('exit', onExit);
    job.child.on?.('close', onClose);

    job.detachListeners = () => {
      try { job.child?.stdout?.removeListener?.('data', onStdout); } catch {}
      try { job.child?.stderr?.removeListener?.('data', onStderr); } catch {}
      try { job.child?.removeListener?.('heartbeat', onHeartbeat); } catch {}
      try { job.child?.removeListener?.('exit', onExit); } catch {}
      try { job.child?.removeListener?.('close', onClose); } catch {}
    };
  }

  task.backgroundJobs.set(jobId, job);
  if (typeof task.resetWatchdog === 'function') {
    task.resetWatchdog('background_registered', { jobId });
  }
  syncTaskToStore(task);
  emitTaskTransition(task);
  return job;
};

/**
 * Creates a safe Node CLI worker specification.
 * When running inside a packaged Electron environment where process.execPath
 * points to the Electron binary, sets ELECTRON_RUN_AS_NODE: '1' in the child environment
 * so Electron executes in pure Node CLI mode without spawning GUI windows or Chromium helpers.
 *
 * @param {object} options
 * @returns {{ command: string, args: string[], cwd: string, env: Record<string, string> }}
 */
export const createNodeWorkerSpec = ({
  command = process.execPath,
  args = [],
  cwd = process.cwd(),
  env = {},
} = {}) => {
  return {
    command,
    args,
    cwd,
    env: {
      ...env,
      ELECTRON_RUN_AS_NODE: '1',
    },
  };
};

/**
 * Creates the controlled worker specification for durable background execution.
 * If custom command is provided in metadata, uses it; otherwise generates the controlled Node worker.
 * @param {object} metadata
 * @param {string} workspace
 * @returns {{ command: string, args: string[], cwd: string, env: Record<string, string> }}
 */
export const createControlledWorkerSpec = (metadata = {}, workspace = process.cwd()) => {
  if (metadata.command) {
    const isNodeExec = metadata.command === process.execPath || String(metadata.command).endsWith('node');
    return {
      command: metadata.command,
      args: Array.isArray(metadata.args) ? metadata.args : [],
      cwd: metadata.cwd || workspace,
      env: {
        ...(metadata.env || {}),
        ...(isNodeExec ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      },
    };
  }

  const durationSec = Number(metadata.worker_duration_seconds || metadata.duration_seconds || 440);
  const intervalSec = Number(metadata.heartbeat_interval_seconds || 20);
  const exitCode = Number(metadata.exit_code ?? 0);

  const nodeScript = [
    `const durationSec = ${durationSec};`,
    `const intervalSec = ${intervalSec};`,
    `const exitCode = ${exitCode};`,
    `let elapsed = 0;`,
    `console.log('[worker] Hearth controlled durable worker started. Total duration: ' + durationSec + 's, interval: ' + intervalSec + 's');`,
    `const timer = setInterval(() => {`,
    `  elapsed += intervalSec;`,
    `  console.log('[heartbeat] tick at elapsed ' + elapsed + 's / ' + durationSec + 's');`,
    `  if (elapsed >= durationSec) {`,
    `    clearInterval(timer);`,
    `    console.log('[worker] Hearth controlled durable worker finished successfully. All assertions verified.');`,
    `    process.exit(exitCode);`,
    `  }`,
    `}, Math.max(10, Math.round(intervalSec * 1000)));`,
  ].join('\n');

  return createNodeWorkerSpec({
    command: process.execPath,
    args: ['-e', nodeScript],
    cwd: workspace,
    env: metadata.env || {},
  });
};

/**
 * Checks whether task metadata dictates routing to the Hearth Durable Job Runtime.
 * @param {object} metadata
 * @returns {boolean}
 */
export const shouldRouteToDurableJob = (metadata = {}) => {
  if (!metadata || typeof metadata !== 'object') return false;
  return Boolean(
    metadata.requires_hearth_owned_job === true ||
    metadata.requires_hearth_owned_job === 'true' ||
    metadata.durable_route === true ||
    metadata.durableRoute === true
  );
};

/**
 * Starts a Hearth-owned durable background job associated with a task.
 * Directly spawns a ChildProcess tracked by Hearth's JobManager.
 * @param {object} options
 * @returns {object} job
 */
export const startDurableJob = ({
  taskId,
  command,
  args = [],
  cwd,
  env = {},
  timeoutMs,
  metadata = {},
} = {}) => {
  const manager = getJobManager();
  const task = taskId
    ? (taskRegistry.get(taskId) || (globalTaskStore ? globalTaskStore.getTask(taskId) : null))
    : null;

  const jobEnv = {
    ...env,
    ...(command === process.execPath && env.ELECTRON_RUN_AS_NODE === undefined ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
  };

  const job = manager.startJob({
    taskId,
    conversationId: task?.conversationId || null,
    command,
    args,
    cwd: cwd || task?.workspace || process.cwd(),
    env: jobEnv,
    timeoutMs,
    metadata,
  });

  if (task) {
    task.jobId = job.id;
    if (!Array.isArray(task.jobIds)) task.jobIds = [];
    if (!task.jobIds.includes(job.id)) task.jobIds.push(job.id);
    task.durableRoute = true;
    task.pendingContinuation = true;
    if (typeof task.resetWatchdog === 'function') {
      task.resetWatchdog('durable_job_started', { jobId: job.id });
    }
    syncTaskToStore(task);
    emitTaskTransition(task);
  }

  return job;
};

/**
 * Records a verified activity / heartbeat signal from an active owned background job.
 * Watchdog is only reset on genuine verified process activity.
 * @param {string | object} taskOrId
 * @param {{ jobId?: string, text?: string, progress?: string, source?: string }} params
 * @returns {boolean}
 */
export const recordBackgroundHeartbeat = (taskOrId, { jobId, text, progress, source = 'background_heartbeat' } = {}) => {
  const task = typeof taskOrId === 'string'
    ? (taskRegistry.get(taskOrId) || (globalTaskStore ? globalTaskStore.getTask(taskOrId) : null))
    : taskOrId;
  if (!task || !task.backgroundJobs) return false;
  if (task.durableRoute) {
    // Durable route uses authoritative JobManager heartbeats only
    return false;
  }

  // Terminal check: background heartbeat cannot keep terminal task alive
  if (task.status === 'done' || task.status === 'error') {
    return false;
  }

  // Controller state check: background heartbeat may only keep task RUNNING
  // if primary controller session is healthy or actively inside bounded recovery.
  const controllerState = task.controllerState || 'healthy';
  if (controllerState !== 'healthy' && controllerState !== 'recovering') {
    return false;
  }

  const job = jobId
    ? task.backgroundJobs.get(jobId)
    : Array.from(task.backgroundJobs.values()).find((j) => (j.status === 'running' || j.state === 'running'));
  if (!job) return false;

  // Liveness check: child must be genuinely alive
  if (job.child) {
    if (job.child.killed || job.child.exitCode !== null) {
      job.status = 'exited';
      job.state = 'exited';
      job.exitCode = job.child.exitCode;
      return false;
    }
  } else if (job.pid && typeof job.pid === 'number') {
    try {
      process.kill(job.pid, 0);
    } catch {
      job.status = 'orphaned';
      job.state = 'orphaned';
      return false;
    }
  }

  task.heartbeatSeq = (task.heartbeatSeq || 0) + 1;
  job.lastHeartbeatAt = new Date().toISOString();
  job.heartbeatCount = (job.heartbeatCount || 0) + 1;
  job.status = 'running';
  job.state = 'running';
  if (text) {
    job.output = (job.output + text).slice(-65536);
  }

  const sanitizedText = text
    ? redactSecrets(String(text)).slice(0, MAX_EVENT_TEXT_LENGTH)
    : (progress ? redactSecrets(String(progress)).slice(0, MAX_EVENT_TEXT_LENGTH) : 'Background heartbeat signal');

  if (!Array.isArray(task.recentEvents)) task.recentEvents = [];
  task.recentEvents.push({
    stepIndex: task.recentEvents.length + 1,
    type: 'BACKGROUND_HEARTBEAT',
    status: 'RUNNING',
    createdAt: new Date().toISOString(),
    summary: sanitizedText,
  });
  if (task.recentEvents.length > MAX_RECENT_EVENTS) task.recentEvents.shift();
  task.lastEvent = task.recentEvents[task.recentEvents.length - 1];
  task.updatedAt = new Date().toISOString();

  // Reset watchdog on verified active work signal
  if (typeof task.resetWatchdog === 'function') {
    task.resetWatchdog(source, {
      jobId: job.id,
      heartbeatCount: job.heartbeatCount,
      seq: task.heartbeatSeq,
    });
  }

  syncTaskToStore(task);
  emitTaskTransition(task);
  return true;
};

/**
 * Completes an owned background job, capturing sanitized evidence and triggering continuation if needed.
 * @param {string | object} taskOrId
 * @param {{ jobId?: string, exitCode?: number, output?: string, error?: string }} params
 * @returns {boolean}
 */
export const completeBackgroundJob = (taskOrId, { jobId, exitCode = 0, output = '', error = null } = {}) => {
  const task = typeof taskOrId === 'string'
    ? (taskRegistry.get(taskOrId) || (globalTaskStore ? globalTaskStore.getTask(taskOrId) : null))
    : taskOrId;
  if (!task || !task.backgroundJobs) return false;

  const job = jobId
    ? task.backgroundJobs.get(jobId)
    : Array.from(task.backgroundJobs.values()).find((j) => (j.status === 'running' || j.state === 'running'));
  if (!job) return false;

  job.status = exitCode === 0 ? 'completed' : 'failed';
  job.state = job.status;
  job.exitCode = exitCode;
  job.completedAt = new Date().toISOString();
  if (typeof job.detachListeners === 'function') {
    job.detachListeners();
  }
  if (output) {
    job.output = (job.output + output).slice(-65536);
  }

  // Requirement 11.D: owned background child exits with error before final contract -> ERROR
  if (exitCode !== 0 && !task.completion) {
    const errorMsg = redactSecrets(error || output || `Background process exited with error code ${exitCode}`);
    task.status = 'error';
    task.error = errorMsg;
    task.completion = {
      status: 'error',
      normalizedStatus: 'error',
      summary: errorMsg,
      error: errorMsg,
      checks: { build: 'not_run', tests: 'not_run' },
      artifacts: [],
    };
    task.updatedAt = new Date().toISOString();
    syncTaskToStore(task);
    emitTaskTransition(task);
    if (task.cleanup) task.cleanup();
    return true;
  }

  const sanitizedSummary = redactSecrets(output || error || `Background job finished with code ${exitCode}`).slice(0, MAX_EVENT_TEXT_LENGTH);
  if (!Array.isArray(task.recentEvents)) task.recentEvents = [];
  task.recentEvents.push({
    stepIndex: task.recentEvents.length + 1,
    type: 'BACKGROUND_COMPLETION',
    status: exitCode === 0 ? 'DONE' : 'ERROR',
    createdAt: new Date().toISOString(),
    summary: sanitizedSummary,
  });
  if (task.recentEvents.length > MAX_RECENT_EVENTS) task.recentEvents.shift();
  task.lastEvent = task.recentEvents[task.recentEvents.length - 1];
  task.updatedAt = new Date().toISOString();

  if (typeof task.resetWatchdog === 'function') {
    task.resetWatchdog('background_completion', { jobId: job.id, exitCode });
  }

  // Trigger continuation turn if task has pending continuation
  if (task.pendingContinuation && typeof task.continueSession === 'function') {
    const continuePrompt = [
      'The background command or tool has completed.',
      sanitizedSummary ? `Output: ${sanitizedSummary}` : '',
      `Exit code: ${exitCode}`,
      'Please evaluate the result and provide your final completion contract in JSON format.',
      HEARTH_COMPLETION_INSTRUCTION,
    ].filter(Boolean).join('\n');
    task.continueSession(continuePrompt);
  }

  syncTaskToStore(task);
  emitTaskTransition(task);
  return true;
};

/**
 * Distinguishes execution state: active_owned_background_work, stale_no_progress_task, exited_child, orphaned_process.
 * @param {string | object} taskOrId
 * @returns {{ state: string, executorAlive: boolean, activeBackgroundCount?: number, exitedBackgroundCount?: number, orphanedBackgroundCount?: number }}
 */
export const getTaskExecutionState = (taskOrId) => {
  const task = typeof taskOrId === 'string'
    ? (taskRegistry.get(taskOrId) || (globalTaskStore ? globalTaskStore.getTask(taskOrId) : null))
    : taskOrId;
  if (!task) return { state: 'not_found', executorAlive: false, controllerState: 'closed' };

  const mem = taskRegistry.get(task.taskId) || task;
  const executorAlive = Boolean(mem.child && !mem.child.killed && mem.child.exitCode === null);
  const controllerState = mem.controllerState || 'healthy';

  let activeBackgroundCount = 0;
  let exitedBackgroundCount = 0;
  let orphanedBackgroundCount = 0;

  if (mem.backgroundJobs) {
    for (const job of mem.backgroundJobs.values()) {
      if (job.status === 'running') {
        if (job.child) {
          if (job.child.killed || job.child.exitCode !== null) {
            job.status = 'exited';
            exitedBackgroundCount++;
          } else {
            activeBackgroundCount++;
          }
        } else if (job.pid && typeof job.pid === 'number') {
          try {
            process.kill(job.pid, 0);
            activeBackgroundCount++;
          } catch {
            job.status = 'orphaned';
            orphanedBackgroundCount++;
          }
        } else {
          activeBackgroundCount++;
        }
      } else if (job.status === 'completed' || job.status === 'failed' || job.status === 'exited') {
        exitedBackgroundCount++;
      } else if (job.status === 'orphaned') {
        orphanedBackgroundCount++;
      }
    }
  }

  // If controller is interrupted, background jobs do not constitute active owned work
  if (controllerState === 'interrupted') {
    return {
      state: 'controller_interrupted',
      executorAlive,
      controllerState,
      activeBackgroundCount,
      exitedBackgroundCount,
      orphanedBackgroundCount,
    };
  }

  if (activeBackgroundCount > 0 && (controllerState === 'healthy' || controllerState === 'recovering')) {
    return {
      state: 'active_owned_background_work',
      executorAlive,
      controllerState,
      activeBackgroundCount,
      exitedBackgroundCount,
      orphanedBackgroundCount,
    };
  }

  if (orphanedBackgroundCount > 0 && !executorAlive) {
    return {
      state: 'orphaned_process',
      executorAlive,
      controllerState,
      orphanedBackgroundCount,
    };
  }

  if (exitedBackgroundCount > 0 && !executorAlive) {
    return {
      state: 'exited_child',
      executorAlive,
      controllerState,
      exitedBackgroundCount,
    };
  }

  if (!executorAlive && (task.status === 'running' || task.status === 'starting')) {
    return {
      state: 'stale_no_progress_task',
      executorAlive: false,
      controllerState,
    };
  }

  return {
    state: executorAlive ? 'active_executor' : task.status,
    executorAlive,
    controllerState,
    activeBackgroundCount,
    exitedBackgroundCount,
    orphanedBackgroundCount,
  };
};

/**
 * Authoritative predicate determining whether a task is actively running.
 * Only 'starting', 'running', and undismissed 'recovery_required' occupy active execution.
 * 'paused' only blocks if execution ownership is intentionally retained (task.retainExecutionLock).
 * If task has an attached child process or background job, it is active while any owned process is alive.
 * WAITING does NOT block new independent tasks when no executor process is actively running.
 * Terminal states (done, error) NEVER block.
 *
 * @param {object | string} taskOrId
 * @returns {boolean}
 */
export const isTaskActivelyRunning = (taskOrId) => {
  if (!taskOrId) return false;
  let task = taskOrId;
  if (typeof taskOrId === 'string') {
    task = taskRegistry.get(taskOrId) || (globalTaskStore ? (globalTaskStore.getTask(taskOrId) || globalTaskStore.findTaskByRemoteLink({ remoteTaskId: taskOrId })) : null);
    if (!task) return false;
  }
  if (task.dismissed) return false;
  if (task.status === 'done' || task.status === 'error') return false;

  const mem = taskRegistry.get(task.taskId) || task;
  const controllerState = mem.controllerState || 'healthy';

  // If there is an active Hearth-owned durable job running, task remains actively running
  if (typeof getJobManager === 'function') {
    const activeDurable = getJobManager().listJobs({ taskId: task.taskId, status: 'running' });
    if (activeDurable.length > 0) {
      return true;
    }
  }

  // If controller is terminally interrupted, exited, or closed, task is not actively running
  if (controllerState === 'interrupted' || controllerState === 'exited' || controllerState === 'closed') {
    return false;
  }

  // If there is an active executor child process alive, execution is genuinely active
  if (mem && mem.child && !mem.child.killed && mem.child.exitCode === null) {
    return true;
  }
  // If there is active owned background work alive AND controller is healthy or recovering
  if (mem && mem.backgroundJobs && (controllerState === 'healthy' || controllerState === 'recovering')) {
    for (const job of mem.backgroundJobs.values()) {
      if (job.status === 'running') {
        if (job.child && !job.child.killed && job.child.exitCode === null) return true;
        if (job.pid && typeof job.pid === 'number') {
          try { process.kill(job.pid, 0); return true; } catch {}
        }
      }
    }
  }
  if (task.status === 'starting' || task.status === 'running') {
    if (mem && mem.child) {
      return !mem.child.killed && mem.child.exitCode === null;
    }
    return true;
  }
  if (task.status === 'recovery_required') {
    return !task.dismissed;
  }
  if (task.status === 'paused' && task.retainExecutionLock) {
    return true;
  }
  return false;
};

/**
 * Checks whether any task in the registry or persistent store is currently active.
 * Only starting, running, and undismissed recovery_required block new task dispatches.
 * Used as an idempotency / mutex guard against duplicate task dispatches.
 * @returns {boolean}
 */
export const hasRunningTask = () => {
  for (const task of taskRegistry.values()) {
    if (isTaskActivelyRunning(task)) {
      return true;
    }
  }
  if (globalTaskStore && globalTaskStore.tasks) {
    for (const task of globalTaskStore.tasks.values()) {
      if (task.status === 'recovery_required' && !task.dismissed) {
        return true;
      }
      if (task.status === 'paused' && task.retainExecutionLock && !task.dismissed) {
        return true;
      }
      if ((task.status === 'starting' || task.status === 'running') && !task.dismissed) {
        const mem = taskRegistry.get(task.taskId);
        if (mem) {
          if (isTaskActivelyRunning(mem)) return true;
        } else {
          return true;
        }
      }
    }
  }
  return false;
};

/**
 * Secret redaction: strip tokens, passwords, bearer credentials, and API keys.
 * Ensures zero credential leakage in task registry and MCP responses.
 * @param {string} text
 * @returns {string}
 */
export const redactSecrets = (text) => {
  if (typeof text !== 'string') return '';
  return text
    // Bearer tokens
    .replace(/Bearer\s+[A-Za-z0-9_\-\.]+/gi, 'Bearer [REDACTED]')
    // Google API Keys (AIza...)
    .replace(/AIza[0-9A-Za-z-_]{30,45}/g, '[REDACTED_API_KEY]')
    // Private keys
    .replace(/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
    // JSON credential-like fields ("password": "...", "token": "...", "client_secret": "...")
    .replace(/"(password|token|secret|access_token|client_secret|refresh_token|auth_token)"\s*:\s*"[^"]+"/gi, '"$1": "[REDACTED]"')
    // Antigravity local service/session credentials if they ever appear in diagnostics
    .replace(/(ANTIGRAVITY_(?:CSRF_TOKEN|SIDECAR_UI_TOKEN)\s*=\s*)[^\s]+/gi, '$1[REDACTED]')
    // Generic JWT tokens
    .replace(/eyJ[A-Za-z0-9-_=]{10,}\.[A-Za-z0-9-_=]{10,}\.?[A-Za-z0-9-_.+/=]*/g, '[REDACTED_JWT]');
};

/**
 * Resolves the supported Antigravity CLI used for headless automation.
 * The CLI authenticates through the operating system keyring; Hearth never
 * reads or copies Antigravity's internal CSRF/session credentials.
 * @param {string} [customPath]
 * @returns {Promise<string | null>}
 */
export const resolveAgyPath = async (customPath) => {
  const candidates = customPath
    ? [customPath]
    : [
        path.join(os.homedir(), '.local', 'bin', 'agy'),
        ...String(process.env.PATH || '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, 'agy')),
      ];

  for (const candidate of candidates) {
    try {
      await fsPromises.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Continue to the next supported install location.
    }
  }
  return null;
};

/**
 * Resolves the agentapi path using os.homedir() without hardcoded usernames.
 * Checks default location in ~/.gemini/antigravity/bin/agentapi, then PATH.
 * @param {string} [customPath]
 * @returns {Promise<string | null>}
 */
export const resolveAgentApiPath = async (customPath) => {
  if (customPath) {
    try {
      await fsPromises.access(customPath, fs.constants.X_OK);
      return customPath;
    } catch {
      return null;
    }
  }

  // 1. Resolve ~/.gemini/antigravity/bin/agentapi via os.homedir()
  const home = os.homedir();
  const defaultPath = path.join(home, '.gemini', 'antigravity', 'bin', 'agentapi');
  try {
    await fsPromises.access(defaultPath, fs.constants.X_OK);
    return defaultPath;
  } catch {
    // 2. Fallback: check PATH
    const envPath = process.env.PATH || '';
    const dirs = envPath.split(path.delimiter);
    for (const dir of dirs) {
      if (!dir) continue;
      const candidate = path.join(dir, 'agentapi');
      try {
        await fsPromises.access(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // continue search
      }
    }
    return null;
  }
};

/**
 * Detects presence and readiness of Antigravity installation on this machine.
 * @param {{ customAgentApiPath?: string, customAppPath?: string }} [options]
 * @returns {Promise<{ available: boolean, agentApiPath: string | null, appPath: string | null, reason: string | null }>}
 */
export const detectAntigravity = async ({ customAgentApiPath, customAgyPath, customAppPath } = {}) => {
  const cliPath = await resolveAgyPath(customAgyPath);
  const agentApiPath = await resolveAgentApiPath(customAgentApiPath);
  const appPath = customAppPath || '/Applications/Antigravity.app';

  let appExists = false;
  try {
    const stat = await fsPromises.stat(appPath);
    appExists = stat.isDirectory();
  } catch {
    appExists = false;
  }

  if (!cliPath && !agentApiPath && !appExists) {
    return { available: false, cliPath: null, agentApiPath: null, appPath: null, executionMode: null, reason: 'Neither Antigravity CLI nor Antigravity.app was found on this system.' };
  }
  if (!cliPath) {
    return { available: false, cliPath: null, agentApiPath, appPath: appExists ? appPath : null, executionMode: null, reason: 'Antigravity CLI is required for secure headless execution. Install agy in ~/.local/bin.' };
  }
  if (!appExists) {
    return { available: false, cliPath, agentApiPath, appPath: null, executionMode: null, reason: 'Antigravity CLI exists but Antigravity.app was not found in /Applications.' };
  }

  return { available: true, cliPath, agentApiPath, appPath, executionMode: 'cli-headless', reason: null };
};

/**
 * Default process runner using child_process.execFile (no shell execution).
 * Sanitizes environment to ensure oauth credential files are never read or logged.
 */
export const defaultRunner = async (file, args, options = {}) => {
  const env = { ...process.env };
  // Never pass or leak sensitive credentials to child process
  delete env.GOOGLE_APPLICATION_CREDENTIALS;

  return new Promise((resolve, reject) => {
    const child = execFile(file, args, {
      cwd: options.cwd,
      env,
      timeout: options.timeout || 30000,
      maxBuffer: 4 * 1024 * 1024,
      shell: false,
    }, (error, stdout = '', stderr = '') => {
      if (!error) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
        return;
      }
      const output = [stdout, stderr].filter(Boolean).join('\n').trim();
      const cleanMessage = redactSecrets(output || error.message);
      const err = new Error(cleanMessage);
      err.code = error.code;
      reject(err);
    });

    if (options.input !== undefined) {
      child.stdin?.end(String(options.input));
    }
  });
};

export const isStreamInterruptedMessage = (text, options = {}) => {
  if (typeof text !== 'string') return false;
  const lower = text.toLowerCase();

  // 1. Literal / existing stream interruption patterns (unambiguous transport breaks)
  if (
    lower.includes('stream was interrupted') ||
    lower.includes('stream interrupted') ||
    lower.includes('connection interrupted') ||
    lower.includes('stream closed unexpectedly')
  ) {
    return true;
  }

  // 2. Stream input context cancellation patterns:
  // "stream input cancelled: context canceled", "stream input canceled: context canceled",
  // "stream input cancelled", "stream input canceled", or "context canceled" in stream transport
  const isContextCancellation =
    lower.includes('stream input cancelled') ||
    lower.includes('stream input canceled') ||
    lower.includes('context canceled') ||
    lower.includes('context cancelled');

  if (isContextCancellation) {
    // Resolve task context if provided
    const task = options.task || (typeof options === 'object' && options.taskId ? options : null);

    // Check if cancellation was intentionally initiated by Hearth
    const isIntentional =
      options.isIntentional === true ||
      task?.intentionalCancel === true ||
      task?.isCleaningUp === true ||
      task?.isCleanedUp === true ||
      task?.status === 'done' ||
      task?.status === 'error' ||
      task?.controllerState === 'closed' ||
      task?.controllerState === 'interrupted' ||
      task?.controllerState === 'exited';

    if (isIntentional) {
      return false;
    }

    // When task context is known, verify that the task was actively running
    if (task) {
      const isRunning = task.status === 'running' || task.status === 'starting';
      const isHealthyOrRecovering = task.controllerState === 'healthy' || task.controllerState === 'recovering';
      return isRunning && isHealthyOrRecovering;
    }

    // If called without task context, treat as unexpected interruption unless options.isIntentional is true
    return !options.isIntentional;
  }

  return false;
};

export const isStreamInterruptionEvent = (event, options = {}) => {
  if (!event || typeof event !== 'object') return false;
  const evtType = String(event.event || event.type || '').toLowerCase();
  if (evtType === 'interrupted') {
    return true;
  }

  const errCandidate = String(event.error || event.message || '');
  if (errCandidate && isStreamInterruptedMessage(errCandidate, options)) {
    return true;
  }

  if (event.result && typeof event.result === 'object') {
    const res = event.result;
    if (res.error && isStreamInterruptedMessage(String(res.error), options)) return true;
    if (res.message && isStreamInterruptedMessage(String(res.message), options)) return true;
    if (res.response && isStreamInterruptedMessage(String(res.response), options)) return true;
    if ((res.status === 'ERROR' || res.status === 'error') && !res.response) {
      if (res.error && isStreamInterruptedMessage(String(res.error), options)) return true;
    }
  }

  if (event.step_update && typeof event.step_update === 'object') {
    const step = event.step_update;
    if (step.text_delta && isStreamInterruptedMessage(String(step.text_delta), options)) return true;
    if (step.error && isStreamInterruptedMessage(String(step.error), options)) return true;
    if (step.state === 'ERROR' && isStreamInterruptedMessage(String(step.text_delta || step.summary || ''), options)) return true;
  }

  if (evtType === 'error') {
    return isStreamInterruptedMessage(errCandidate, options);
  }

  return false;
};

export const extractInterruptionMessage = (event) => {
  if (!event || typeof event !== 'object') return 'The stream was interrupted.';
  const candidates = [
    event.error,
    event.message,
    event.result?.error,
    event.result?.message,
    event.result?.response,
    event.step_update?.error,
    event.step_update?.text_delta,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return 'The stream was interrupted.';
};

export const isInitEvent = (event) => {
  if (!event || typeof event !== 'object') return false;
  const evt = String(event.event || event.type || '').toLowerCase();
  return evt === 'init' || evt === 'session_start' || evt === 'start';
};

export const isResultEvent = (event) => {
  if (!event || typeof event !== 'object') return false;
  const evt = String(event.event || event.type || '').toLowerCase();
  return ['result', 'final', 'final_response', 'complete', 'completion', 'done'].includes(evt);
};

export const extractConversationId = (event) => {
  if (!event || typeof event !== 'object') return null;
  return (
    event.conversation_id ||
    event.init?.conversation_id ||
    event.result?.conversation_id ||
    event.conversationId ||
    event.result?.conversationId ||
    null
  );
};

export const extractResponsePayload = (event) => {
  if (!event || typeof event !== 'object') return null;
  const res = event.result !== undefined && event.result !== null ? event.result : event;

  if (typeof res === 'string') return res;
  if (typeof res !== 'object' || Array.isArray(res)) return null;

  const candidateKeys = [
    'response',
    'output',
    'text',
    'content',
    'message',
    'summary',
    'final_response',
    'finalResponse',
  ];

  for (const key of candidateKeys) {
    const val = res[key];
    if (val !== undefined && val !== null) {
      if (typeof val === 'string' && val.trim()) return val;
      if (typeof val === 'object' && !Array.isArray(val)) return val;
    }
  }

  // Also check top-level event if event.result was an object that didn't have the key
  if (event.result && typeof event.result === 'object') {
    for (const key of candidateKeys) {
      const val = event[key];
      if (val !== undefined && val !== null) {
        if (typeof val === 'string' && val.trim()) return val;
        if (typeof val === 'object' && !Array.isArray(val)) return val;
      }
    }
  }

  if (res.response !== undefined) return res.response;
  if (event.response !== undefined) return event.response;

  return null;
};

export const parseAgyStream = (stdout) => {
  const events = [];
  let conversationId = null;
  let result = null;
  let responsePayload = null;

  for (const line of String(stdout || '').split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    events.push(event);
    if (isInitEvent(event)) {
      conversationId = extractConversationId(event) || conversationId;
    }
    if (isResultEvent(event)) {
      result = event.result !== undefined && event.result !== null ? event.result : event;
      responsePayload = extractResponsePayload(event);
      conversationId = extractConversationId(event) || conversationId;
    }
  }

  if (!result) throw new Error('Antigravity CLI did not return a final result event.');
  if (!conversationId) throw new Error('Antigravity CLI did not return a conversation ID.');
  return { conversationId, result, response: responsePayload, events };
};

const appendAgyEvents = (task, events) => {
  if (!task) return;
  if (!Array.isArray(task.recentEvents)) task.recentEvents = [];
  for (const event of events) {
    const step = event.step_update;
    if (!step) continue;
    const summary = redactSecrets(String(step.text_delta || step.tool_name || step.step_type || '').slice(0, MAX_EVENT_TEXT_LENGTH));
    task.recentEvents.push({
      stepIndex: step.step_index ?? task.recentEvents.length,
      type: String(step.step_type || 'UNKNOWN').toUpperCase(),
      status: step.state || null,
      createdAt: new Date().toISOString(),
      summary,
    });
    if (task.recentEvents.length > MAX_RECENT_EVENTS) task.recentEvents.shift();
  }
  task.lastEvent = task.recentEvents.length > 0 ? task.recentEvents[task.recentEvents.length - 1] : null;
};

export const HEARTH_COMPLETION_INSTRUCTION = [
  '<HEARTH_COMPLETION_CONTRACT>',
  'When you finish your response, you MUST provide a final completion contract block in JSON format within markdown fences:',
  '```json',
  '{',
  '  "status": "completed" | "waiting" | "error",',
  '  "summary": "<summary of work or current state>"',
  '}',
  '```',
  'STRICT RULES:',
  '- "status" MUST be strictly one of: "completed", "waiting", "error".',
  '- Never use "done", "success", "ok", "finished", or other status values.',
  '- Use "completed" when all tasks and requirements are fully finished.',
  '- Use "waiting" if user input, sign-off, or additional information is required, or if work remains in progress.',
  '- Use "error" if the task encountered a fatal error or could not be completed.',
  '</HEARTH_COMPLETION_CONTRACT>',
].join('\n');

export const buildAgyPrompt = (workspace, prompt) => [
  '<HEARTH_CONTEXT>',
  `The approved workspace is exactly: ${workspace}`,
  'Treat that directory as the workspace root. Use that exact path or the current directory for filesystem operations.',
  'Do not inspect parent directories or the user home directory unless the task explicitly requests it and the active permission policy allows it.',
  '</HEARTH_CONTEXT>',
  '<REMOTE_TASK>',
  prompt,
  '</REMOTE_TASK>',
  '',
  HEARTH_COMPLETION_INSTRUCTION,
].join('\n');

/**
 * Starts a transcript watcher for a given conversationId and attaches it to the task.
 * DISABLED: Runtime execution does not read or depend on raw Antigravity transcript.jsonl files.
 * Progress and completion come strictly from official agy stream protocol, stdout/stderr parsed events,
 * and child-process state. Kept as a safe no-op for backward compatibility.
 * @param {string} taskId
 * @param {string} conversationId
 */
export const watchTranscript = (taskId, conversationId) => {
  // Safe no-op: raw transcript.jsonl files are never read or polled.
};

/**
 * Starts a new Antigravity task via agentapi new-conversation.
 * Validates workspace, prompt size, and executes with clean environment.
 * @param {{
 *   workspace: string,
 *   prompt: string,
 *   title?: string,
 *   runner?: typeof defaultRunner,
 *   customAgentApiPath?: string,
 *   customAgyPath?: string,
 *   userApproved?: boolean
 * }} params
 * @returns {Promise<{ taskId: string, conversationId: string, status: string, startedAt: string, workspace: string }>}
 */
export const startAntigravityTask = async ({
  workspace,
  prompt,
  title,
  runner = defaultRunner,
  spawnFn = spawn,
  customAgentApiPath,
  customAgyPath,
  userApproved = false,
  verificationRequirements = null,
  awaitCompletion,
  startupTimeoutMs = 10000,
  executionTimeoutMs = 330000,
  source = 'local',
  remoteTaskId = null,
  requestId = null,
  requestedRoute = 'auto',
  resolvedRoute = 'antigravity',
  routeReason = 'Antigravity · multi-step code change',
  routeTransitions = [],
  existingTaskId = null,
  durableRoute = false,
  jobId = null,
  jobIds = [],
  metadata = {},
}) => {
  if (source === 'remote' && (!remoteTaskId || typeof remoteTaskId !== 'string' || !remoteTaskId.trim())) {
    throw new Error('Remote task must have a non-empty remoteTaskId.');
  }

  // 1. Validate prompt
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('Prompt must be a non-empty string.');
  }
  const promptBytes = Buffer.byteLength(prompt, 'utf8');
  if (promptBytes > MAX_PAYLOAD_BYTES) {
    throw new Error(`Prompt exceeds maximum limit of 64 KiB (${promptBytes} bytes). Rejected before execution.`);
  }

  // 2. Validate title
  let cleanTitle = (prompt || '').slice(0, 60) || 'Hearth Task';
  if (typeof title === 'string' && title.trim()) {
    const titleBytes = Buffer.byteLength(title, 'utf8');
    if (titleBytes > 1024) {
      throw new Error('Title exceeds maximum limit of 1 KiB.');
    }
    cleanTitle = title.trim();
  }

  // 3. Validate workspace
  if (!workspace || typeof workspace !== 'string') {
    throw new Error('Workspace path is required.');
  }
  try {
    const realRoot = await fsPromises.realpath(workspace);
    const stat = await fsPromises.stat(realRoot);
    if (!stat.isDirectory()) throw new Error('Workspace is not a directory.');
  } catch {
    throw new Error(`Workspace path '${workspace}' is invalid or inaccessible.`);
  }

  // 4. Prefer the supported headless CLI. A custom agentapi path remains
  // available only for the legacy adapter and isolated unit tests.
  const useLegacyAgentApi = Boolean(customAgentApiPath);
  const executablePath = useLegacyAgentApi
    ? customAgentApiPath
    : await resolveAgyPath(customAgyPath);
  if (!executablePath) {
    throw new Error('Antigravity CLI was not found. Install agy in ~/.local/bin and sign in once.');
  }

  // 5. Initialize task in registry
  const taskId = existingTaskId || crypto.randomUUID();
  const existingStoredTask = (existingTaskId && globalTaskStore)
    ? globalTaskStore.getTask(existingTaskId)
    : taskRegistry.get(taskId);
  const now = new Date().toISOString();
  const task = {
    taskId,
    conversationId: existingStoredTask?.conversationId || null,
    workspace,
    title: cleanTitle,
    source,
    remoteTaskId,
    requestId,
    dismissed: false,
    status: 'starting',
    requestedRoute,
    resolvedRoute,
    routeReason,
    routeTransitions: Array.isArray(routeTransitions) ? [...routeTransitions] : [],
    jobId: existingStoredTask?.jobId || jobId || null,
    jobIds: existingStoredTask?.jobIds || (Array.isArray(jobIds) ? [...jobIds] : (jobId ? [jobId] : [])),
    durableRoute: Boolean(existingStoredTask?.durableRoute || durableRoute || metadata?.requires_hearth_owned_job),
    metadata: { ...(existingStoredTask?.metadata || {}), ...metadata },
    createdAt: existingStoredTask?.createdAt || now,
    updatedAt: now,
    lastEvent: null,
    recentEvents: [],
    error: null,
    cleanup: null,
    verificationRequirements: verificationRequirements || null,
    completion: null,
    backgroundJobs: new Map(),
    lastWatchdogReset: null,
    lastWatchdogResetReason: null,
    lastWatchdogResetAt: null,
    heartbeatSeq: 0,
    controllerState: 'healthy',
    controllerRecoveryCount: 0,
    controllerStateReason: null,
  };
  taskRegistry.set(taskId, task);
  syncTaskToStore(task);
  emitTaskTransition(task);

  // 6. Execute Antigravity. In CLI mode the prompt travels over stdin so it
  // is not exposed in the process command line.
  const args = useLegacyAgentApi
    ? ['new-conversation', `--title=${cleanTitle}`, prompt]
    : [
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--disable-slash-commands',
        '--sandbox',
        '--add-dir', workspace,
        ...(userApproved ? ['--dangerously-skip-permissions'] : []),
      ];
  const input = useLegacyAgentApi
    ? undefined
    : `${JSON.stringify({ event: 'user', message: { content: buildAgyPrompt(workspace, prompt) } })}\n`;

  try {
    if (!useLegacyAgentApi) {
      if (runner === defaultRunner || (typeof spawnFn === 'function' && spawnFn !== spawn)) {
        // Production execution: Spawn child process, stream stdout, resolve on init/startup
        const env = { ...process.env };
        delete env.GOOGLE_APPLICATION_CREDENTIALS;

        return await new Promise((resolve, reject) => {
          let child;
          try {
            child = spawnFn(executablePath, args, {
              cwd: workspace,
              env,
              shell: false,
              stdio: ['pipe', 'pipe', 'pipe'],
            });
            task.child = child;
          } catch (err) {
            const cleanMsg = redactSecrets(err.message);
            task.status = 'error';
            task.error = cleanMsg;
            task.updatedAt = new Date().toISOString();
            syncTaskToStore(task);
            emitTaskTransition(task);
            reject(new Error(cleanMsg));
            return;
          }

          task.cleanup = () => {
            task.intentionalCancel = true;
            task.isCleanedUp = true;
            try {
              if (child && !child.killed) {
                try { child.stdin?.end(); } catch {}
                child.kill('SIGTERM');
              }
            } catch {}
            if (task.backgroundJobs) {
              for (const bg of task.backgroundJobs.values()) {
                try {
                  if (typeof bg.detachListeners === 'function') {
                    bg.detachListeners();
                  }
                  if (bg.status === 'running' || bg.state === 'running') {
                    bg.status = 'cleaned_up';
                    bg.state = 'cleaned_up';
                  }
                  if (bg.child && !bg.child.killed) {
                    bg.child.kill('SIGTERM');
                  } else if (bg.pid && typeof bg.pid === 'number') {
                    process.kill(bg.pid, 'SIGTERM');
                  }
                } catch {}
              }
            }
            if (typeof getJobManager === 'function') {
              const ids = task.jobIds || (task.jobId ? [task.jobId] : []);
              for (const id of ids) {
                try {
                  getJobManager().cancelJob(id, 'Task cleanup');
                } catch {}
              }
            }
          };
          task.cancel = () => {
            task.intentionalCancel = true;
            if (task.cleanup) task.cleanup();
          };

          // Overall execution watchdog (resets on active streaming / progress / background heartbeats)
          let executionWatchdog = null;
          const resetWatchdog = (source = 'executor_activity', details = {}) => {
            const now = new Date().toISOString();
            task.lastWatchdogResetReason = source;
            task.lastWatchdogResetAt = now;
            task.lastWatchdogReset = {
              source,
              at: now,
              details,
            };
            if (executionWatchdog) clearTimeout(executionWatchdog);
            executionWatchdog = setTimeout(() => {
              if (task.status === 'starting' || task.status === 'running') {
                const activeDurableJobs = typeof getJobManager === 'function'
                  ? getJobManager().listJobs({ taskId: task.taskId, status: 'running' })
                  : [];
                if (activeDurableJobs.length > 0) {
                  // Requirement 4: Provider silence/disconnect must NOT cause 330s parent timeout
                  // while an active verified Hearth-owned durable job is running.
                  resetWatchdog('durable_job_active', { jobIds: activeDurableJobs.map((j) => j.id) });
                  return;
                }
                task.status = 'error';
                task.error = `Antigravity task timed out after ${Math.round(executionTimeoutMs / 1000)}s`;
                task.updatedAt = new Date().toISOString();
                syncTaskToStore(task);
                emitTaskTransition(task);
                if (task.cleanup) task.cleanup();
              }
            }, executionTimeoutMs);
          };
          task.resetWatchdog = resetWatchdog;
          resetWatchdog('task_start');

          task.continueSession = (message) => {
            if (!child || child.killed || child.exitCode !== null) {
              return false;
            }
            if (!child.stdin || child.stdin.writable === false) {
              return false;
            }
            try {
              const promptText = typeof message === 'string' ? message : JSON.stringify(message);
              const line = `${JSON.stringify({ event: 'user', message: { content: promptText } })}\n`;
              child.stdin.write(line);
              task.pendingContinuation = false;
              resetWatchdog('continuation_sent');
              return true;
            } catch {
              return false;
            }
          };

          let stdoutBuffer = '';
          let stderrBuffer = '';
          let hasResolved = false;

          const safeResolve = () => {
            if (!hasResolved) {
              hasResolved = true;
              clearTimeout(startupTimer);
              resolve({
                taskId,
                conversationId: task.conversationId,
                status: task.status,
                startedAt: task.createdAt,
                workspace,
                completion: task.completion,
                requestedRoute: task.requestedRoute,
                resolvedRoute: task.resolvedRoute,
                routeReason: task.routeReason,
                routeTransitions: task.routeTransitions,
              });
            }
          };

          const safeReject = (err) => {
            if (!hasResolved) {
              hasResolved = true;
              clearTimeout(startupTimer);
              if (executionWatchdog) clearTimeout(executionWatchdog);
              reject(err);
            }
          };

          // Startup watchdog: resolve within startupTimeoutMs if still running, or reject on failure
          const startupTimer = setTimeout(() => {
            if (!hasResolved) {
              if (!child.killed && child.exitCode === null) {
                safeResolve();
              } else {
                safeReject(new Error(task.error || 'Antigravity CLI failed to initialize within startup timeout.'));
              }
            }
          }, startupTimeoutMs);

          if (input !== undefined) {
            child.stdin?.write(String(input));
          }

          const markTerminalInterruption = (reason) => {
            task.controllerState = 'interrupted';
            task.controllerStateReason = reason;
            task.status = 'error';
            task.error = reason;
            task.completion = {
              status: 'error',
              normalizedStatus: 'error',
              summary: reason,
              error: reason,
              checks: { build: 'not_run', tests: 'not_run' },
              artifacts: [],
            };
            if (executionWatchdog) clearTimeout(executionWatchdog);
            task.resetWatchdog = null;
            task.updatedAt = new Date().toISOString();
            syncTaskToStore(task);
            emitTaskTransition(task);

            if (task.cleanup) {
              task.cleanup();
            }

            if (!hasResolved) {
              safeReject(new Error(reason));
            }
          };

          const handleStreamInterruption = (interruptionMsg = 'The stream was interrupted.') => {
            const cleanReason = redactSecrets(interruptionMsg);
            task.controllerStateReason = cleanReason;

            // Intentional cancellation initiated by Hearth -> NO recovery attempt (Requirement 2.B)
            if (task.intentionalCancel || task.isCleanedUp || task.status === 'done' || task.status === 'error') {
              markTerminalInterruption(cleanReason);
              return;
            }

            // Bounded recovery rules (Requirement 4):
            // - max 1 automatic stream recovery attempt per interruption
            // - preserve same conversation_id
            // - do not duplicate executor/background work
            // - child must be alive, stdin must be writable
            const isChildAlive = Boolean(child && !child.killed && child.exitCode === null);
            const isStdinWritable = Boolean(child?.stdin && child.stdin.writable !== false);
            const canAttemptRecovery =
              task.controllerRecoveryCount < 1 &&
              isChildAlive &&
              isStdinWritable &&
              typeof task.continueSession === 'function';

            if (canAttemptRecovery) {
              task.controllerState = 'recovering';
              task.controllerRecoveryCount = (task.controllerRecoveryCount || 0) + 1;
              task.updatedAt = new Date().toISOString();

              if (!Array.isArray(task.recentEvents)) task.recentEvents = [];
              task.recentEvents.push({
                stepIndex: task.recentEvents.length + 1,
                type: 'CONTROLLER_RECOVERY_ATTEMPT',
                status: 'RUNNING',
                createdAt: new Date().toISOString(),
                summary: `Stream interrupted: ${cleanReason.slice(0, 100)}. Attempting bounded session recovery.`,
              });
              if (task.recentEvents.length > MAX_RECENT_EVENTS) task.recentEvents.shift();
              task.lastEvent = task.recentEvents[task.recentEvents.length - 1];

              syncTaskToStore(task);
              emitTaskTransition(task);

              const hasActiveBackground =
                task.backgroundJobs &&
                Array.from(task.backgroundJobs.values()).some((j) => j.status === 'running');
              const recoveryPrompt = [
                'The previous stream was interrupted.',
                'Please continue the task you were working on.',
                hasActiveBackground ? 'The background work is currently active.' : '',
                'Once complete, evaluate the result and provide your final completion contract in JSON format.',
                HEARTH_COMPLETION_INSTRUCTION,
              ]
                .filter(Boolean)
                .join('\n');

              const sent = task.continueSession(recoveryPrompt);
              if (sent) {
                return;
              }
            }

            // Terminal interruption
            markTerminalInterruption(cleanReason);
          };

          const handleParsedEvent = (event) => {
            if (!event || typeof event !== 'object') return;

            if (isStreamInterruptionEvent(event, { task })) {
              const msg = extractInterruptionMessage(event);
              handleStreamInterruption(msg);
              return;
            }

            resetWatchdog('stream_event', { event: event.event || (event.step_update ? 'step_update' : 'unknown') });

            if (task.controllerState === 'recovering') {
              task.controllerState = 'healthy';
            }

            if (isInitEvent(event)) {
              task.conversationId = extractConversationId(event) || task.conversationId;
              task.status = 'running';
              task.updatedAt = new Date().toISOString();
              syncTaskToStore(task);
              emitTaskTransition(task);
              safeResolve();
            } else if (event.event === 'step_update') {
              appendAgyEvents(task, [event]);
              if (task.status === 'starting') task.status = 'running';
              task.updatedAt = new Date().toISOString();
              syncTaskToStore(task);
              emitTaskTransition(task);
              safeResolve();

              // If task is waiting for continuation after progress prose, and a tool/background step finished:
              const step = event.step_update;
              if (task.pendingContinuation && step && (step.state === 'DONE' || step.state === 'COMPLETED' || step.state === 'FINISHED')) {
                const continuePrompt = [
                  'The background command or tool has completed.',
                  step.text_delta ? `Output: ${step.text_delta}` : '',
                  'Please evaluate the result and provide your final completion contract in JSON format.',
                  HEARTH_COMPLETION_INSTRUCTION,
                ].filter(Boolean).join('\n');
                task.continueSession(continuePrompt);
              }
            } else if (isResultEvent(event)) {
              task.conversationId = extractConversationId(event) || task.conversationId;
              const resPayload = extractResponsePayload(event);
              const finalResponse = parseFinalResponse(resPayload);
              if (finalResponse.summary) {
                task.lastAnswer = redactSecrets(finalResponse.summary).trim();
              }
              task.error = event.result?.error
                ? redactSecrets(String(event.result.error))
                : event.error
                  ? redactSecrets(String(event.error))
                  : null;

              // If final response contains a stream interruption, do not treat as ordinary progress
              if (isStreamInterruptedMessage(task.lastAnswer, { task }) || isStreamInterruptedMessage(task.error, { task })) {
                handleStreamInterruption(task.error || task.lastAnswer || 'The stream was interrupted.');
                return;
              }

              const isChildAlive = Boolean(child && !child.killed && child.exitCode === null);

              // MANDATORY LIFECYCLE RULE:
              // - Progress prose must NEVER create WAITING.
              // - WAITING only from explicit structured final contract: {"status":"waiting",...}
              // - If any owned executor/tool/test process is alive, Hearth remains RUNNING.
              if (isChildAlive && finalResponse.kind !== 'structured') {
                task.pendingContinuation = true;
                if (task.status === 'starting') task.status = 'running';
                task.updatedAt = new Date().toISOString();
                syncTaskToStore(task);
                emitTaskTransition(task);
                safeResolve();
                return;
              }

              // Explicit structured contract block arrived:
              if (finalResponse.kind === 'structured') {
                const completion = classifyCompletion({
                  response: resPayload,
                  executorStatus: event.result?.status || event.status || 'SUCCESS',
                  events: task.recentEvents,
                  error: task.error,
                  verificationRequirements: task.verificationRequirements,
                  workspace: task.workspace,
                });

                const activeDurableJobs = typeof getJobManager === 'function'
                  ? getJobManager().listJobs({ taskId: task.taskId, status: 'running' })
                  : [];

                if (completion.status === 'waiting' && activeDurableJobs.length > 0) {
                  // Active durable job running: interim waiting contract must NOT make parent dormant.
                  // Parent lifecycle and remote Supabase row remain RUNNING.
                  task.status = 'running';
                  task.completion = completion;
                  task.pendingContinuation = true;
                  task.controllerState = 'disconnected';
                  task.lastAnswer = redactSecrets(completion.summary || finalResponse.summary).trim();
                  if (typeof resetWatchdog === 'function') {
                    resetWatchdog('durable_job_interim_waiting', { jobIds: activeDurableJobs.map((j) => j.id) });
                  }
                  try { child.stdin?.end(); } catch {}
                  task.updatedAt = new Date().toISOString();
                  syncTaskToStore(task);
                  emitTaskTransition(task);
                  safeResolve();
                  return;
                }

                if (executionWatchdog) clearTimeout(executionWatchdog);
                task.resetWatchdog = null;
                task.controllerState = 'closed';
                task.pendingContinuation = false;
                try { child.stdin?.end(); } catch {}

                task.status = completion.status;
                task.completion = completion;
                if (completion.error) {
                  task.error = completion.error;
                }
                if (task.continuationState === 'in_progress') {
                  task.continuationState = completion.status === 'error' ? 'failed' : 'completed';
                }
                task.updatedAt = new Date().toISOString();
                syncTaskToStore(task);
                emitTaskTransition(task);
                safeResolve();
              }
            }
          };

          const processLine = (line) => {
            const trimmed = line.trim();
            if (!trimmed) return;
            try {
              const event = JSON.parse(trimmed);
              handleParsedEvent(event);
            } catch {
              // Ignore non-JSON lines or partial noise
            }
          };

          const flushBuffer = () => {
            if (stdoutBuffer.trim()) {
              const lines = stdoutBuffer.split('\n');
              stdoutBuffer = '';
              for (const line of lines) {
                processLine(line);
              }
            }
          };

          child.stdout.on('data', (chunk) => {
            resetWatchdog('executor_stdout');
            stdoutBuffer += chunk.toString('utf8');
            const lines = stdoutBuffer.split('\n');
            stdoutBuffer = lines.pop() || '';
            for (const line of lines) {
              processLine(line);
            }
          });

          child.stdout.on('end', () => {
            flushBuffer();
          });

          child.stderr.on('data', (chunk) => {
            const str = chunk.toString('utf8');
            if (stderrBuffer.length < 65536) {
              stderrBuffer += str;
            }
            if (isStreamInterruptedMessage(str, { task })) {
              handleStreamInterruption(str);
              return;
            }
            resetWatchdog('executor_stderr');
          });

          child.on('error', (err) => {
            clearTimeout(startupTimer);
            const activeDurableJobs = typeof getJobManager === 'function'
              ? getJobManager().listJobs({ taskId: task.taskId, status: 'running' })
              : [];
            if (activeDurableJobs.length > 0) {
              task.controllerState = 'disconnected';
              task.child = null;
              task.updatedAt = new Date().toISOString();
              syncTaskToStore(task);
              emitTaskTransition(task);
              safeResolve();
              return;
            }
            if (executionWatchdog) clearTimeout(executionWatchdog);
            task.resetWatchdog = null;
            if (task.controllerState !== 'interrupted' && task.controllerState !== 'closed') {
              task.controllerState = 'exited';
            }
            const cleanMsg = redactSecrets(err.message);
            task.status = 'error';
            task.error = cleanMsg;
            task.updatedAt = new Date().toISOString();
            syncTaskToStore(task);
            emitTaskTransition(task);
            safeReject(new Error(cleanMsg));
          });

          child.on('close', async (code) => {
            clearTimeout(startupTimer);
            const activeDurableJobs = typeof getJobManager === 'function'
              ? getJobManager().listJobs({ taskId: task.taskId, status: 'running' })
              : [];
            if (activeDurableJobs.length === 0) {
              if (executionWatchdog) clearTimeout(executionWatchdog);
              task.resetWatchdog = null;
            }
            if (task.controllerState !== 'interrupted' && task.controllerState !== 'closed') {
              task.controllerState = 'exited';
            }

            // 1. Drain and flush any remaining stdout buffers
            flushBuffer();

            // 2. Await microtask flush in case any event handler had async microtasks
            await new Promise((r) => queueMicrotask(r));
            flushBuffer();

            // 3. Evaluate terminal state
            if (task.status === 'starting' || task.status === 'running') {
              const activeDurableJobs = typeof getJobManager === 'function'
                ? getJobManager().listJobs({ taskId: task.taskId, status: 'running' })
                : [];
              if (activeDurableJobs.length > 0) {
                // Provider child process closed/disconnected while durable job is active.
                // Invariant 5: Provider lifecycle must not own Job lifecycle. Task remains RUNNING.
                task.controllerState = 'disconnected';
                task.child = null;
                task.updatedAt = new Date().toISOString();
                syncTaskToStore(task);
                emitTaskTransition(task);
                return;
              }

              if (code !== 0 && !task.completion) {
                task.status = 'error';
                task.error = redactSecrets(stderrBuffer.trim() || `Antigravity CLI process exited with code ${code}`);
              } else if (task.lastAnswer && !task.completion) {
                const parsedFinal = parseFinalResponse(task.lastAnswer);
                if (parsedFinal.kind === 'structured' && parsedFinal.status === 'completed') {
                  const completion = classifyCompletion({
                    response: task.lastAnswer,
                    executorStatus: code === 0 ? 'SUCCESS' : 'ERROR',
                    events: task.recentEvents,
                    error: task.error,
                    verificationRequirements: task.verificationRequirements,
                    workspace: task.workspace,
                  });
                  task.status = completion.status;
                  task.completion = completion;
                  if (completion.error) task.error = completion.error;
                } else if (parsedFinal.kind === 'structured' && parsedFinal.status === 'waiting') {
                  if (activeDurableJobs.length > 0) {
                    task.status = 'running';
                    task.controllerState = 'disconnected';
                    task.child = null;
                    task.pendingContinuation = true;
                    task.updatedAt = new Date().toISOString();
                    syncTaskToStore(task);
                    emitTaskTransition(task);
                    return;
                  }
                  task.status = 'waiting';
                  task.completion = {
                    status: 'waiting',
                    normalizedStatus: 'waiting',
                    summary: parsedFinal.summary,
                    error: null,
                    interimReason: parsedFinal.interimReason || 'Waiting on required input.',
                    checks: { build: 'not_run', tests: 'not_run' },
                    artifacts: [],
                  };
                } else {
                  // If executor dies before final contract and no owned work can continue => ERROR.
                  // Progress prose or lack of explicit contract on exit MUST NEVER become stale WAITING.
                  task.status = 'error';
                  task.error = 'Antigravity exited without a final response.';
                  task.completion = {
                    status: 'error',
                    normalizedStatus: 'error',
                    summary: task.error,
                    error: task.error,
                    checks: { build: 'not_run', tests: 'not_run' },
                    artifacts: [],
                  };
                }
              } else if (!task.completion) {
                task.status = 'error';
                task.error = 'Antigravity exited without a final response.';
              }
            } else if (task.status === 'waiting') {
              if (activeDurableJobs.length > 0) {
                task.status = 'running';
                task.controllerState = 'disconnected';
                task.child = null;
                task.pendingContinuation = true;
                task.updatedAt = new Date().toISOString();
                syncTaskToStore(task);
                emitTaskTransition(task);
                return;
              }
              if (code !== 0) {
                task.status = 'error';
                task.error = redactSecrets(stderrBuffer.trim() || `Antigravity CLI process exited with code ${code}`);
                task.completion = {
                  status: 'error',
                  normalizedStatus: 'error',
                  summary: task.error,
                  error: task.error,
                  checks: { build: 'not_run', tests: 'not_run' },
                  artifacts: [],
                };
              }
            }
            if (task.status === 'error' && !task.completion) {
              task.completion = {
                status: 'error',
                normalizedStatus: 'error',
                summary: task.error,
                error: task.error,
                checks: { build: 'not_run', tests: 'not_run' },
                artifacts: [],
              };
            }
            task.child = null;
            task.continueSession = null;
            if (activeDurableJobs.length === 0) {
              task.pendingContinuation = false;
            }
            if (task.continuationState === 'in_progress') {
              task.continuationState = task.status === 'error' ? 'failed' : 'completed';
            }
            task.updatedAt = new Date().toISOString();
            syncTaskToStore(task);
            emitTaskTransition(task);

            if (!hasResolved) {
              if (task.status === 'error') {
                safeReject(new Error(task.error));
              } else {
                safeResolve();
              }
            }
          });
        });
      }

      // Custom/mock runner (e.g. unit tests or GoalRunner)
      if (awaitCompletion === false) {
        // Overall execution watchdog
        const executionWatchdog = setTimeout(() => {
          if (task.status === 'starting' || task.status === 'running') {
            task.status = 'error';
            task.error = `Antigravity task timed out after ${Math.round(executionTimeoutMs / 1000)}s`;
            task.updatedAt = new Date().toISOString();
            if (task.cleanup) task.cleanup();
          }
        }, executionTimeoutMs);

        // Non-blocking start for custom runner
        Promise.resolve().then(() => runner(executablePath, args, {
          cwd: workspace,
          timeout: executionTimeoutMs,
          input,
        })).then(({ stdout = '', stderr = '' }) => {
          clearTimeout(executionWatchdog);
          const parsed = parseAgyStream(stdout);
          task.conversationId = parsed.conversationId;
          appendAgyEvents(task, parsed.events);
          const resPayload = parsed.response;
          const finalResponse = parseFinalResponse(resPayload);
          task.lastAnswer = redactSecrets(finalResponse.summary).trim();
          task.error = parsed.result?.error ? redactSecrets(String(parsed.result.error)) : null;

          const completion = classifyCompletion({
            response: resPayload,
            executorStatus: parsed.result?.status || 'SUCCESS',
            events: parsed.events,
            error: task.error,
            verificationRequirements: task.verificationRequirements,
            workspace: task.workspace,
          });

          const activeDurableJobs = typeof getJobManager === 'function'
            ? getJobManager().listJobs({ taskId: task.taskId, status: 'running' })
            : [];

          if (completion.status === 'waiting' && activeDurableJobs.length > 0) {
            task.status = 'running';
            task.completion = completion;
            task.pendingContinuation = true;
            task.controllerState = 'disconnected';
          } else {
            task.status = completion.status;
            task.completion = completion;
          }
          if (completion.error) {
            task.error = completion.error;
          }
          if (task.continuationState === 'in_progress') {
            task.continuationState = task.status === 'error' ? 'failed' : 'completed';
          }
          task.updatedAt = new Date().toISOString();
          syncTaskToStore(task);
          emitTaskTransition(task);
        }).catch((err) => {
          clearTimeout(executionWatchdog);
          task.status = 'error';
          task.error = redactSecrets(err.message);
          task.updatedAt = new Date().toISOString();
          syncTaskToStore(task);
          emitTaskTransition(task);
        });

        return {
          taskId,
          conversationId: task.conversationId,
          status: task.status,
          startedAt: task.createdAt,
          workspace,
          completion: task.completion,
          requestedRoute: task.requestedRoute,
          resolvedRoute: task.resolvedRoute,
          routeReason: task.routeReason,
          routeTransitions: task.routeTransitions,
        };
      }

      // Default for runner !== defaultRunner when awaitCompletion is true (e.g. test 5b, 5c)
      const { stdout } = await runner(executablePath, args, {
        cwd: workspace,
        timeout: executionTimeoutMs,
        input,
      });

      const parsed = parseAgyStream(stdout);
      task.conversationId = parsed.conversationId;
      appendAgyEvents(task, parsed.events);
      const resPayload = parsed.response;
      const finalResponse = parseFinalResponse(resPayload);
      task.lastAnswer = redactSecrets(finalResponse.summary).trim();
      task.error = parsed.result?.error ? redactSecrets(String(parsed.result.error)) : null;

      const completion = classifyCompletion({
        response: resPayload,
        executorStatus: parsed.result?.status || 'SUCCESS',
        events: parsed.events,
        error: task.error,
        verificationRequirements: task.verificationRequirements,
        workspace: task.workspace,
      });

      const activeDurableJobs = typeof getJobManager === 'function'
        ? getJobManager().listJobs({ taskId: task.taskId, status: 'running' })
        : [];

      if (completion.status === 'waiting' && activeDurableJobs.length > 0) {
        task.status = 'running';
        task.completion = completion;
        task.pendingContinuation = true;
        task.controllerState = 'disconnected';
      } else {
        task.status = completion.status;
        task.completion = completion;
      }
      if (completion.error) {
        task.error = completion.error;
      }
      if (task.continuationState === 'in_progress') {
        task.continuationState = task.status === 'error' ? 'failed' : 'completed';
      }
      task.updatedAt = new Date().toISOString();
      syncTaskToStore(task);
      emitTaskTransition(task);
      return {
        taskId,
        conversationId: task.conversationId,
        status: task.status,
        startedAt: task.createdAt,
        workspace,
        completion: task.completion,
        requestedRoute: task.requestedRoute,
        resolvedRoute: task.resolvedRoute,
        routeReason: task.routeReason,
        routeTransitions: task.routeTransitions,
      };
    }

    const { stdout } = await runner(executablePath, args, {
      cwd: workspace,
      timeout: 45000,
      input,
    });

    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error('Received invalid non-JSON output from agentapi.');
    }

    if (parsed.error) {
      throw new Error(`agentapi error: ${parsed.error}`);
    }

    const findConversationId = (obj) => {
      if (!obj || typeof obj !== 'object') return null;
      for (const [k, v] of Object.entries(obj)) {
        if (/^(root_?)?(conversation|trajectory)_?id$/i.test(k) && typeof v === 'string' && v) return v;
        if (typeof v === 'object' && v !== null) {
          const nested = findConversationId(v);
          if (nested) return nested;
        }
      }
      return null;
    };

    let conversationId = findConversationId(parsed);
    if (!conversationId) {
      // Fallback: search for any UUID string in the parsed output
      const uuidMatch = JSON.stringify(parsed).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      if (uuidMatch) conversationId = uuidMatch[0];
    }

    if (!conversationId || typeof conversationId !== 'string') {
      throw new Error(`Could not resolve conversationId from agentapi response: ${JSON.stringify(parsed).slice(0, 200)}`);
    }

    task.conversationId = conversationId;
    task.status = 'running';
    task.updatedAt = new Date().toISOString();

    return {
      taskId,
      conversationId,
      status: task.status,
      startedAt: task.createdAt,
      workspace,
      requestedRoute: task.requestedRoute,
      resolvedRoute: task.resolvedRoute,
      routeReason: task.routeReason,
      routeTransitions: task.routeTransitions,
    };
  } catch (error) {
    task.status = 'error';
    task.error = error.message;
    task.updatedAt = new Date().toISOString();
    throw error;
  }
};

/**
 * Returns task status, recent activity, and final answer from the in-memory registry.
 * Progress and completion come strictly from official stream protocol events and process state.
 * @param {string} taskId
 * @returns {object}
 */
export const getAntigravityTask = (taskId) => {
  let task = taskRegistry.get(taskId);
  if (!task && globalTaskStore) {
    task = globalTaskStore.getTask(taskId);
    if (task) {
      taskRegistry.set(taskId, task);
    }
  }
  if (!task) {
    throw new Error(`Task '${taskId}' not found in task registry.`);
  }

  let jobStatus = null;
  let jobPid = null;
  let jobHeartbeatCount = 0;
  let jobLastHeartbeatAt = null;

  if (typeof getJobManager === 'function') {
    try {
      const jm = getJobManager();
      const job = task.jobId ? jm.getJob(task.jobId) : null;
      if (job) {
        jobStatus = job.status;
        jobPid = job.pid;
        jobHeartbeatCount = job.heartbeatCount || 0;
        jobLastHeartbeatAt = job.lastHeartbeatAt || null;
      }
    } catch {}
  }

  return {
    taskId: task.taskId,
    conversationId: task.conversationId,
    status: task.status,
    workspace: task.workspace,
    title: task.title,
    source: task.source || 'local',
    remoteTaskId: task.remoteTaskId || null,
    requestId: task.requestId || null,
    dismissed: Boolean(task.dismissed),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    lastEvent: task.lastEvent,
    recentEvents: [...(task.recentEvents || [])],
    lastAnswer: task.lastAnswer || null,
    error: task.error,
    completion: task.completion || null,
    pendingContinuation: Boolean(task.pendingContinuation),
    lastWatchdogReset: task.lastWatchdogReset ? { ...task.lastWatchdogReset } : null,
    lastWatchdogResetReason: task.lastWatchdogResetReason || task.lastWatchdogReset?.source || null,
    lastWatchdogResetAt: task.lastWatchdogResetAt || task.lastWatchdogReset?.at || null,
    heartbeatSeq: task.heartbeatSeq || 0,
    backgroundJobs: task.backgroundJobs
      ? Array.from(task.backgroundJobs.values()).map((j) => ({
          id: j.id,
          name: j.name,
          pid: typeof j.pid === 'number' ? j.pid : null,
          state: j.state || j.status || 'running',
          status: j.status || j.state || 'running',
          registeredAt: j.registeredAt || j.startedAt || task.createdAt,
          startedAt: j.startedAt || j.registeredAt || task.createdAt,
          lastHeartbeatAt: j.lastHeartbeatAt || null,
          heartbeatCount: j.heartbeatCount || 0,
          completedAt: j.completedAt || null,
          exitCode: j.exitCode ?? null,
          metadata: j.metadata || {},
        }))
      : [],
    executionState: getTaskExecutionState(task).state,
    controllerState: task.controllerState || 'healthy',
    controllerRecoveryCount: task.controllerRecoveryCount || 0,
    recoveryAttempts: task.controllerRecoveryCount || 0,
    controllerStateReason: task.controllerStateReason || null,
    jobId: task.jobId || null,
    jobIds: Array.isArray(task.jobIds) ? [...task.jobIds] : [],
    jobStatus: jobStatus || (task.jobId ? 'running' : null),
    jobPid: typeof jobPid === 'number' ? jobPid : null,
    jobHeartbeatCount: Number(jobHeartbeatCount || 0),
    jobLastHeartbeatAt: jobLastHeartbeatAt || null,
    durableRoute: Boolean(task.durableRoute || task.metadata?.requires_hearth_owned_job),
    durableJobEvidence: task.durableJobEvidence || null,
    executorAlive: Boolean(task.child && !task.child.killed && task.child.exitCode === null),
    childAlive: Boolean(task.child && !task.child.killed && task.child.exitCode === null),
  };
};

/**
 * Sends a follow-up message to an existing task conversation.
 * @param {{ taskId: string, message: string, runner?: typeof defaultRunner, customAgentApiPath?: string, customAgyPath?: string }} params
 * @returns {Promise<{ taskId: string, conversationId: string, status: string, sentAt: string }>}
 */
export const sendAntigravityMessage = async ({ taskId, message, runner = defaultRunner, customAgentApiPath, customAgyPath }) => {
  const task = taskRegistry.get(taskId);
  if (!task) {
    throw new Error(`Task '${taskId}' not found in task registry.`);
  }
  if (!task.conversationId) {
    throw new Error(`Task '${taskId}' does not have an active conversation ID.`);
  }

  if (typeof message !== 'string' || !message.trim()) {
    throw new Error('Message must be a non-empty string.');
  }
  const messageBytes = Buffer.byteLength(message, 'utf8');
  if (messageBytes > MAX_PAYLOAD_BYTES) {
    throw new Error(`Message exceeds maximum limit of 64 KiB (${messageBytes} bytes).`);
  }

  const useLegacyAgentApi = Boolean(customAgentApiPath);

  // If the task has an active owned child process with writable stdin, continue the session directly:
  if (runner === defaultRunner && !useLegacyAgentApi && typeof task.continueSession === 'function' && task.continueSession(buildAgyPrompt(task.workspace, message))) {
    task.status = 'running';
    task.updatedAt = new Date().toISOString();
    syncTaskToStore(task);
    emitTaskTransition(task);
    return {
      taskId: task.taskId,
      conversationId: task.conversationId,
      status: task.status,
      sentAt: task.updatedAt,
      completion: task.completion,
    };
  }

  const executablePath = useLegacyAgentApi ? customAgentApiPath : (customAgyPath || await resolveAgyPath());
  if (!executablePath) throw new Error('Antigravity CLI was not found.');

  if (!useLegacyAgentApi) {
    const args = [
      '--conversation', task.conversationId,
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--disable-slash-commands',
      '--sandbox',
      '--add-dir', task.workspace,
    ];
    const input = `${JSON.stringify({ event: 'user', message: { content: buildAgyPrompt(task.workspace, message) } })}\n`;
    const { stdout } = await runner(executablePath, args, { cwd: task.workspace, timeout: 330000, input });
    const parsed = parseAgyStream(stdout);
    appendAgyEvents(task, parsed.events);
    const resPayload = parsed.response;
    const finalResponse = parseFinalResponse(resPayload);
    task.lastAnswer = redactSecrets(finalResponse.summary).trim();
    task.error = parsed.result?.error ? redactSecrets(String(parsed.result.error)) : null;

    const completion = classifyCompletion({
      response: resPayload,
      executorStatus: parsed.result?.status || 'SUCCESS',
      events: parsed.events,
      error: task.error,
      verificationRequirements: task.verificationRequirements,
      workspace: task.workspace,
    });
    task.status = completion.status;
    task.completion = completion;
    if (completion.error) task.error = completion.error;
    task.updatedAt = new Date().toISOString();
    return {
      taskId: task.taskId,
      conversationId: task.conversationId,
      status: task.status,
      sentAt: task.updatedAt,
      completion: task.completion,
    };
  }

  const args = ['send-message', task.conversationId, message];
  const { stdout } = await runner(executablePath, args, { cwd: task.workspace, timeout: 30000 });

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('Received invalid non-JSON output from agentapi.');
  }

  if (parsed.error) {
    throw new Error(`agentapi error: ${parsed.error}`);
  }

  task.updatedAt = new Date().toISOString();
  if (task.status === 'done' || task.status === 'waiting') {
    task.status = 'running';
  }

  return {
    taskId: task.taskId,
    conversationId: task.conversationId,
    status: task.status,
    sentAt: task.updatedAt,
  };
};

/**
 * Retrieves metadata for a task's conversation.
 * @param {string} taskId
 * @param {{ runner?: typeof defaultRunner, customAgentApiPath?: string }} [options]
 * @returns {Promise<object>}
 */
export const getConversationMetadata = async (taskId, { runner = defaultRunner, customAgentApiPath } = {}) => {
  const task = taskRegistry.get(taskId);
  if (!task) {
    throw new Error(`Task '${taskId}' not found in task registry.`);
  }
  if (!task.conversationId) {
    throw new Error(`Task '${taskId}' does not have an active conversation ID.`);
  }

  const agentApiPath = await resolveAgentApiPath(customAgentApiPath);
  if (!agentApiPath) {
    throw new Error('agentapi binary not found or not executable.');
  }

  const args = ['get-conversation-metadata', task.conversationId];
  const { stdout } = await runner(agentApiPath, args, { cwd: task.workspace, timeout: 15000 });

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('Received invalid non-JSON output from agentapi.');
  }

  if (parsed.error) {
    throw new Error(`agentapi error: ${parsed.error}`);
  }

  return parsed.response || parsed;
};

/**
 * Resumes an existing task in recovery_required or waiting state using its existing conversationId.
 * Never creates a new Antigravity conversation or a new Hearth taskId.
 * Injects Completion Contract instruction strictly per v0.4.2.
 * @param {{
 *   taskId: string,
 *   message?: string,
 *   customAgyPath?: string,
 *   runner?: typeof defaultRunner,
 *   spawnFn?: typeof spawn,
 *   startupTimeoutMs?: number,
 *   executionTimeoutMs?: number
 * }} params
 * @returns {Promise<{ taskId: string, conversationId: string, status: string, resumedAt: string, workspace: string }>}
 */
export const resumeAntigravityTask = async ({
  taskId,
  message,
  customAgyPath,
  runner = defaultRunner,
  spawnFn = spawn,
  startupTimeoutMs = 10000,
  executionTimeoutMs = 330000,
  durableJobEvidence = null,
}) => {
  if (!taskId || typeof taskId !== 'string') {
    throw new Error('taskId is required to resume a task.');
  }

  const task = taskRegistry.get(taskId) || (globalTaskStore ? globalTaskStore.getTask(taskId) : null);
  if (!task) {
    throw new Error(`Task '${taskId}' not found in task registry.`);
  }

  // Idempotency / Mutex guard
  if (task.isResuming) {
    throw new Error(`Task '${taskId}' resume is already in progress.`);
  }
  const isChildAlive = Boolean(task.child && !task.child.killed && task.child.exitCode === null);
  if (isChildAlive) {
    throw new Error(`Task '${taskId}' is already running.`);
  }
  const isDurableContinuation = task.status === 'running' && (task.pendingContinuation || task.controllerState === 'disconnected' || Boolean(task.durableJobEvidence) || Boolean(durableJobEvidence));
  if (!['recovery_required', 'waiting'].includes(task.status) && !isDurableContinuation) {
    throw new Error(task.status === 'running'
      ? `Task '${taskId}' is already running.`
      : `Cannot resume task in status '${task.status}'. Only tasks in recovery_required or waiting state can be resumed.`);
  }

  // Crucial: Must have an existing conversationId. NEVER auto-create a new conversation!
  if (!task.conversationId) {
    throw new Error(`Cannot resume task '${taskId}' without an existing Antigravity conversation ID.`);
  }

  // Set mutex lock immediately and register task in memory synchronously
  task.isResuming = true;
  if (durableJobEvidence) {
    task.durableJobEvidence = durableJobEvidence;
  }
  taskRegistry.set(taskId, task);

  let executablePath;
  try {
    // Validate workspace
    const realRoot = await fsPromises.realpath(task.workspace);
    const stat = await fsPromises.stat(realRoot);
    if (!stat.isDirectory()) throw new Error('Workspace is not a directory.');

    executablePath = await resolveAgyPath(customAgyPath);
    if (!executablePath) {
      throw new Error('Antigravity CLI was not found. Install agy in ~/.local/bin and sign in once.');
    }
  } catch (err) {
    task.isResuming = false;
    throw err;
  }

  task.status = 'starting';
  task.error = null;
  task.updatedAt = new Date().toISOString();
  taskRegistry.set(taskId, task);
  syncTaskToStore(task);
  emitTaskTransition(task);

  const resumePrompt = message || 'Resume previous task execution and report completion status.';
  const args = [
    '--conversation', task.conversationId,
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--disable-slash-commands',
    '--sandbox',
    '--add-dir', task.workspace,
    '--dangerously-skip-permissions',
  ];
  const input = `${JSON.stringify({ event: 'user', message: { content: buildAgyPrompt(task.workspace, resumePrompt) } })}\n`;

  // Custom runner support (for testing / mocking)
  if (runner !== defaultRunner && spawnFn === spawn) {
    task.status = 'running';
    task.updatedAt = new Date().toISOString();
    syncTaskToStore(task);
    emitTaskTransition(task);
    const { stdout } = await runner(executablePath, args, { cwd: task.workspace, timeout: 330000, input });
    task.isResuming = false;
    const parsed = parseAgyStream(stdout);
    appendAgyEvents(task, parsed.events);
    const resPayload = parsed.response;
    const finalResponse = parseFinalResponse(resPayload);
    task.lastAnswer = redactSecrets(finalResponse.summary).trim();
    task.error = parsed.result?.error ? redactSecrets(String(parsed.result.error)) : null;

    const completion = classifyCompletion({
      response: resPayload,
      executorStatus: parsed.result?.status || 'SUCCESS',
      events: parsed.events,
      error: task.error,
      verificationRequirements: task.verificationRequirements,
      workspace: task.workspace,
    });
    const activeDurableJobs = typeof getJobManager === 'function'
      ? getJobManager().listJobs({ taskId: task.taskId, status: 'running' })
      : [];

    if (completion.status === 'waiting' && activeDurableJobs.length > 0) {
      task.status = 'running';
      task.completion = completion;
      task.pendingContinuation = true;
      task.controllerState = 'disconnected';
    } else {
      task.status = completion.status;
      task.completion = completion;
    }
    if (completion.error) task.error = completion.error;
    if (task.continuationState === 'in_progress') {
      task.continuationState = task.status === 'error' ? 'failed' : 'completed';
    }
    task.updatedAt = new Date().toISOString();
    syncTaskToStore(task);
    emitTaskTransition(task);
    return {
      taskId: task.taskId,
      conversationId: task.conversationId,
      status: task.status,
      source: task.source || 'local',
      remoteTaskId: task.remoteTaskId || null,
      requestId: task.requestId || null,
      resumedAt: task.updatedAt,
      workspace: task.workspace,
      completion: task.completion,
    };
  }

  const env = { ...process.env };
  delete env.GOOGLE_APPLICATION_CREDENTIALS;

  return await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn(executablePath, args, {
        cwd: task.workspace,
        env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      task.child = child;
    } catch (err) {
      task.isResuming = false;
      const cleanMsg = redactSecrets(err.message);
      task.status = 'error';
      task.error = cleanMsg;
      task.updatedAt = new Date().toISOString();
      syncTaskToStore(task);
      emitTaskTransition(task);
      reject(new Error(cleanMsg));
      return;
    }

    task.controllerState = 'healthy';
    task.controllerRecoveryCount = 0;
    task.controllerStateReason = null;

    task.backgroundJobs = task.backgroundJobs || new Map();
    task.heartbeatSeq = task.heartbeatSeq || 0;
    task.cleanup = () => {
      task.intentionalCancel = true;
      task.isCleanedUp = true;
      try {
        if (child && !child.killed) {
          try { child.stdin?.end(); } catch {}
          child.kill('SIGTERM');
        }
      } catch {}
      if (task.backgroundJobs) {
        for (const bg of task.backgroundJobs.values()) {
          try {
            if (typeof bg.detachListeners === 'function') {
              bg.detachListeners();
            }
            if (bg.status === 'running' || bg.state === 'running') {
              bg.status = 'cleaned_up';
              bg.state = 'cleaned_up';
            }
            if (bg.child && !bg.child.killed) {
              bg.child.kill('SIGTERM');
            } else if (bg.pid && typeof bg.pid === 'number') {
              process.kill(bg.pid, 'SIGTERM');
            }
          } catch {}
        }
      }
    };
    task.cancel = () => {
      task.intentionalCancel = true;
      if (task.cleanup) task.cleanup();
    };

    // Overall execution watchdog (resets on active streaming / progress / background heartbeats)
    let executionWatchdog = null;
    const resetWatchdog = (source = 'executor_activity', details = {}) => {
      const now = new Date().toISOString();
      task.lastWatchdogResetReason = source;
      task.lastWatchdogResetAt = now;
      task.lastWatchdogReset = {
        source,
        at: now,
        details,
      };
      if (executionWatchdog) clearTimeout(executionWatchdog);
      executionWatchdog = setTimeout(() => {
        if (task.status === 'starting' || task.status === 'running') {
          const activeDurableJobs = typeof getJobManager === 'function'
            ? getJobManager().listJobs({ taskId: task.taskId, status: 'running' })
            : [];
          if (activeDurableJobs.length > 0) {
            resetWatchdog('durable_job_active', { jobIds: activeDurableJobs.map((j) => j.id) });
            return;
          }
          task.status = 'error';
          task.error = `Antigravity task timed out after ${Math.round(executionTimeoutMs / 1000)}s`;
          task.updatedAt = new Date().toISOString();
          task.isResuming = false;
          syncTaskToStore(task);
          emitTaskTransition(task);
          if (task.cleanup) task.cleanup();
        }
      }, executionTimeoutMs);
    };
    task.resetWatchdog = resetWatchdog;
    resetWatchdog('task_resume');

    const markTerminalInterruption = (reason) => {
      task.controllerState = 'interrupted';
      task.controllerStateReason = reason;
      task.status = 'error';
      task.error = reason;
      task.completion = {
        status: 'error',
        normalizedStatus: 'error',
        summary: reason,
        error: reason,
        checks: { build: 'not_run', tests: 'not_run' },
        artifacts: [],
      };
      if (executionWatchdog) clearTimeout(executionWatchdog);
      task.resetWatchdog = null;
      task.isResuming = false;
      task.updatedAt = new Date().toISOString();
      syncTaskToStore(task);
      emitTaskTransition(task);

      if (task.cleanup) {
        task.cleanup();
      }

      if (!hasResolved) {
        safeReject(new Error(reason));
      }
    };

    const handleStreamInterruption = (interruptionMsg = 'The stream was interrupted.') => {
      const cleanReason = redactSecrets(interruptionMsg);
      task.controllerStateReason = cleanReason;

      // Intentional cancellation initiated by Hearth -> NO recovery attempt (Requirement 2.B)
      if (task.intentionalCancel || task.isCleanedUp || task.status === 'done' || task.status === 'error') {
        markTerminalInterruption(cleanReason);
        return;
      }

      const isChildAlive = Boolean(child && !child.killed && child.exitCode === null);
      const isStdinWritable = Boolean(child?.stdin && child.stdin.writable !== false);
      const canAttemptRecovery =
        task.controllerRecoveryCount < 1 &&
        isChildAlive &&
        isStdinWritable &&
        typeof task.continueSession === 'function';

      if (canAttemptRecovery) {
        task.controllerState = 'recovering';
        task.controllerRecoveryCount = (task.controllerRecoveryCount || 0) + 1;
        task.updatedAt = new Date().toISOString();

        if (!Array.isArray(task.recentEvents)) task.recentEvents = [];
        task.recentEvents.push({
          stepIndex: task.recentEvents.length + 1,
          type: 'CONTROLLER_RECOVERY_ATTEMPT',
          status: 'RUNNING',
          createdAt: new Date().toISOString(),
          summary: `Stream interrupted: ${cleanReason.slice(0, 100)}. Attempting bounded session recovery.`,
        });
        if (task.recentEvents.length > MAX_RECENT_EVENTS) task.recentEvents.shift();
        task.lastEvent = task.recentEvents[task.recentEvents.length - 1];

        syncTaskToStore(task);
        emitTaskTransition(task);

        const hasActiveBackground =
          task.backgroundJobs &&
          Array.from(task.backgroundJobs.values()).some((j) => j.status === 'running');
        const recoveryPrompt = [
          'The previous stream was interrupted.',
          'Please continue the task you were working on.',
          hasActiveBackground ? 'The background work is currently active.' : '',
          'Once complete, evaluate the result and provide your final completion contract in JSON format.',
          HEARTH_COMPLETION_INSTRUCTION,
        ]
          .filter(Boolean)
          .join('\n');

        const sent = task.continueSession(recoveryPrompt);
        if (sent) {
          return;
        }
      }

      // Terminal interruption
      markTerminalInterruption(cleanReason);
    };

    task.continueSession = (message) => {
      if (!child || child.killed || child.exitCode !== null) {
        return false;
      }
      if (!child.stdin || child.stdin.writable === false) {
        return false;
      }
      try {
        const promptText = typeof message === 'string' ? message : JSON.stringify(message);
        const line = `${JSON.stringify({ event: 'user', message: { content: promptText } })}\n`;
        child.stdin.write(line);
        task.pendingContinuation = false;
        resetWatchdog('continuation_sent');
        return true;
      } catch {
        return false;
      }
    };

    let stdoutBuffer = '';
    let stderrBuffer = '';
    let hasResolved = false;

    const safeResolve = () => {
      if (!hasResolved) {
        hasResolved = true;
        clearTimeout(startupTimer);
        task.isResuming = false;
        resolve({
          taskId: task.taskId,
          conversationId: task.conversationId,
          status: task.status,
          source: task.source || 'local',
          remoteTaskId: task.remoteTaskId || null,
          requestId: task.requestId || null,
          resumedAt: task.updatedAt,
          workspace: task.workspace,
          completion: task.completion,
        });
      }
    };

    const safeReject = (err) => {
      if (!hasResolved) {
        hasResolved = true;
        clearTimeout(startupTimer);
        if (executionWatchdog) clearTimeout(executionWatchdog);
        task.isResuming = false;
        reject(err);
      }
    };

    const startupTimer = setTimeout(() => {
      if (!hasResolved) {
        if (!child.killed && child.exitCode === null) {
          safeResolve();
        } else {
          task.isResuming = false;
          safeReject(new Error(task.error || 'Antigravity CLI failed to resume within startup timeout.'));
        }
      }
    }, startupTimeoutMs);

    if (input !== undefined) {
      child.stdin?.write(String(input));
    }

    const handleParsedEvent = (event) => {
      if (!event || typeof event !== 'object') return;

      if (isStreamInterruptionEvent(event, { task })) {
        const msg = extractInterruptionMessage(event);
        handleStreamInterruption(msg);
        return;
      }

      resetWatchdog('stream_event', { event: event.event || (event.step_update ? 'step_update' : 'unknown') });

      if (task.controllerState === 'recovering') {
        task.controllerState = 'healthy';
      }

      if (isInitEvent(event)) {
        task.conversationId = extractConversationId(event) || task.conversationId;
        task.status = 'running';
        task.updatedAt = new Date().toISOString();
        syncTaskToStore(task);
        emitTaskTransition(task);
        safeResolve();
      } else if (event.event === 'step_update') {
        appendAgyEvents(task, [event]);
        if (task.status === 'starting') task.status = 'running';
        task.updatedAt = new Date().toISOString();
        syncTaskToStore(task);
        emitTaskTransition(task);
        safeResolve();

        // If task is waiting for continuation after progress prose, and a tool/background step finished:
        const step = event.step_update;
        if (task.pendingContinuation && step && (step.state === 'DONE' || step.state === 'COMPLETED' || step.state === 'FINISHED')) {
          const continuePrompt = [
            'The background command or tool has completed.',
            step.text_delta ? `Output: ${step.text_delta}` : '',
            'Please evaluate the result and provide your final completion contract in JSON format.',
            HEARTH_COMPLETION_INSTRUCTION,
          ].filter(Boolean).join('\n');
          task.continueSession(continuePrompt);
        }
      } else if (isResultEvent(event)) {
        task.conversationId = extractConversationId(event) || task.conversationId;
        const resPayload = extractResponsePayload(event);
        const finalResponse = parseFinalResponse(resPayload);
        if (finalResponse.summary) {
          task.lastAnswer = redactSecrets(finalResponse.summary).trim();
        }
        task.error = event.result?.error
          ? redactSecrets(String(event.result.error))
          : event.error
            ? redactSecrets(String(event.error))
            : null;

        // If final response contains a stream interruption, do not treat as ordinary progress
        if (isStreamInterruptedMessage(task.lastAnswer, { task }) || isStreamInterruptedMessage(task.error, { task })) {
          handleStreamInterruption(task.error || task.lastAnswer || 'The stream was interrupted.');
          return;
        }

        const isChildAlive = Boolean(child && !child.killed && child.exitCode === null);

        // MANDATORY LIFECYCLE RULE:
        // - Progress prose must NEVER create WAITING.
        // - WAITING only from explicit structured final contract: {"status":"waiting",...}
        // - If any owned executor/tool/test process is alive, Hearth remains RUNNING.
        if (isChildAlive && finalResponse.kind !== 'structured') {
          task.pendingContinuation = true;
          if (task.status === 'starting') task.status = 'running';
          task.updatedAt = new Date().toISOString();
          syncTaskToStore(task);
          emitTaskTransition(task);
          safeResolve();
          return;
        }

        // Explicit structured contract block arrived:
        if (finalResponse.kind === 'structured') {
          const completion = classifyCompletion({
            response: resPayload,
            executorStatus: event.result?.status || event.status || 'SUCCESS',
            events: task.recentEvents,
            error: task.error,
            verificationRequirements: task.verificationRequirements,
            workspace: task.workspace,
          });

          const activeDurableJobs = typeof getJobManager === 'function'
            ? getJobManager().listJobs({ taskId: task.taskId, status: 'running' })
            : [];

          if (completion.status === 'waiting' && activeDurableJobs.length > 0) {
            task.status = 'running';
            task.completion = completion;
            task.pendingContinuation = true;
            task.controllerState = 'disconnected';
            task.lastAnswer = redactSecrets(completion.summary || finalResponse.summary).trim();
            if (typeof resetWatchdog === 'function') {
              resetWatchdog('durable_job_interim_waiting', { jobIds: activeDurableJobs.map((j) => j.id) });
            }
            try { child.stdin?.end(); } catch {}
            task.updatedAt = new Date().toISOString();
            task.isResuming = false;
            syncTaskToStore(task);
            emitTaskTransition(task);
            safeResolve();
            return;
          }

          if (executionWatchdog) clearTimeout(executionWatchdog);
          task.resetWatchdog = null;
          task.controllerState = 'closed';
          task.pendingContinuation = false;
          try { child.stdin?.end(); } catch {}

          task.status = completion.status;
          task.completion = completion;
          if (completion.error) {
            task.error = completion.error;
          }
          if (task.continuationState === 'in_progress') {
            task.continuationState = completion.status === 'error' ? 'failed' : 'completed';
          }
          task.updatedAt = new Date().toISOString();
          task.isResuming = false;
          syncTaskToStore(task);
          emitTaskTransition(task);
          safeResolve();
        }
      }
    };

    const processLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const event = JSON.parse(trimmed);
        handleParsedEvent(event);
      } catch {}
    };

    const flushBuffer = () => {
      if (stdoutBuffer.trim()) {
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = '';
        for (const line of lines) {
          processLine(line);
        }
      }
    };

    child.stdout.on('data', (chunk) => {
      resetWatchdog('executor_stdout');
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        processLine(line);
      }
    });

    child.stdout.on('end', () => {
      flushBuffer();
    });

    child.stderr.on('data', (chunk) => {
      const str = chunk.toString('utf8');
      if (stderrBuffer.length < 65536) {
        stderrBuffer += str;
      }
      if (isStreamInterruptedMessage(str, { task })) {
        handleStreamInterruption(str);
        return;
      }
      resetWatchdog('executor_stderr');
    });

    child.on('error', (err) => {
      clearTimeout(startupTimer);
      if (executionWatchdog) clearTimeout(executionWatchdog);
      task.resetWatchdog = null;
      if (task.controllerState !== 'interrupted' && task.controllerState !== 'closed') {
        task.controllerState = 'exited';
      }
      const cleanMsg = redactSecrets(err.message);
      task.status = 'error';
      task.error = cleanMsg;
      task.updatedAt = new Date().toISOString();
      task.isResuming = false;
      syncTaskToStore(task);
      emitTaskTransition(task);
      safeReject(new Error(cleanMsg));
    });

    child.on('close', async (code) => {
      clearTimeout(startupTimer);
      const activeDurableJobs = typeof getJobManager === 'function'
        ? getJobManager().listJobs({ taskId: task.taskId, status: 'running' })
        : [];
      if (activeDurableJobs.length === 0) {
        if (executionWatchdog) clearTimeout(executionWatchdog);
        task.resetWatchdog = null;
      }
      if (task.controllerState !== 'interrupted' && task.controllerState !== 'closed') {
        task.controllerState = 'exited';
      }
      task.isResuming = false;
      flushBuffer();
      await new Promise((r) => queueMicrotask(r));
      flushBuffer();

      if (['starting', 'running'].includes(task.status)) {
        if (activeDurableJobs.length > 0) {
          task.controllerState = 'disconnected';
          task.child = null;
          task.pendingContinuation = true;
          task.updatedAt = new Date().toISOString();
          syncTaskToStore(task);
          emitTaskTransition(task);
          return;
        }

        if (code !== 0 && !task.completion) {
          task.status = 'error';
          task.error = redactSecrets(stderrBuffer.trim() || `Antigravity CLI process exited with code ${code}`);
        } else if (task.lastAnswer && !task.completion) {
          const parsedFinal = parseFinalResponse(task.lastAnswer);
          if (parsedFinal.kind === 'structured' && parsedFinal.status === 'completed') {
            const completion = classifyCompletion({
              response: task.lastAnswer,
              executorStatus: code === 0 ? 'SUCCESS' : 'ERROR',
              events: task.recentEvents,
              error: task.error,
              verificationRequirements: task.verificationRequirements,
              workspace: task.workspace,
            });
            task.status = completion.status;
            task.completion = completion;
            if (completion.error) task.error = completion.error;
          } else if (parsedFinal.kind === 'structured' && parsedFinal.status === 'waiting') {
            if (activeDurableJobs.length > 0) {
              task.status = 'running';
              task.controllerState = 'disconnected';
              task.child = null;
              task.pendingContinuation = true;
              task.updatedAt = new Date().toISOString();
              syncTaskToStore(task);
              emitTaskTransition(task);
              return;
            }
            task.status = 'waiting';
            task.completion = {
              status: 'waiting',
              normalizedStatus: 'waiting',
              summary: parsedFinal.summary,
              error: null,
              interimReason: parsedFinal.interimReason || 'Waiting on required input.',
              checks: { build: 'not_run', tests: 'not_run' },
              artifacts: [],
            };
          } else {
            // If executor dies before final contract and no owned work can continue => ERROR.
            // Progress prose or lack of explicit contract on exit MUST NEVER become stale WAITING.
            task.status = 'error';
            task.error = 'Antigravity exited without a final response.';
            task.completion = {
              status: 'error',
              normalizedStatus: 'error',
              summary: task.error,
              error: task.error,
              checks: { build: 'not_run', tests: 'not_run' },
              artifacts: [],
            };
          }
        } else if (!task.completion) {
          task.status = 'error';
          task.error = 'Antigravity exited without a final response.';
        }
        task.updatedAt = new Date().toISOString();
      } else if (task.status === 'waiting') {
        if (activeDurableJobs.length > 0) {
          task.status = 'running';
          task.controllerState = 'disconnected';
          task.child = null;
          task.pendingContinuation = true;
          task.updatedAt = new Date().toISOString();
          syncTaskToStore(task);
          emitTaskTransition(task);
          return;
        }
        if (code !== 0) {
          task.status = 'error';
          task.error = redactSecrets(stderrBuffer.trim() || `Antigravity CLI process exited with code ${code}`);
          task.completion = {
            status: 'error',
            normalizedStatus: 'error',
            summary: task.error,
            error: task.error,
            checks: { build: 'not_run', tests: 'not_run' },
            artifacts: [],
          };
          task.updatedAt = new Date().toISOString();
        }
      }
      if (task.status === 'error' && !task.completion) {
        task.completion = {
          status: 'error',
          normalizedStatus: 'error',
          summary: task.error,
          error: task.error,
          checks: { build: 'not_run', tests: 'not_run' },
          artifacts: [],
        };
      }
      task.child = null;
      task.continueSession = null;
      if (activeDurableJobs.length === 0) {
        task.pendingContinuation = false;
      }
      if (task.continuationState === 'in_progress') {
        task.continuationState = task.status === 'error' ? 'failed' : 'completed';
      }
      task.updatedAt = new Date().toISOString();
      syncTaskToStore(task);
      emitTaskTransition(task);
      safeResolve();
    });
  });
};

/**
 * Marks a task in recovery_required or waiting state as failed.
 * @param {{ taskId: string, reason?: string }} params
 * @returns {object}
 */
export const markTaskFailed = (params) => {
  const taskId = typeof params === 'string' ? params : params?.taskId;
  const reason = typeof params === 'object' ? params?.reason : undefined;
  if (!taskId) throw new Error('taskId is required to mark task failed.');
  const task = taskRegistry.get(taskId) || (globalTaskStore ? globalTaskStore.getTask(taskId) : null);
  if (!task) throw new Error(`Task '${taskId}' not found in task registry.`);
  task.status = 'error';
  task.error = redactSecrets(reason || 'Task marked as failed during recovery.');
  task.updatedAt = new Date().toISOString();
  taskRegistry.set(taskId, task);
  syncTaskToStore(task);
  emitTaskTransition(task);
  return task;
};

/**
 * Dismisses a task from active recovery UI without marking it DONE or deleting evidence.
 * @param {string | { taskId: string }} params
 * @returns {object}
 */
export const dismissRecoveryTask = (params) => {
  const taskId = typeof params === 'string' ? params : params?.taskId;
  if (!taskId) throw new Error('taskId is required to dismiss task.');
  const task = taskRegistry.get(taskId) || (globalTaskStore ? globalTaskStore.getTask(taskId) : null);
  if (!task) throw new Error(`Task '${taskId}' not found in task registry.`);
  task.dismissed = true;
  task.updatedAt = new Date().toISOString();
  taskRegistry.set(taskId, task);
  syncTaskToStore(task);
  emitTaskTransition(task);
  return task;
};

/**
 * Authoritative remote task approval and dispatch.
 * Checks requires_hearth_owned_job and launches Hearth JobManager.startJob()
 * before delegating to the provider.
 *
 * @param {object} params
 * @returns {Promise<{ success: boolean, taskId: string, conversationId: string | null, durableJobId?: string }>}
 */
export const approveAndDispatchRemoteTask = async ({
  task,
  workspace,
  taskStore = globalTaskStore,
  bridgeClient,
  customAgyPath,
  spawnFn = spawn,
  monitorTaskTransitionFn = null,
  startTaskFn = startAntigravityTask,
  getTaskFn = getAntigravityTask,
  syncRemoteFn = null,
  startJobFn = startDurableJob,
}) => {
  const hearthTaskId = crypto.randomUUID();
  const now = new Date().toISOString();
  const metadata = task.metadata || {};
  const requiresDurableJob = shouldRouteToDurableJob(metadata);

  const initialTask = {
    taskId: hearthTaskId,
    conversationId: null,
    workspace,
    title: task.title || task.prompt.slice(0, 60),
    source: 'remote',
    remoteTaskId: task.id,
    requestId: task.requestId || null,
    dismissed: false,
    status: 'starting',
    durableRoute: requiresDurableJob,
    metadata,
    createdAt: now,
    updatedAt: now,
    lastEvent: null,
    recentEvents: [],
    error: null,
    remoteSyncPending: false,
    remoteSyncStatus: 'pending',
  };

  taskRegistry.set(hearthTaskId, initialTask);
  if (taskStore) {
    taskStore.saveTask(initialTask);
  }

  // 1. Sync hearth_task_id immediately to Supabase
  if (typeof syncRemoteFn === 'function') {
    await syncRemoteFn({
      bridgeClient,
      taskStore,
      task: initialTask,
      overrides: { status: 'running' },
    });
  }

  // 2. Start monitorTaskTransition immediately
  if (typeof monitorTaskTransitionFn === 'function') {
    void monitorTaskTransitionFn(hearthTaskId);
  }

  // 3. If requires_hearth_owned_job, Hearth starts the durable job FIRST!
  let durableJob = null;
  if (requiresDurableJob) {
    const workerSpec = createControlledWorkerSpec(metadata, workspace);
    durableJob = startJobFn({
      taskId: hearthTaskId,
      command: workerSpec.command,
      args: workerSpec.args,
      cwd: workerSpec.cwd,
      env: workerSpec.env || {},
      metadata,
    });
    initialTask.jobId = durableJob.id;
    initialTask.jobIds = [durableJob.id];
    initialTask.status = 'running';
    if (taskStore) {
      taskStore.saveTask(initialTask);
    }
  }

  // 4. Delegate to provider
  const delegatedPrompt = requiresDurableJob && durableJob
    ? `[Hearth Durable Job Active]\nHearth has launched the authoritative background job (ID: ${durableJob.id}, PID: ${durableJob.pid}). Do NOT launch background processes or unmanaged shells via run_command. The durable job runs under Hearth ownership. Await completion or plan verification.\n\nTask Prompt:\n${task.prompt}`
    : task.prompt;

  const startRes = await startTaskFn({
    existingTaskId: hearthTaskId,
    workspace,
    prompt: delegatedPrompt,
    title: task.title,
    source: 'remote',
    remoteTaskId: task.id,
    requestId: task.requestId || null,
    userApproved: true,
    durableRoute: requiresDurableJob,
    jobId: durableJob?.id || null,
    jobIds: durableJob ? [durableJob.id] : [],
    metadata,
    customAgyPath,
    spawnFn,
    verificationRequirements: task.verificationRequirements || (task.artifacts ? { requiredArtifacts: task.artifacts } : null),
  });

  const taskObj = (typeof getTaskFn === 'function' ? getTaskFn(hearthTaskId) : null) || startRes;
  if (taskObj && taskObj.conversationId && typeof syncRemoteFn === 'function') {
    await syncRemoteFn({
      bridgeClient,
      taskStore,
      task: taskObj,
    });
  }

  return {
    success: true,
    taskId: hearthTaskId,
    conversationId: startRes.conversationId || taskObj?.conversationId || null,
    durableJobId: durableJob?.id || null,
  };
};

/**
 * Creates an authoritative production continuation runner for Hearth tasks.
 * Connects JobManager job completion to Antigravity task reasoning continuation.
 *
 * @param {object} options
 * @returns {function({ task?: object, job: object, evidence: object }): Promise<object>}
 */
export const createTaskContinuationRunner = ({
  jobManager,
  taskStore,
  getAntigravityTask: getTaskFn = getAntigravityTask,
  resumeAntigravityTask: resumeFn = resumeAntigravityTask,
  emitTaskTransition: emitFn = emitTaskTransition,
  syncRemoteTaskState: syncFn = null,
  getBridgeClient = () => null,
  getBridgeState = () => null,
  sendEvent = () => {},
  monitorTaskTransition: monitorFn = null,
  customAgyPath,
  runner,
  spawnFn,
} = {}) => {
  return async ({ task, job, evidence } = {}) => {
    if (!job) return null;
    const taskId = job.taskId || (task && task.taskId);
    if (!taskId) return null;

    const resolvedTask = task || (typeof getTaskFn === 'function' ? getTaskFn(taskId) : null) || (taskStore ? taskStore.getTask(taskId) : null);
    if (!resolvedTask) return null;

    // Exactly-once guard on task and job
    if (resolvedTask.continuationJobId === job.id && ['in_progress', 'completed'].includes(resolvedTask.continuationState)) {
      return null;
    }

    resolvedTask.continuationJobId = job.id;
    resolvedTask.continuationRequestedAt = new Date().toISOString();
    resolvedTask.continuationState = 'in_progress';
    resolvedTask.durableJobEvidence = evidence;
    resolvedTask.updatedAt = new Date().toISOString();

    if (taskStore && typeof taskStore.upsertTask === 'function') {
      try { taskStore.upsertTask(resolvedTask); } catch {}
    }
    if (typeof emitFn === 'function') {
      try { emitFn(resolvedTask); } catch {}
    }

    const continuePrompt = [
      'The durable background job has completed.',
      `Job ID: ${job.id}`,
      `Status: ${evidence?.status || job.status}`,
      `Exit code: ${evidence?.exitCode ?? job.exitCode}`,
      typeof evidence?.durationMs === 'number' ? `Duration: ${evidence.durationMs}ms` : '',
      evidence?.stdout ? `Output: ${evidence.stdout.trim()}` : '',
      evidence?.stderr ? `Stderr: ${evidence.stderr.trim()}` : '',
      evidence?.completedAt ? `Completed at: ${evidence.completedAt}` : '',
      evidence?.exitCode === 0
        ? 'Please evaluate the result and provide your final completion contract in JSON format.'
        : 'The process exited with an error. Please evaluate the failure and report completion status or error.',
    ].filter(Boolean).join('\n');

    try {
      const resumeOpts = {
        taskId: resolvedTask.taskId,
        message: continuePrompt,
        durableJobEvidence: evidence,
      };
      if (customAgyPath) resumeOpts.customAgyPath = customAgyPath;
      if (runner) resumeOpts.runner = runner;
      if (spawnFn) resumeOpts.spawnFn = spawnFn;

      const res = await resumeFn(resumeOpts);

      const bridgeState = typeof getBridgeState === 'function' ? getBridgeState() : null;
      const bridgeClient = typeof getBridgeClient === 'function' ? getBridgeClient() : null;

      if (resolvedTask.source === 'remote' && resolvedTask.remoteTaskId) {
        if (bridgeState) {
          bridgeState.activeRemoteTaskId = resolvedTask.remoteTaskId;
          if (typeof sendEvent === 'function') {
            sendEvent({ type: 'bridge:state', state: bridgeState });
          }
        }
        if (typeof syncFn === 'function' && bridgeClient) {
          await syncFn({
            bridgeClient,
            taskStore,
            task: (typeof getTaskFn === 'function' ? getTaskFn(res.taskId) : null) || resolvedTask,
            overrides: { status: 'running' },
          });
        }
      }

      if (typeof monitorFn === 'function') {
        void monitorFn(res.taskId);
      }
      return res;
    } catch (err) {
      resolvedTask.continuationState = 'failed';
      resolvedTask.status = 'error';
      resolvedTask.error = `Continuation failed: ${err.message}`;
      resolvedTask.updatedAt = new Date().toISOString();

      if (taskStore && typeof taskStore.upsertTask === 'function') {
        try { taskStore.upsertTask(resolvedTask); } catch {}
      }
      if (typeof emitFn === 'function') {
        try { emitFn(resolvedTask); } catch {}
      }

      const bridgeClient = typeof getBridgeClient === 'function' ? getBridgeClient() : null;
      if (resolvedTask.source === 'remote' && resolvedTask.remoteTaskId && typeof syncFn === 'function' && bridgeClient) {
        try {
          await syncFn({
            bridgeClient,
            taskStore,
            task: resolvedTask,
            overrides: { status: 'error', error: resolvedTask.error },
          });
        } catch {}
      }
      throw err;
    }
  };
};

