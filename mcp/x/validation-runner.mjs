import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { assertValidatedTaskShape, normalizePathString, isTraversal } from './context-loader.mjs';
import { throwIfAborted } from './cancellation.mjs';

/**
 * Runs ONLY the validation commands already declared on a validated
 * x-task-v1's own `validation.required`/`validation.optional` arrays --
 * never a caller-selectable, independently-supplied command list. This is
 * deliberate: `runValidation(task, kind, options)` (and the
 * `runRequiredValidation`/`runOptionalValidation` wrappers) always read
 * `task.validation[kind]` internally, so there is no call shape that lets
 * a caller (or, transitively, a model) hand this module an arbitrary
 * command independent of the task contract that was validated before
 * execution ever began.
 *
 * Command authority and shape (mirrors mcp/skills/test-runner.mjs's own
 * security posture, which this module does not import -- that class is
 * scoped to Hearth's own Local-Chat-facing TEST_PROFILES registry and
 * isn't a fit for per-task dynamic commands; the SAFETY PATTERN is
 * reused, not the class):
 *   - the only permitted command shape is exactly
 *     `node --test scripts/test-<name>.mjs [scripts/test-<name2>.mjs ...]`,
 *     matched with a fixed regex -- no other executable, flag, or shell
 *     metacharacter is ever accepted.
 *   - every file argument is independently `realpath`-verified to resolve
 *     inside `task.workspace.root`, using the same "derive the intended
 *     absolute path solely from the workspace root plus the literal
 *     string, then realpath and check containment" pattern Phase 5B's
 *     `resolveWriteTarget` uses -- nothing here is trusted without an
 *     independent filesystem check.
 *   - execution is always `spawn(process.execPath, argv, { shell: false, ... })`
 *     with a fixed argv array built entirely from verified, realpath'd
 *     paths. `shell: false` plus this fixed parser is what prevents shell
 *     injection: there is no shell to inject into, and no path component
 *     is ever concatenated into a command string.
 *
 * IMPORTANT SCOPE OF THE SAFETY CLAIM ABOVE: it covers only how the
 * *command itself* is chosen and invoked. Once spawned, `node --test
 * <file>` executes real repository JavaScript with a real Node runtime
 * and this process's ambient OS privileges -- it can make network
 * requests, spawn its own child processes, and read/write the filesystem
 * like any other Node script, because it IS one. Reducing the inherited
 * environment to `PATH`/`HOME`/`TMPDIR`/`LANG` (matching test-runner.mjs)
 * limits some environment-dependent behavior but is not a sandbox and
 * does not restrict network or `child_process` access. Do not describe
 * validation as running in an isolated/sandboxed environment unless a
 * separate, actual runtime sandbox (a container, a seccomp/permission
 * profile, Node's own `--permission` flag, etc.) is added and verified to
 * enforce that -- none exists here.
 *
 * `status` is derived ONLY from the child process's own exit code, signal,
 * and timeout state (`exitCode === 0 && !timedOut && signal === null` =>
 * `'passed'`) -- it never reads Node's `--test` reporter output for pass/
 * fail authority. That output (parsed for `tests`/`pass`/`fail` counts) is
 * attached only as `summary`, informational evidence a repair round may
 * show the model, never something that can flip `status`.
 *
 * Timeout escalation is a real kill, not merely a report: on timeout this
 * module sends SIGTERM, and if the process has not exited `GRACE_MS`
 * later, sends SIGKILL (which cannot be caught or ignored by the child).
 * Resolution prefers the child's actual `close` event -- fired the moment
 * the OS reaps the process -- so `timed_out` is only ever reported once
 * the process is confirmed gone; a further bounded fallback timer exists
 * solely so the returned Promise cannot hang in a pathological case where
 * `close` never fires, not as a substitute for actually killing the
 * process.
 */

export const DEFAULT_VALIDATION_LIMITS = Object.freeze({
  timeoutMs: 90_000,
  maxStdoutBytes: 200_000,
  maxStderrBytes: 100_000,
});

// Absolute ceilings a caller's `options.limits` can never exceed.
const HARD_VALIDATION_LIMITS = Object.freeze({
  timeoutMs: 300_000,
  maxStdoutBytes: 1_000_000,
  maxStderrBytes: 500_000,
});

const GRACE_MS = 2_000;
const COMMAND_PATTERN = /^node --test(?: scripts\/test-[A-Za-z0-9_-]+\.mjs)+$/;
const VERIFIED_FILE_PATTERN = /^scripts\/test-[A-Za-z0-9_-]+\.mjs$/;

const clampPositiveInt = (value, fallback, hardMax) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), hardMax);
};

const resolveValidationLimits = (overrides) => {
  const merged = { ...DEFAULT_VALIDATION_LIMITS, ...(overrides || {}) };
  return Object.freeze({
    timeoutMs: clampPositiveInt(merged.timeoutMs, DEFAULT_VALIDATION_LIMITS.timeoutMs, HARD_VALIDATION_LIMITS.timeoutMs),
    maxStdoutBytes: clampPositiveInt(merged.maxStdoutBytes, DEFAULT_VALIDATION_LIMITS.maxStdoutBytes, HARD_VALIDATION_LIMITS.maxStdoutBytes),
    maxStderrBytes: clampPositiveInt(merged.maxStderrBytes, DEFAULT_VALIDATION_LIMITS.maxStderrBytes, HARD_VALIDATION_LIMITS.maxStderrBytes),
  });
};

/** Parses the command string against the one fixed allowlisted shape. Never a shell, never a generic split-and-guess. */
function parseValidationCommand(command) {
  if (typeof command !== 'string') return { ok: false, detail: 'command must be a string' };
  const trimmed = command.trim();
  if (!COMMAND_PATTERN.test(trimmed)) {
    return { ok: false, detail: `command does not match the allowlisted 'node --test scripts/test-*.mjs' shape: '${trimmed}'` };
  }
  return { ok: true, files: trimmed.split(' ').slice(2) };
}

/** Independently resolves and verifies every file argument against the task's OWN workspace root -- never trusts the string beyond deriving a candidate path from it. */
async function verifyCommandFiles(workspaceRoot, files) {
  let canonicalRoot;
  try {
    canonicalRoot = await realpath(workspaceRoot);
  } catch {
    return { ok: false, detail: 'workspace root does not exist or is unreadable' };
  }
  const verified = [];
  for (const file of files) {
    const normalized = normalizePathString(file);
    if (isTraversal(normalized)) return { ok: false, detail: `'${file}' is not a permitted path` };
    const intended = path.resolve(canonicalRoot, normalized);
    let real;
    try {
      real = await realpath(intended);
    } catch {
      return { ok: false, detail: `'${file}' does not exist` };
    }
    const relative = path.relative(canonicalRoot, real).split(path.sep).join('/');
    if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
      return { ok: false, detail: `'${file}' escapes the workspace` };
    }
    if (!VERIFIED_FILE_PATTERN.test(relative)) {
      return { ok: false, detail: `'${file}' is not a permitted scripts/test-*.mjs path` };
    }
    verified.push(real);
  }
  return { ok: true, canonicalRoot, files: verified };
}

const boundedAppend = (state, chunk, limit) => {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const room = limit - state.bytes;
  if (room > 0) { state.chunks.push(buffer.subarray(0, room)); state.bytes += Math.min(room, buffer.length); }
  if (buffer.length > room) state.truncated = true;
};

/**
 * Spawns exactly one already-verified argv array. `shell:false`; nothing
 * here is ever a string a shell could reparse. On timeout, escalates
 * SIGTERM -> (after GRACE_MS if still unsettled) SIGKILL -> (after a
 * further bounded GRACE_MS if `close` still somehow never fired) a final
 * resolve, so the returned Promise can never hang and a process that
 * ignores SIGTERM is still actually terminated, not merely reported dead.
 * An optional AbortSignal uses the same termination escalation; the caller
 * receives XExecutionAbortedError only after the owned child has settled.
 */
function spawnValidation(executable, args, cwd, limits, signal) {
  return new Promise((resolve) => {
    throwIfAborted(signal);
    const stdout = { chunks: [], bytes: 0, truncated: false };
    const stderr = { chunks: [], bytes: 0, truncated: false };
    const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG'].filter((key) => typeof process.env[key] === 'string').map((key) => [key, process.env[key]]));
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
    const started = Date.now();
    let child;
    try {
      child = spawn(executable, args, { cwd, shell: false, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ exitCode: null, signal: null, timedOut: false, durationMs: 0, stdout: '', stderr: String(err?.message || err), outputTruncated: false, pid: null });
      return;
    }
    const pid = child.pid ?? null;
    let settled = false;
    let stopReason = null;
    let timeoutTimer;
    let killTimer;
    let finalFallbackTimer;

    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      clearTimeout(finalFallbackTimer);
      abortSignal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode: Number.isInteger(code) ? code : null,
        signal: signal || null,
        timedOut: stopReason === 'timeout',
        durationMs: Date.now() - started,
        stdout: Buffer.concat(stdout.chunks).toString('utf8'),
        stderr: Buffer.concat(stderr.chunks).toString('utf8'),
        outputTruncated: stdout.truncated || stderr.truncated,
        pid,
      });
    };

    child.stdout?.on('data', (chunk) => boundedAppend(stdout, chunk, limits.maxStdoutBytes));
    child.stderr?.on('data', (chunk) => boundedAppend(stderr, chunk, limits.maxStderrBytes));
    child.on('error', () => finish(null, null));
    // The real close event -- fired only once the OS has actually reaped
    // the process -- is always preferred over any timer-driven guess.
    child.on('close', (code, signal) => finish(code, signal));

    const abortSignal = signal;
    const requestStop = (reason) => {
      if (settled || stopReason) return;
      stopReason = reason;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      killTimer = setTimeout(() => {
        if (settled) return; // `close` already resolved us from the SIGTERM alone
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        // SIGKILL cannot be caught or ignored, so `close` should follow
        // almost immediately. This fallback exists only so the Promise
        // cannot hang in a pathological case where `close` never fires --
        // it is not a substitute for the SIGKILL actually terminating the
        // process, which the OS guarantees independently of this timer.
        finalFallbackTimer = setTimeout(() => finish(null, 'SIGKILL'), GRACE_MS);
      }, GRACE_MS);
    };
    const onAbort = () => requestStop('abort');
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    if (abortSignal?.aborted) onAbort();
    timeoutTimer = setTimeout(() => requestStop('timeout'), limits.timeoutMs);
  });
}

/** The ONLY pass/fail authority: exit code 0, no timeout, no terminating signal. Reporter output never overrides this. */
const computeStatus = ({ exitCode, signal, timedOut }) => {
  if (timedOut) return 'timed_out';
  if (signal) return 'failed';
  return exitCode === 0 ? 'passed' : 'failed';
};

const testCounts = (output) => Object.fromEntries(
  [...String(output || '').matchAll(/^(?:#|ℹ)\s+(tests|pass|fail)\s+(\d+)$/gm)].map((match) => [match[1], Number(match[2])]),
);

const buildSummary = (command, outcome, status) => {
  const counts = testCounts(outcome.stdout);
  const tally = Number.isInteger(counts.tests) && Number.isInteger(counts.pass) ? ` ${counts.pass}/${counts.tests}` : '';
  const exit = status === 'timed_out' ? '' : `; exit ${outcome.exitCode ?? 'none'}`;
  const signal = outcome.signal ? `; signal ${outcome.signal}` : '';
  const truncated = outcome.outputTruncated ? ' Output truncated.' : '';
  return `${command}: ${status}${tally}${exit}${signal}; ${outcome.durationMs} ms.${truncated}`;
};

const invalidCommandResult = (command, detail) => ({
  command, status: 'invalid_command', exitCode: null, signal: null, timedOut: false,
  durationMs: 0, stdout: '', stderr: '', outputTruncated: false, pid: null, summary: `${command}: invalid_command -- ${detail}`,
});

async function runOneCommand(workspaceRoot, command, limits, signal) {
  throwIfAborted(signal);
  const parsed = parseValidationCommand(command);
  if (!parsed.ok) return invalidCommandResult(command, parsed.detail);
  const verified = await verifyCommandFiles(workspaceRoot, parsed.files);
  throwIfAborted(signal);
  if (!verified.ok) return invalidCommandResult(command, verified.detail);
  const args = ['--test-isolation=none', '--test', ...verified.files];
  const outcome = await spawnValidation(process.execPath, args, verified.canonicalRoot, limits, signal);
  throwIfAborted(signal);
  const status = computeStatus(outcome);
  return {
    command, status,
    exitCode: outcome.exitCode, signal: outcome.signal, timedOut: outcome.timedOut,
    durationMs: outcome.durationMs, stdout: outcome.stdout, stderr: outcome.stderr,
    outputTruncated: outcome.outputTruncated, pid: outcome.pid,
    summary: buildSummary(command, outcome, status),
  };
}

/**
 * Runs every command already declared at `task.validation[kind]`, in
 * order. `kind` must be exactly `'required'` or `'optional'` -- there is
 * no way to pass an independent command list; the task contract is the
 * only source.
 *
 * @param {object} task validated x-task-v1
 * @param {'required'|'optional'} kind
 * @param {{ limits?: object }} [options]
 * @param {{ limits?: object, signal?: AbortSignal }} [options]
 * @returns {Promise<Array<{command, status, exitCode, signal, timedOut, durationMs, stdout, stderr, outputTruncated, pid, summary}>>}
 */
export async function runValidation(task, kind, options = {}) {
  throwIfAborted(options.signal);
  if (kind !== 'required' && kind !== 'optional') {
    throw new TypeError("kind must be exactly 'required' or 'optional'");
  }
  assertValidatedTaskShape(task);
  const commands = Array.isArray(task.validation?.[kind]) ? task.validation[kind] : [];
  const limits = resolveValidationLimits(options.limits);
  const results = [];
  for (const command of commands) {
    throwIfAborted(options.signal);
    // eslint-disable-next-line no-await-in-loop -- validation commands run one at a time, in declared order.
    results.push(await runOneCommand(task.workspace.root, command, limits, options.signal));
    throwIfAborted(options.signal);
  }
  return results;
}

export const runRequiredValidation = (task, options) => runValidation(task, 'required', options);
export const runOptionalValidation = (task, options) => runValidation(task, 'optional', options);
