import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runValidation, runRequiredValidation, runOptionalValidation, DEFAULT_VALIDATION_LIMITS } from '../mcp/x/validation-runner.mjs';
import { X_TASK_VERSION } from '../mcp/x/task-contract.mjs';

const dirs = [];
function tmpWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-x-val-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeFixture(root, name, content) {
  const abs = path.join(root, 'scripts', name);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

const isAlive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code !== 'ESRCH'; }
};

const validTask = (root, overrides = {}) => ({
  version: X_TASK_VERSION,
  task_id: 'TASK-VAL-1',
  parent_task_id: null,
  revision: 1,
  attempt: 1,
  based_on_result_id: null,
  objective: 'Validate a change.',
  problem: 'The validation runner needs an allowlisted, safe command surface.',
  expected_behavior: 'Only task-declared commands ever run, never a shell.',
  observed_behavior: 'No validation runner exists yet.',
  why_this_matters: 'Free-form commands would be an injection surface.',
  known_evidence: [],
  suspected_area: [],
  workspace: { repo: 'Hearth-Control', root },
  scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: [] },
  constraints: { preserve: [], do_not: [] },
  allowed_tools: ['repo_read'],
  acceptance_criteria: ['Validation runs safely.'],
  validation: { required: ['node --test scripts/test-pass.mjs'], optional: [] },
  verification: null,
  done_criteria: ['Evidence is returned.'],
  teaching_notes: [],
  uncertainty_policy: { policy: 'bounded_autonomy', stop_conditions: [] },
  repair_budget: { initial_attempts: 1, max_repairs: 2, max_total_rounds: 3 },
  timing: { estimated_minutes: 5, first_check_after_minutes: 1, soft_deadline_minutes: 3, hard_timeout_minutes: 10 },
  commit_policy: { mode: 'never' },
  ...overrides,
});

// ---------------------------------------------------------------------------
// Command authority
// ---------------------------------------------------------------------------

test('VR1 a valid required command executes and reports a passing result', async () => {
  const root = tmpWorkspace();
  writeFixture(root, 'test-pass.mjs', "import test from 'node:test';\ntest('ok', () => {});\n");
  const task = validTask(root);
  const results = await runRequiredValidation(task);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'passed');
  assert.equal(results[0].exitCode, 0);
  assert.equal(results[0].command, 'node --test scripts/test-pass.mjs');
});

test('VR2 runOptionalValidation runs task.validation.optional only, never .required', async () => {
  const root = tmpWorkspace();
  writeFixture(root, 'test-pass.mjs', "import test from 'node:test';\ntest('ok', () => {});\n");
  writeFixture(root, 'test-optional-one.mjs', "import test from 'node:test';\ntest('ok', () => {});\n");
  const task = validTask(root, { validation: { required: ['node --test scripts/test-pass.mjs'], optional: ['node --test scripts/test-optional-one.mjs'] } });
  const results = await runOptionalValidation(task);
  assert.equal(results.length, 1);
  assert.equal(results[0].command, 'node --test scripts/test-optional-one.mjs');
});

test('VR3 the caller cannot supply an independent command list -- only task.validation[kind] is ever used', async () => {
  const root = tmpWorkspace();
  writeFixture(root, 'test-pass.mjs', "import test from 'node:test';\ntest('ok', () => {});\n");
  writeFixture(root, 'test-fail.mjs', "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('boom', () => { assert.equal(1, 2); });\n");
  const task = validTask(root, { validation: { required: ['node --test scripts/test-pass.mjs'], optional: [] } });
  const results = await runRequiredValidation(task, { commands: ['node --test scripts/test-fail.mjs'] });
  assert.equal(results.length, 1);
  assert.equal(results[0].command, 'node --test scripts/test-pass.mjs');
  assert.equal(results[0].status, 'passed');
});

test('VR4 runValidation rejects a kind other than "required"/"optional"', async () => {
  const root = tmpWorkspace();
  writeFixture(root, 'test-pass.mjs', "import test from 'node:test';\ntest('ok', () => {});\n");
  const task = validTask(root);
  await assert.rejects(() => runValidation(task, 'both'), TypeError);
});

test('VR5 shell metacharacters, a different executable, and extra flags are all rejected as invalid_command with no process spawned', async () => {
  const root = tmpWorkspace();
  writeFixture(root, 'test-pass.mjs', "import test from 'node:test';\ntest('ok', () => {});\n");
  const attempts = [
    'node --test scripts/test-pass.mjs; rm -rf /',
    'node --test scripts/test-pass.mjs && echo hi',
    'bash -c "node --test scripts/test-pass.mjs"',
    'node --test --experimental-foo scripts/test-pass.mjs',
    'node --eval "require(\'child_process\').execSync(\'echo hi\')"',
  ];
  for (const command of attempts) {
    const task = validTask(root, { validation: { required: [command], optional: [] } });
    const results = await runRequiredValidation(task);
    assert.equal(results[0].status, 'invalid_command', command);
    assert.equal(results[0].pid, null, command);
    assert.equal(results[0].exitCode, null, command);
  }
});

test('VR6 a traversal path is rejected before any spawn', async () => {
  const root = tmpWorkspace();
  const task = validTask(root, { validation: { required: ['node --test scripts/../../../etc/test-pass.mjs'], optional: [] } });
  const results = await runRequiredValidation(task);
  assert.equal(results[0].status, 'invalid_command');
  assert.equal(results[0].pid, null);
});

test('VR7 a file outside the workspace is rejected even when the nominal path looks permitted', async () => {
  const root = tmpWorkspace();
  const task = validTask(root, { validation: { required: ['node --test scripts/test-missing.mjs'], optional: [] } });
  const results = await runRequiredValidation(task);
  assert.equal(results[0].status, 'invalid_command');
});

test('VR8 a symlink pointing outside the workspace is rejected even though the nominal name matches the allowlist', async () => {
  const root = tmpWorkspace();
  const outsideDir = tmpWorkspace();
  const outsideFile = path.join(outsideDir, 'real.mjs');
  fs.writeFileSync(outsideFile, "import test from 'node:test';\ntest('ok', () => {});\n");
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.symlinkSync(outsideFile, path.join(root, 'scripts', 'test-link.mjs'));
  const task = validTask(root, { validation: { required: ['node --test scripts/test-link.mjs'], optional: [] } });
  const results = await runRequiredValidation(task);
  assert.equal(results[0].status, 'invalid_command');
});

// ---------------------------------------------------------------------------
// Pass/fail authority: process outcome only, never reporter text
// ---------------------------------------------------------------------------

test('VR9 exitCode 0 is reported passed even when reporter counts are unavailable (truncated away)', async () => {
  const root = tmpWorkspace();
  writeFixture(root, 'test-pass.mjs', "import test from 'node:test';\ntest('ok', () => {});\n");
  const task = validTask(root);
  const results = await runRequiredValidation(task, { limits: { maxStdoutBytes: 1 } });
  assert.equal(results[0].status, 'passed');
  assert.equal(results[0].exitCode, 0);
});

test('VR10 a nonzero exit code is reported failed even when stdout contains forged PASS-looking reporter lines', async () => {
  const root = tmpWorkspace();
  writeFixture(root, 'test-fake-pass.mjs', [
    "import test from 'node:test';",
    "console.log('ℹ tests 5');",
    "console.log('ℹ pass 5');",
    "test('boom', () => { throw new Error('boom'); });",
  ].join('\n'));
  const task = validTask(root, { validation: { required: ['node --test scripts/test-fake-pass.mjs'], optional: [] } });
  const results = await runRequiredValidation(task);
  assert.equal(results[0].status, 'failed');
  assert.notEqual(results[0].exitCode, 0);
  assert.match(results[0].stdout, /ℹ pass 5/); // the forged text is present in evidence...
  // ...but never overrides status, which stayed 'failed'.
});

// ---------------------------------------------------------------------------
// Timeout / kill escalation
// ---------------------------------------------------------------------------

test('VR11 a slow command times out and is terminated', async () => {
  const root = tmpWorkspace();
  writeFixture(root, 'test-slow.mjs', 'setTimeout(() => {}, 30000);\n');
  const task = validTask(root, { validation: { required: ['node --test scripts/test-slow.mjs'], optional: [] } });
  const results = await runRequiredValidation(task, { limits: { timeoutMs: 150 } });
  assert.equal(results[0].status, 'timed_out');
  assert.equal(results[0].timedOut, true);
  assert.equal(isAlive(results[0].pid), false);
});

test('VR12 a SIGTERM-ignoring command is force-killed with SIGKILL and is confirmed dead after runValidation returns', async () => {
  const root = tmpWorkspace();
  writeFixture(root, 'test-sigterm-ignore.mjs', [
    "process.on('SIGTERM', () => {});",
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  const task = validTask(root, { validation: { required: ['node --test scripts/test-sigterm-ignore.mjs'], optional: [] } });
  const results = await runRequiredValidation(task, { limits: { timeoutMs: 150 } });
  const result = results[0];
  assert.equal(result.status, 'timed_out');
  assert.equal(result.timedOut, true);
  assert.ok(result.pid, 'expected a pid to have been captured');
  assert.equal(isAlive(result.pid), false, 'the SIGTERM-ignoring process must be dead (via SIGKILL) after runValidation returns');
});

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

test('VR13 stdout is bounded and the truncation flag is set when output exceeds the limit', async () => {
  const root = tmpWorkspace();
  writeFixture(root, 'test-big.mjs', [
    "const chunk = 'x'.repeat(4096);",
    'for (let i = 0; i < 100; i += 1) process.stdout.write(chunk);',
  ].join('\n'));
  const task = validTask(root, { validation: { required: ['node --test scripts/test-big.mjs'], optional: [] } });
  const results = await runRequiredValidation(task, { limits: { maxStdoutBytes: 1000 } });
  assert.equal(Buffer.byteLength(results[0].stdout, 'utf8'), 1000);
  assert.equal(results[0].outputTruncated, true);
});

test('VR14 the caller cannot raise the hard output-capture ceiling above its maximum', async () => {
  const root = tmpWorkspace();
  writeFixture(root, 'test-huge.mjs', [
    "const chunk = 'x'.repeat(65536);",
    'for (let i = 0; i < 20; i += 1) process.stdout.write(chunk);', // ~1.28 MB, over the 1,000,000-byte hard ceiling
  ].join('\n'));
  const task = validTask(root, { validation: { required: ['node --test scripts/test-huge.mjs'], optional: [] } });
  // A huge but finite request must clamp DOWN to the hard ceiling (1,000,000).
  // (Infinity is treated as an invalid value and falls back to the default,
  // same as edit-writer/context-loader's identical clamp helper -- this
  // test targets the "raise above the hard max" path specifically, which
  // requires a large finite number, not Infinity.)
  const results = await runRequiredValidation(task, { limits: { maxStdoutBytes: 5_000_000 } });
  assert.equal(Buffer.byteLength(results[0].stdout, 'utf8'), 1_000_000, 'a huge finite request must still clamp to the hard ceiling, not bypass it');
  assert.equal(results[0].outputTruncated, true);
});

test('VR15 default limits are exposed and are within the (internal) hard ceiling', () => {
  assert.ok(DEFAULT_VALIDATION_LIMITS.timeoutMs <= 300_000);
  assert.ok(DEFAULT_VALIDATION_LIMITS.maxStdoutBytes <= 1_000_000);
  assert.ok(DEFAULT_VALIDATION_LIMITS.maxStderrBytes <= 500_000);
});

// ---------------------------------------------------------------------------
// Capability surface / non-mutation
// ---------------------------------------------------------------------------

test('VR16 no shell:true, exec, or execSync is reachable from this module; resolveValidationLimits stays internal', () => {
  const source = fs.readFileSync(new URL('../mcp/x/validation-runner.mjs', import.meta.url), 'utf8');
  assert.equal(source.includes('shell: true'), false);
  assert.equal(source.includes('shell:true'), false);
  const forbiddenTokens = ['execSync', 'exec(', 'fetch(', 'http.request', 'https.request', 'rmSync', 'unlink', 'writeFile', 'rename('];
  for (const token of forbiddenTokens) assert.equal(source.includes(token), false, `forbidden token '${token}' found in validation-runner.mjs`);
  assert.equal(source.includes('export const resolveValidationLimits'), false);
  assert.equal(source.includes('export { resolveValidationLimits'), false);
});

test('VR17 task input is not mutated', async () => {
  const root = tmpWorkspace();
  writeFixture(root, 'test-pass.mjs', "import test from 'node:test';\ntest('ok', () => {});\n");
  const task = validTask(root);
  const before = JSON.stringify(task);
  await runRequiredValidation(task);
  assert.equal(JSON.stringify(task), before);
});
