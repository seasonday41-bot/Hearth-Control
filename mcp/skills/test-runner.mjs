import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
const MAX_STDOUT = 200 * 1024;
const MAX_STDERR = 100 * 1024;
const GRACE_MS = 2_000;

const profile = (id, label, files, timeoutMs = 90_000) => Object.freeze({
  id, label, executable: process.execPath, args: Object.freeze(['--test-isolation=none', '--test', ...files]),
  timeoutMs, expectedCategory: 'Hearth test suite', workingDirectoryPolicy: 'selected Hearth workspace',
});

export const TEST_PROFILES = Object.freeze({
  'context-builder': profile('context-builder', 'Context Builder tests', ['scripts/test-context-builder.mjs']),
  'context-inspector': profile('context-inspector', 'Context Inspector tests', ['scripts/test-context-inspector.mjs']),
  'local-chat': profile('local-chat', 'Local Chat tests', ['scripts/test-local-chat.mjs']),
  'local-provider': profile('local-provider', 'Local Provider tests', ['scripts/test-local-provider.mjs']),
  'provider-selection': profile('provider-selection', 'Provider Selection tests', ['scripts/test-provider-selection.mjs']),
  'local-skills': profile('local-skills', 'Local Skills tests', ['scripts/test-local-skills.mjs', 'scripts/test-local-skills-loop.mjs', 'scripts/test-grounding-gate.mjs']),
  'storage-audit': profile('storage-audit', 'Storage Audit tests', ['scripts/test-storage-audit.mjs']),
  'antigravity-regression': profile('antigravity-regression', 'Antigravity regression tests', ['scripts/test-antigravity.mjs'], 120_000),
});

export const TEST_RUN_TOOL = Object.freeze({ type: 'function', function: {
  name: 'test_run',
  description: 'Request one approved Hearth test profile. Hearth requires user confirmation before execution.',
  parameters: { type: 'object', additionalProperties: false, required: ['profile'], properties: {
    profile: { type: 'string', enum: Object.keys(TEST_PROFILES) },
  } },
} });

const boundedAppend = (state, chunk, limit) => {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const room = limit - state.bytes;
  if (room > 0) { state.chunks.push(buffer.subarray(0, room)); state.bytes += Math.min(room, buffer.length); }
  if (buffer.length > room) state.truncated = true;
};

export class TestRunner {
  constructor({ workspace, spawnFn = spawn, now = Date.now, graceMs = GRACE_MS, timers = { setTimeout, clearTimeout, setInterval, clearInterval } } = {}) {
    this.workspace = workspace;
    this.spawnFn = spawnFn;
    this.now = now;
    this.graceMs = graceMs;
    this.timers = timers;
    this.active = null;
  }

  async validate(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || typeof input.profile !== 'string') throw Object.assign(new Error('Only a registered test profile ID is accepted'), { code: 'INVALID_PROFILE_REQUEST' });
    const selected = TEST_PROFILES[input.profile];
    if (!selected) throw Object.assign(new Error('No approved Test Runner profile covers this test yet'), { code: 'PROFILE_NOT_APPROVED' });
    if (!this.workspace) throw Object.assign(new Error('Select the Hearth workspace before running tests'), { code: 'WORKSPACE_REQUIRED' });
    let root;
    let manifest;
    try {
      root = await fs.realpath(this.workspace);
      const manifestPath = path.join(root, 'package.json');
      if (await fs.realpath(manifestPath) !== manifestPath || (await fs.stat(manifestPath)).size > 1024 * 1024) throw Error('Invalid manifest');
      manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    } catch { throw Object.assign(new Error('Selected workspace is not a Hearth project'), { code: 'WORKSPACE_REJECTED' }); }
    if (manifest?.name !== 'hearth-control') throw Object.assign(new Error('Approved profiles are available only in a selected Hearth workspace'), { code: 'WORKSPACE_REJECTED' });
    for (const file of selected.args.slice(2)) {
      let real;
      try { real = await fs.realpath(path.join(root, file)); }
      catch { throw Object.assign(new Error('Test profile path is not permitted'), { code: 'PATH_REJECTED' }); }
      if (!real.startsWith(`${root}${path.sep}`) || !real.endsWith('.mjs') || !real.startsWith(`${root}${path.sep}scripts${path.sep}test-`)) throw Object.assign(new Error('Test profile path is not permitted'), { code: 'PATH_REJECTED' });
    }
    return { ...selected, cwd: root };
  }

  async run(input, { signal, onActivity = async () => {} } = {}) {
    const selected = await this.validate(input);
    if (this.active) throw Object.assign(new Error('A Test Runner process is already active'), { code: 'RUNNER_BUSY' });
    if (signal?.aborted) return { profile: selected.id, status: 'cancelled', exitCode: null, signal: null, durationMs: 0, stdout: '', stderr: '', outputTruncated: false, pid: null };
    const started = this.now();
    const stdout = { chunks: [], bytes: 0, truncated: false };
    const stderr = { chunks: [], bytes: 0, truncated: false };
    const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG'].filter((key) => typeof process.env[key] === 'string').map((key) => [key, process.env[key]]));
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
    let child;
    try { child = this.spawnFn(selected.executable, selected.args, { cwd: selected.cwd, shell: false, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { return { profile: selected.id, status: 'runner_error', exitCode: null, signal: null, durationMs: this.now() - started, stdout: '', stderr: String(error.message || error), outputTruncated: false, pid: null }; }
    this.active = child;
    const pid = child.pid ?? null;
    void Promise.resolve(onActivity({ type: 'test_running', skill: 'test_run', profile: selected.id, label: selected.label, pid, elapsedMs: 0 })).catch(() => {});
    return new Promise((resolve) => {
      let stopReason = null;
      let settled = false;
      let graceTimer;
      let timeoutTimer;
      let tick;
      const result = (code = null, exitSignal = null, stillRunning = false, error = null) => ({
        profile: selected.id,
        status: stopReason === 'timeout' ? 'timed_out' : stopReason === 'cancel' ? 'cancelled' : error || stillRunning ? 'runner_error' : code === 0 ? 'passed' : 'failed',
        exitCode: Number.isInteger(code) ? code : null,
        rawExitCode: Number.isInteger(code) ? code : null,
        signal: exitSignal || (stopReason ? 'SIGTERM' : null),
        durationMs: Math.max(0, this.now() - started),
        stdout: Buffer.concat(stdout.chunks).toString('utf8'), stderr: Buffer.concat(stderr.chunks).toString('utf8'),
        outputTruncated: stdout.truncated || stderr.truncated, pid,
        ...(stillRunning ? { processStillRunning: true, manualReviewRequired: true } : {}),
        ...(error ? { error: String(error.message || error) } : {}),
      });
      const finish = async (code, exitSignal, stillRunning = false, error = null) => {
        if (settled) return;
        settled = true;
        this.timers.clearTimeout(timeoutTimer); this.timers.clearTimeout(graceTimer); this.timers.clearInterval(tick);
        signal?.removeEventListener('abort', cancel);
        if (!stillRunning) this.active = null;
        const output = result(code, exitSignal, stillRunning, error);
        const counts = testCounts(output.stdout);
        try { await onActivity({ type: 'test_finished', skill: 'test_run', profile: selected.id, label: selected.label, pid, status: output.status, exitCode: output.exitCode, elapsedMs: output.durationMs, passedCount: ['passed', 'failed'].includes(output.status) ? counts.pass : undefined, testCount: ['passed', 'failed'].includes(output.status) ? counts.tests : undefined, outputTruncated: output.outputTruncated, processStillRunning: stillRunning }); }
        catch {}
        resolve(output);
      };
      const terminate = (reason) => {
        if (stopReason || settled) return;
        stopReason = reason;
        try { child.kill('SIGTERM'); } catch {}
        graceTimer = this.timers.setTimeout(() => { void finish(null, 'SIGTERM', true); }, this.graceMs);
      };
      const cancel = () => terminate('cancel');
      child.stdout?.on('data', (chunk) => boundedAppend(stdout, chunk, MAX_STDOUT));
      child.stderr?.on('data', (chunk) => boundedAppend(stderr, chunk, MAX_STDERR));
      child.on('error', (error) => { void finish(null, null, false, error); });
      child.on('close', (code, exitSignal) => { if (settled) this.active = null; else void finish(code, exitSignal); });
      signal?.addEventListener('abort', cancel, { once: true });
      tick = this.timers.setInterval(() => { void onActivity({ type: 'test_progress', skill: 'test_run', profile: selected.id, label: selected.label, pid, elapsedMs: this.now() - started }); }, 1000);
      timeoutTimer = this.timers.setTimeout(() => terminate('timeout'), selected.timeoutMs);
      if (signal?.aborted) cancel();
    });
  }
}

export const createTestRunner = (options) => new TestRunner(options);

const testCounts = (output) => Object.fromEntries([...String(output || '').matchAll(/^(?:#|ℹ)\s+(tests|pass|fail)\s+(\d+)$/gm)].map((match) => [match[1], Number(match[2])]));

export const summarizeTestResult = (result) => {
  const counts = testCounts(result.stdout);
  const tally = ['passed', 'failed'].includes(result.status) && Number.isInteger(counts.tests) && Number.isInteger(counts.pass) ? ` ${counts.pass}/${counts.tests}` : '';
  const suffix = result.outputTruncated ? ' Output was truncated.' : '';
  const still = result.processStillRunning ? ' Process did not exit after SIGTERM; manual review required.' : '';
  const captured = String(result.stdout || result.stderr || '').slice(-2000);
  const partial = result.status === 'cancelled' && captured ? ` Partial output: ${captured}` : '';
  const exit = ['cancelled', 'timed_out'].includes(result.status) ? '' : `; exit ${result.exitCode ?? 'none'}`;
  return `${result.profile}: ${result.status}${tally}${exit}${result.signal ? `; signal ${result.signal}` : ''}; ${result.durationMs} ms.${suffix}${still}${partial}`;
};

export const groundedTestAnswer = (answer, result) => {
  const text = String(answer || '').trim();
  const summary = summarizeTestResult(result);
  if (!text) return summary;
  if (result.status !== 'passed' && /(?:\b(?:tests?|suite)\s+(?:all\s+)?pass(?:ed)?\b|\bpass(?:ed)?\s+\d+\s+tests?\b|ผ่าน(?:ทั้งหมด)?)/i.test(text)) return summary;
  if (result.status === 'passed' && /(?:\b(?:tests?|suite)\s+fail(?:ed)?\b|ไม่ผ่าน)/i.test(text)) return summary;
  const counts = testCounts(result.stdout);
  if (/(?:\b(?:duration|took|elapsed|เวลา)\b|\b\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|seconds?|วินาที|มิลลิวินาที)\b)/i.test(text)) return summary;
  if (/(?:\b(?:exit|signal|status|timeout|timed[ -]?out|cancel(?:led|lation)?|truncat(?:ed|ion)?)\b)/i.test(text)) return summary;
  for (const match of text.matchAll(/\b(\d+)\s*\/\s*(\d+)\b/g)) {
    if (Number(match[1]) !== counts.pass || Number(match[2]) !== counts.tests) return summary;
  }
  for (const match of text.matchAll(/\b(\d+)\s+tests?\s+(?:passed|pass|failed|fail)\b|\b(?:passed|pass|failed|fail)\s+(\d+)\s+tests?\b/gi)) {
    const number = Number(match[1] || match[2]);
    if (!Number.isInteger(counts.tests) || number > counts.tests) return summary;
  }
  return `${summary}\n${text}`;
};
