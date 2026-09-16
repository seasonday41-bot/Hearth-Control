import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';

export const SCHEMA_VERSION = 1;
export const MAX_OUTPUT_BYTES = 65536; // 64 KiB bounded buffer

/**
 * Valid job statuses recognized by the Durable Job Runtime.
 * @type {Set<string>}
 */
export const VALID_JOB_STATUSES = new Set([
  'queued',
  'running',
  'completed',
  'error',
  'cancelled',
  'recovery_required',
]);

/**
 * Redacts secrets, bearer tokens, API keys, private keys, and credentials from output/errors.
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
    // Generic JWT tokens
    .replace(/eyJ[A-Za-z0-9-_=]{10,}\.[A-Za-z0-9-_=]{10,}\.?[A-Za-z0-9-_.+/=]*/g, '[REDACTED_JWT]');
};

/**
 * Sanitizes a job object before persisting to disk.
 * Strictly guarantees:
 * - No in-memory child process handles or streams
 * - Redacted secrets in stdout, stderr, and errors
 * - Output capped at MAX_OUTPUT_BYTES
 * @param {object} raw
 * @returns {object | null}
 */
export const sanitizeJobForPersistence = (raw) => {
  if (!raw || typeof raw !== 'object') return null;

  const id = typeof raw.id === 'string' ? raw.id : '';
  if (!id) return null;

  const status = VALID_JOB_STATUSES.has(raw.status) ? raw.status : 'error';
  const taskId = typeof raw.taskId === 'string' && raw.taskId.trim() ? raw.taskId.trim() : null;
  const conversationId = typeof raw.conversationId === 'string' && raw.conversationId.trim() ? raw.conversationId.trim() : null;
  const command = typeof raw.command === 'string' ? raw.command : '';
  const args = Array.isArray(raw.args) ? raw.args.map(String) : [];
  const cwd = typeof raw.cwd === 'string' ? raw.cwd : '';
  const pid = Number.isInteger(raw.pid) ? raw.pid : null;
  const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString();
  const startedAt = typeof raw.startedAt === 'string' ? raw.startedAt : null;
  const completedAt = typeof raw.completedAt === 'string' ? raw.completedAt : null;
  const cancelledAt = typeof raw.cancelledAt === 'string' ? raw.cancelledAt : null;
  const lastHeartbeatAt = typeof raw.lastHeartbeatAt === 'string' ? raw.lastHeartbeatAt : null;
  const heartbeatCount = Number.isInteger(raw.heartbeatCount) ? raw.heartbeatCount : 0;
  const exitCode = typeof raw.exitCode === 'number' ? raw.exitCode : null;
  const signal = typeof raw.signal === 'string' ? raw.signal : null;
  const durationMs = typeof raw.durationMs === 'number' ? raw.durationMs : null;
  const error = raw.error ? redactSecrets(String(raw.error)).slice(0, 1000) : null;
  const stdout = raw.stdout ? redactSecrets(String(raw.stdout)).slice(-MAX_OUTPUT_BYTES) : '';
  const stderr = raw.stderr ? redactSecrets(String(raw.stderr)).slice(-MAX_OUTPUT_BYTES) : '';
  const metadata = (raw.metadata && typeof raw.metadata === 'object') ? { ...raw.metadata } : {};

  return {
    id,
    taskId,
    conversationId,
    command,
    args,
    cwd,
    status,
    pid,
    createdAt,
    startedAt,
    completedAt,
    cancelledAt,
    lastHeartbeatAt,
    heartbeatCount,
    exitCode,
    signal,
    durationMs,
    error,
    stdout,
    stderr,
    metadata,
  };
};

/**
 * Provider-independent Durable Job Manager.
 * Spawns and authoritatively owns background child processes on the local machine.
 * Decouples job execution from AI controller/stream lifecycles.
 */
export class JobManager extends EventEmitter {
  /**
   * @param {{ storagePath?: string, autoLoad?: boolean }} [options]
   */
  constructor(options = {}) {
    super();
    this.storagePath = options.storagePath || null;
    this.backupPath = this.storagePath ? `${this.storagePath}.bak` : null;
    this.jobs = new Map();
    this.children = new Map();
    this.completionEmitted = new Set();
    this.timeoutTimers = new Map();
    this.taskContinuationHandlers = new Map(); // taskId -> { task, continueSession }
    this.taskResolver = null;
    this.continuationRunner = null;
    this.taskStoreSaver = null;
    this.loaded = false;

    if (this.storagePath && options.autoLoad !== false) {
      this.load();
    }
  }

  /**
   * Sets an authoritative task resolver function: (taskId) => Task
   * @param {function} resolver
   */
  setTaskResolver(resolver) {
    if (typeof resolver === 'function') {
      this.taskResolver = resolver;
    }
  }

  /**
   * Resolves a task using the registered taskResolver.
   * @param {string} taskId
   * @returns {object | null}
   */
  resolveTask(taskId) {
    if (!taskId) return null;
    if (typeof this.taskResolver === 'function') {
      try {
        return this.taskResolver(taskId);
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Sets an authoritative task persistence saver: (task) => void
   * @param {function} saver
   */
  setTaskStoreSaver(saver) {
    if (typeof saver === 'function') {
      this.taskStoreSaver = saver;
    }
  }

  /**
   * Sets an authoritative continuation runner: ({ task, job, evidence }) => void
   * @param {function} runner
   */
  setContinuationRunner(runner) {
    if (typeof runner === 'function' || runner === null) {
      this.continuationRunner = runner;
    }
  }

  /**
   * Loads persisted jobs from storagePath.
   */
  load() {
    if (!this.storagePath) {
      this.loaded = true;
      return;
    }

    if (fs.existsSync(this.storagePath)) {
      try {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.jobs)) {
          this.jobs.clear();
          for (const item of parsed.jobs) {
            const sanitized = sanitizeJobForPersistence(item);
            if (sanitized && sanitized.id) {
              this.jobs.set(sanitized.id, sanitized);
            }
          }
          this.loaded = true;
          return;
        }
      } catch (err) {
        console.warn(`[JobManager] Primary store '${this.storagePath}' corrupted: ${err.message}. Trying backup...`);
      }
    }

    if (this.backupPath && fs.existsSync(this.backupPath)) {
      try {
        const raw = fs.readFileSync(this.backupPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.jobs)) {
          this.jobs.clear();
          for (const item of parsed.jobs) {
            const sanitized = sanitizeJobForPersistence(item);
            if (sanitized && sanitized.id) {
              this.jobs.set(sanitized.id, sanitized);
            }
          }
          this.loaded = true;
          return;
        }
      } catch (err) {
        console.error(`[JobManager] Backup store '${this.backupPath}' also failed: ${err.message}`);
      }
    }

    this.loaded = true;
  }

  /**
   * Atomically saves in-memory jobs to storagePath.
   */
  save() {
    if (!this.storagePath) return;

    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const payload = {
        version: SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
        jobs: Array.from(this.jobs.values()).map(sanitizeJobForPersistence).filter(Boolean),
      };

      const serialized = JSON.stringify(payload, null, 2);
      const tempPath = `${this.storagePath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      fs.writeFileSync(tempPath, serialized, 'utf8');

      if (fs.existsSync(this.storagePath)) {
        try {
          fs.copyFileSync(this.storagePath, this.backupPath);
        } catch {
          // Non-fatal backup failure
        }
      }

      fs.renameSync(tempPath, this.storagePath);
    } catch (err) {
      console.error(`[JobManager] Failed to save jobs to '${this.storagePath}':`, err.message);
    }
  }

  /**
   * Reconciles startup state on application reboot/restart:
   * - Jobs already completed, error, or cancelled remain terminal.
   * - Jobs in 'running' or 'queued' whose child process handle is lost across restart
   *   transition to 'recovery_required' (NEVER assumed completed or DONE).
   * @returns {{ reconciledCount: number, jobs: object[] }}
   */
  reconcileStartupState() {
    if (!this.loaded) this.load();
    let reconciledCount = 0;

    for (const [jobId, job] of this.jobs.entries()) {
      if (job.status === 'running' || job.status === 'queued') {
        job.status = 'recovery_required';
        job.error = 'Process unverified after Hearth restart. Manual recovery required.';
        job.completedAt = new Date().toISOString();
        this.jobs.set(jobId, job);
        reconciledCount++;
      }
    }

    if (reconciledCount > 0) {
      this.save();
    }

    return {
      reconciledCount,
      jobs: Array.from(this.jobs.values()),
    };
  }

  /**
   * Starts a new Hearth-owned durable background job.
   * Spawns a child process and tracks its lifecycle authoritatively.
   *
   * @param {object} options
   * @param {string} [options.jobId]
   * @param {string} [options.taskId]
   * @param {string} options.command
   * @param {string[]} [options.args]
   * @param {string} [options.cwd]
   * @param {object} [options.env]
   * @param {boolean} [options.shell]
   * @param {number} [options.timeoutMs]
   * @param {object} [options.metadata]
   * @param {function} [options.onHeartbeat]
   * @param {function} [options.onCompleted]
   * @returns {object} job representation
   */
  startJob(options = {}) {
    if (!this.loaded) this.load();

    const {
      jobId = `job_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      taskId = null,
      conversationId = null,
      command,
      args = [],
      cwd = process.cwd(),
      env = {},
      shell = false,
      timeoutMs = null,
      metadata = {},
      stdinPayload = null,
      onHeartbeat = null,
      onCompleted = null,
    } = options;

    if (!command || typeof command !== 'string') {
      throw new Error('[JobManager] command is required to start a job');
    }

    const job = {
      id: jobId,
      taskId: typeof taskId === 'string' && taskId.trim() ? taskId.trim() : null,
      conversationId: typeof conversationId === 'string' && conversationId.trim() ? conversationId.trim() : null,
      command,
      args: Array.isArray(args) ? args.map(String) : [],
      cwd: typeof cwd === 'string' ? cwd : process.cwd(),
      status: 'queued',
      pid: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
      lastHeartbeatAt: null,
      heartbeatCount: 0,
      exitCode: null,
      signal: null,
      durationMs: null,
      error: null,
      stdout: '',
      stderr: '',
      metadata: { ...metadata },
      onHeartbeat,
      onCompleted,
    };

    this.jobs.set(jobId, job);
    this.emit('job_created', { jobId, job });

    if (job.taskId) {
      const task = this.resolveTask(job.taskId);
      if (task) {
        if (!job.conversationId && task.conversationId) {
          job.conversationId = task.conversationId;
        }
        task.jobId = job.id;
        if (!Array.isArray(task.jobIds)) task.jobIds = [];
        if (!task.jobIds.includes(job.id)) task.jobIds.push(job.id);
        task.pendingContinuation = true;
        if (typeof task.resetWatchdog === 'function') {
          task.resetWatchdog('durable_job_started', { jobId: job.id });
        }
        if (typeof this.taskStoreSaver === 'function') {
          try { this.taskStoreSaver(task); } catch {}
        }
      }
    }

    // Transition to running & spawn process
    job.status = 'running';
    job.startedAt = new Date().toISOString();

    const childEnv = { ...process.env, ...env };
    if (command === process.execPath && childEnv.ELECTRON_RUN_AS_NODE === undefined) {
      childEnv.ELECTRON_RUN_AS_NODE = '1';
    }
    let child;
    try {
      child = spawn(command, job.args, {
        cwd: job.cwd,
        env: childEnv,
        shell: Boolean(shell),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      job.status = 'error';
      job.error = redactSecrets(err.message);
      job.completedAt = new Date().toISOString();
      this.save();
      this.emit('job_error', { jobId, job, error: job.error });
      return job;
    }

    job.pid = child.pid;
    job.child = child;
    this.children.set(jobId, child);

    if (stdinPayload !== null && stdinPayload !== undefined && child.stdin) {
      try {
        child.stdin.write(String(stdinPayload));
        child.stdin.end();
      } catch (err) {
        console.error(`[JobManager] Failed writing stdin to job '${jobId}':`, err.message);
      }
    }

    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      job.stdout = (job.stdout + text).slice(-MAX_OUTPUT_BYTES);
      this.recordJobHeartbeat(jobId, { text, source: 'child_stdout' });
    });

    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      job.stderr = (job.stderr + text).slice(-MAX_OUTPUT_BYTES);
    });

    child.on('error', (err) => {
      this._handleProcessExit(jobId, null, null, err);
    });

    child.on('close', (code, signal) => {
      this._handleProcessExit(jobId, code, signal, null);
    });

    child.on('exit', (code, signal) => {
      this._handleProcessExit(jobId, code, signal, null);
    });

    if (typeof timeoutMs === 'number' && timeoutMs > 0) {
      const timer = setTimeout(() => {
        if (job.status === 'running') {
          this.cancelJob(jobId, `Job exceeded timeout of ${timeoutMs}ms`);
        }
      }, timeoutMs);
      this.timeoutTimers.set(jobId, timer);
    }

    this.save();
    this.emit('job_started', { jobId, job });
    return job;
  }

  /**
   * Retrieves a job by ID.
   * @param {string} jobId
   * @returns {object | null}
   */
  getJob(jobId) {
    if (!this.loaded) this.load();
    return this.jobs.get(jobId) || null;
  }

  /**
   * Lists jobs with optional filtering.
   * @param {{ status?: string, taskId?: string }} [filter]
   * @returns {object[]}
   */
  listJobs(filter = {}) {
    if (!this.loaded) this.load();
    let list = Array.from(this.jobs.values());
    if (filter.status) {
      list = list.filter((j) => j.status === filter.status);
    }
    if (filter.taskId) {
      list = list.filter((j) => j.taskId === filter.taskId);
    }
    return list;
  }

  /**
   * Records a heartbeat on a Hearth-owned running job.
   * Invariant: Only genuine, verified, Hearth-owned running child processes can advance heartbeats.
   * Provider prose or unverified callers cannot fake a heartbeat.
   *
   * @param {string} jobId
   * @param {{ text?: string, source?: string, syncTaskHeartbeat?: boolean }} [details]
   * @returns {boolean} true if accepted and recorded, false otherwise
   */
  recordJobHeartbeat(jobId, details = {}) {
    if (!jobId || typeof jobId !== 'string') return false;
    const job = this.jobs.get(jobId);
    if (!job) return false;

    // Must be in running status
    if (job.status !== 'running') return false;

    // Must have a verified owned child process instance that is alive
    const child = this.children.get(jobId) || job.child;
    if (!child) return false;

    if (child.killed || child.exitCode !== null) {
      return false;
    }

    // Verify PID liveness if available
    if (typeof job.pid === 'number') {
      try {
        process.kill(job.pid, 0);
      } catch {
        return false;
      }
    }

    job.heartbeatCount = (job.heartbeatCount || 0) + 1;
    job.lastHeartbeatAt = new Date().toISOString();

    if (details.text) {
      job.stdout = (job.stdout + details.text).slice(-MAX_OUTPUT_BYTES);
    }

    if (typeof job.onHeartbeat === 'function') {
      try {
        job.onHeartbeat({ jobId, job, seq: job.heartbeatCount, details });
      } catch {
        // Non-fatal callback error
      }
    }

    this.emit('job_heartbeat', {
      jobId,
      job,
      seq: job.heartbeatCount,
      details,
    });

    // Handle task continuation / watchdog hook if registered
    if (job.taskId) {
      const task = this.resolveTask(job.taskId);
      if (task && typeof task.resetWatchdog === 'function') {
        task.resetWatchdog('durable_job_heartbeat', { jobId: job.id, seq: job.heartbeatCount });
      }
      if (this.taskContinuationHandlers.has(job.taskId)) {
        const handler = this.taskContinuationHandlers.get(job.taskId);
        if (typeof handler.onHeartbeat === 'function') {
          handler.onHeartbeat({ jobId, job, seq: job.heartbeatCount });
        }
      }
    }

    return true;
  }

  /**
   * Gracefully cancels an active job.
   * Sends SIGTERM to the verified owned child process. Never uses SIGKILL / sudo.
   *
   * @param {string} jobId
   * @param {string} [reason]
   * @returns {boolean}
   */
  cancelJob(jobId, reason = 'Cancelled by user or Hearth') {
    if (!this.loaded) this.load();
    const job = this.jobs.get(jobId);
    if (!job) return false;

    if (['completed', 'error', 'cancelled'].includes(job.status)) {
      return false;
    }

    const child = this.children.get(jobId) || job.child;
    if (child && !child.killed && child.exitCode === null) {
      try {
        child.kill('SIGTERM');
      } catch {
        // Ignored
      }
    } else if (typeof job.pid === 'number') {
      try {
        process.kill(job.pid, 'SIGTERM');
      } catch {
        // Ignored
      }
    }

    const timer = this.timeoutTimers.get(jobId);
    if (timer) {
      clearTimeout(timer);
      this.timeoutTimers.delete(jobId);
    }

    job.status = 'cancelled';
    job.cancelledAt = new Date().toISOString();
    job.error = redactSecrets(reason);

    this.save();
    this.emit('job_cancelled', { jobId, job, reason: job.error });
    this.emit('job_transition', { jobId, job, from: 'running', to: 'cancelled' });
    return true;
  }

  /** A cancelled status alone is not proof that its owned process exited. */
  isJobProcessStopped(jobId) {
    const job = this.getJob(jobId);
    if (!job || !['completed', 'error', 'cancelled'].includes(job.status)) return false;
    const child = this.children.get(jobId);
    if (child) return Number.isInteger(child.exitCode) || typeof child.signalCode === 'string';
    return Boolean(job.completedAt);
  }

  /**
   * Handles child process termination exactly once.
   * Captures evidence, cleans up resources, emits job_completed, and optionally
   * triggers same-task reasoning continuation.
   *
   * @private
   */
  _handleProcessExit(jobId, code, signal, err) {
    if (this.completionEmitted.has(jobId)) {
      return;
    }
    this.completionEmitted.add(jobId);

    const job = this.jobs.get(jobId);
    if (!job) return;

    const timer = this.timeoutTimers.get(jobId);
    if (timer) {
      clearTimeout(timer);
      this.timeoutTimers.delete(jobId);
    }

    const completedAt = new Date().toISOString();
    job.completedAt = completedAt;
    const startedAtMs = job.startedAt ? new Date(job.startedAt).getTime() : new Date(job.createdAt).getTime();
    job.durationMs = Math.max(0, new Date(completedAt).getTime() - startedAtMs);

    job.exitCode = typeof code === 'number' ? code : (signal ? 128 : (err ? 1 : 0));
    job.signal = signal || null;

    if (job.status !== 'cancelled') {
      if (err || (typeof code === 'number' && code !== 0)) {
        job.status = 'error';
        job.error = redactSecrets(err ? err.message : `Process exited with code ${code}`);
      } else {
        job.status = 'completed';
      }
    }

    const evidence = {
      jobId,
      taskId: job.taskId,
      conversationId: job.conversationId,
      status: job.status,
      exitCode: job.exitCode,
      signal: job.signal,
      durationMs: job.durationMs,
      stdout: redactSecrets(job.stdout),
      stderr: redactSecrets(job.stderr),
      error: job.error,
      completedAt: job.completedAt,
    };

    this.save();

    if (typeof job.onCompleted === 'function') {
      try {
        job.onCompleted(evidence);
      } catch {
        // Non-fatal callback error
      }
    }

    // Emit single job_completed event
    this.emit('job_completed', {
      jobId,
      job,
      evidence,
      status: job.status,
    });

    this.emit('job_transition', {
      jobId,
      job,
      from: 'running',
      to: job.status,
    });

    // Link evidence with parent task and trigger continuation turn
    if (job.taskId) {
      const task = this.resolveTask(job.taskId);
      if (task) {
        task.durableJobEvidence = evidence;
        task.jobId = job.id;
        if (typeof task.resetWatchdog === 'function') {
          task.resetWatchdog('durable_job_completed', { jobId: job.id, exitCode: evidence.exitCode });
        }
        if (!Array.isArray(task.recentEvents)) task.recentEvents = [];
        task.recentEvents.push({
          stepIndex: task.recentEvents.length + 1,
          type: 'DURABLE_JOB_COMPLETION',
          status: job.status === 'completed' ? 'DONE' : 'ERROR',
          createdAt: new Date().toISOString(),
          summary: redactSecrets(evidence.stdout || evidence.error || `Durable job finished with exit code ${evidence.exitCode}`).slice(0, 1000),
        });
        task.lastEvent = task.recentEvents[task.recentEvents.length - 1];
        task.updatedAt = new Date().toISOString();

        if (typeof this.taskStoreSaver === 'function') {
          try { this.taskStoreSaver(task); } catch {}
        }

        // Trigger reasoning continuation if available
        let continued = false;
        if (job.status !== 'cancelled' && !this.continuationRunner && task.pendingContinuation && typeof task.continueSession === 'function') {
          const continuePrompt = [
            'The durable background job has completed.',
            `Job ID: ${job.id}`,
            `Status: ${evidence.status || job.status}`,
            `Exit code: ${evidence.exitCode}`,
            typeof evidence.durationMs === 'number' ? `Duration: ${evidence.durationMs}ms` : '',
            evidence.stdout ? `Output: ${evidence.stdout.trim()}` : '',
            evidence.stderr ? `Stderr: ${evidence.stderr.trim()}` : '',
            evidence.completedAt ? `Completed at: ${evidence.completedAt}` : '',
            evidence.exitCode === 0
              ? 'Please evaluate the result and provide your final completion contract in JSON format.'
              : 'The process exited with an error. Please evaluate the failure and report completion status or error.',
          ].filter(Boolean).join('\n');
          continued = Boolean(task.continueSession(continuePrompt));
          if (continued) {
            task.continuationJobId = job.id;
            task.continuationRequestedAt = new Date().toISOString();
            task.continuationState = 'in_progress';
          }
        }

        if (job.status !== 'cancelled' && !continued && typeof this.continuationRunner === 'function') {
          void Promise.resolve().then(() => this.continuationRunner({ task, job, evidence }))
            .catch((continuationErr) => {
              console.error(`[JobManager] Continuation runner error for task ${job.taskId}:`, redactSecrets(continuationErr?.message || String(continuationErr)));
            });
        }
      }
    }

    // Trigger parent task continuation handler if registered
    if (job.status !== 'cancelled' && job.taskId && this.taskContinuationHandlers.has(job.taskId)) {
      const handler = this.taskContinuationHandlers.get(job.taskId);
      if (typeof handler.onCompleted === 'function') {
        try {
          handler.onCompleted({ jobId, job, evidence });
        } catch (continuationErr) {
          console.error(`[JobManager] Continuation error for task ${job.taskId}:`, continuationErr);
        }
      }
    }
  }

  /**
   * Registers a parent task continuation handler.
   * @param {string} taskId
   * @param {{ onHeartbeat?: function, onCompleted?: function }} handler
   */
  registerTaskContinuation(taskId, handler) {
    if (!taskId || typeof taskId !== 'string') return;
    this.taskContinuationHandlers.set(taskId, handler);
  }

  /**
   * Unregisters a parent task continuation handler.
   * @param {string} taskId
   */
  unregisterTaskContinuation(taskId) {
    if (!taskId) return;
    this.taskContinuationHandlers.delete(taskId);
  }

  /**
   * Waits for a job to reach a terminal state (completed, error, cancelled).
   *
   * @param {string} jobId
   * @param {number} [timeoutMs]
   * @returns {Promise<object>} resolves with job result evidence
   */
  waitForJob(jobId, timeoutMs) {
    const job = this.getJob(jobId);
    if (!job) {
      return Promise.reject(new Error(`[JobManager] Job '${jobId}' not found`));
    }

    if (['completed', 'error', 'cancelled', 'recovery_required'].includes(job.status)) {
      return Promise.resolve(this.getJobResult(jobId));
    }

    return new Promise((resolve, reject) => {
      let timer = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        this.removeListener('job_completed', onCompleted);
        this.removeListener('job_cancelled', onCancelled);
      };

      const onCompleted = (event) => {
        if (event.jobId === jobId) {
          cleanup();
          resolve(event.evidence || this.getJobResult(jobId));
        }
      };

      const onCancelled = (event) => {
        if (event.jobId === jobId) {
          cleanup();
          resolve(this.getJobResult(jobId));
        }
      };

      this.on('job_completed', onCompleted);
      this.on('job_cancelled', onCancelled);

      if (typeof timeoutMs === 'number' && timeoutMs > 0) {
        timer = setTimeout(() => {
          cleanup();
          reject(new Error(`[JobManager] Timed out waiting for job '${jobId}' after ${timeoutMs}ms`));
        }, timeoutMs);
      }
    });
  }

  /**
   * Retrieves sanitized result evidence for a finished job.
   * Returns null if the job is still running or queued.
   *
   * @param {string} jobId
   * @returns {object | null}
   */
  getJobResult(jobId) {
    const job = this.getJob(jobId);
    if (!job) return null;

    if (['queued', 'running'].includes(job.status)) {
      return null;
    }

    return {
      jobId: job.id,
      taskId: job.taskId,
      conversationId: job.conversationId,
      status: job.status,
      exitCode: job.exitCode,
      signal: job.signal,
      durationMs: job.durationMs,
      stdout: job.stdout,
      stderr: job.stderr,
      error: job.error,
      completedAt: job.completedAt,
      cancelledAt: job.cancelledAt,
    };
  }
}

// Authoritative singleton instance
let currentJobManager = new JobManager();

export const getJobManager = () => currentJobManager;
export const setJobManager = (manager) => {
  if (manager instanceof JobManager) {
    currentJobManager = manager;
  }
};

export const jobManager = currentJobManager;

export const startJob = (...args) => getJobManager().startJob(...args);
export const getJob = (...args) => getJobManager().getJob(...args);
export const listJobs = (...args) => getJobManager().listJobs(...args);
export const recordJobHeartbeat = (...args) => getJobManager().recordJobHeartbeat(...args);
export const cancelJob = (...args) => getJobManager().cancelJob(...args);
export const waitForJob = (...args) => getJobManager().waitForJob(...args);
export const getJobResult = (...args) => getJobManager().getJobResult(...args);

export const job_start = (...args) => startJob(...args);
export const job_status = (...args) => getJob(...args);
export const job_wait = (...args) => waitForJob(...args);
export const job_result = (...args) => getJobResult(...args);
export const job_cancel = (...args) => cancelJob(...args);
