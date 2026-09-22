import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HEARTH_JOB_VERSION,
  parseHearthJob,
  validateHearthJob,
} from '../mcp/router/hearth-job-contract.mjs';
import {
  routeHearthJob,
  adaptHearthJobToXTask,
  computeHearthJobFingerprint,
  hearthJobTaskId,
  hearthJobXRequestId,
} from '../mcp/router/router.mjs';

const codeJob = (overrides = {}) => ({
  version: HEARTH_JOB_VERSION,
  job_id: 'job-001',
  kind: 'code_change',
  title: 'Patch one file',
  objective: 'Fix the bug and keep the existing behavior intact.',
  problem: 'The current behavior is incorrect.',
  expected_behavior: 'The target path returns the expected result.',
  observed_behavior: 'The target path returns the wrong result.',
  why_this_matters: 'This is a regression.',
  known_evidence: ['A focused regression test reproduces the bug.'],
  suspected_area: ['src/example.ts'],
  scope: {
    allowed_paths: ['src/example.ts', 'scripts/test-example.mjs'],
    preferred_files: ['src/example.ts'],
    forbidden_paths: ['src/secrets'],
  },
  constraints: {
    preserve: ['Existing public API'],
    do_not: ['Do not commit or push'],
  },
  acceptance_criteria: ['Focused regression passes'],
  validation: {
    required: ['node --test scripts/test-example.mjs'],
    optional: [],
  },
  done_criteria: ['Regression passes and diff is scoped'],
  stop_conditions: ['Stop if the requested file is outside scope'],
  ...overrides,
});

test('P8.1 hearth-job-v1 normalizes a valid code job deterministically', () => {
  const first = parseHearthJob(codeJob());
  const second = parseHearthJob(structuredClone(codeJob()));
  assert.deepEqual(first, second);
  assert.equal(first.version, 'hearth-job-v1');
  assert.equal(first.kind, 'code_change');
  assert.deepEqual(first.scope.allowed_paths, ['src/example.ts', 'scripts/test-example.mjs']);
});

test('P8.2 unknown fields and worker/provider selection fail closed', () => {
  for (const field of ['worker', 'agent', 'provider', 'workspace', 'workspace_root', 'repair_budget']) {
    const result = validateHearthJob({ ...codeJob(), [field]: field === 'worker' ? 'codex' : 'value' });
    assert.equal(result.ok, false, field);
    assert.ok(result.errors.some((item) => item.path === field && item.code === 'UNKNOWN_FIELD'), field);
  }
});

test('P8.3 code jobs require explicit scope, acceptance criteria, and required validation', () => {
  for (const mutate of [
    (job) => { delete job.scope; },
    (job) => { job.scope.allowed_paths = []; },
    (job) => { delete job.acceptance_criteria; },
    (job) => { job.acceptance_criteria = []; },
    (job) => { delete job.validation; },
    (job) => { job.validation.required = []; },
  ]) {
    const job = codeJob();
    mutate(job);
    assert.equal(validateHearthJob(job).ok, false);
  }
});

test('P8.4 path traversal/absolute paths and allowed-forbidden overlap fail closed', () => {
  for (const pathValue of ['../outside.ts', '/tmp/outside.ts', 'src/../../outside.ts']) {
    const job = codeJob();
    job.scope.allowed_paths = [pathValue];
    assert.equal(validateHearthJob(job).ok, false);
  }
  const conflict = codeJob();
  conflict.scope.allowed_paths = ['src'];
  conflict.scope.forbidden_paths = ['src/secrets'];
  assert.equal(validateHearthJob(conflict).ok, false);
});

test('P8.5 deterministic router maps code jobs to X and rejects general', () => {
  assert.equal(routeHearthJob(codeJob()).route, 'x');
  assert.equal(routeHearthJob(codeJob({ kind: 'code_inspect' })).route, 'x');
  const general = {
    version: 'hearth-job-v1',
    job_id: 'general-1',
    kind: 'general',
    objective: 'Inspect the current situation and report a concise result.',
  };
  assert.throws(() => routeHearthJob(general), /hearth_job_route_unavailable/);
});

test('P8.6 X adapter produces a canonical valid x-task-v1 using Hearth-owned workspace', () => {
  const adapted = adaptHearthJobToXTask(codeJob(), {
    workspaceRoot: '/trusted/workspace',
    repo: 'trusted-repo',
  });
  assert.equal(adapted.version, 'x-task-v1');
  assert.equal(adapted.task_id, 'hearthjob:job-001');
  assert.deepEqual(adapted.workspace, { repo: 'trusted-repo', root: '/trusted/workspace' });
  assert.deepEqual(adapted.allowed_tools, ['repo_read', 'repo_edit']);
  assert.deepEqual(adapted.repair_budget, { initial_attempts: 1, max_repairs: 2, max_total_rounds: 3 });
  assert.deepEqual(adapted.commit_policy, { mode: 'never' });
  assert.equal(adapted.uncertainty_policy.policy, 'stop_and_report');
});

test('P8.7 code_inspect adapter cannot gain repo_edit authority', () => {
  const adapted = adaptHearthJobToXTask(codeJob({ kind: 'code_inspect' }), {
    workspaceRoot: '/trusted/workspace',
  });
  assert.deepEqual(adapted.allowed_tools, ['repo_read']);
});

test('P8.8 generic payload has no workspace authority and adapter rejects missing authoritative workspace', () => {
  const payload = codeJob();
  assert.equal(Object.hasOwn(payload, 'workspace'), false);
  assert.throws(() => adaptHearthJobToXTask(payload), /workspace_required/);
});

test('P8.9 generic fingerprint and route identities are deterministic', () => {
  const input = codeJob();
  assert.equal(computeHearthJobFingerprint(input), computeHearthJobFingerprint(structuredClone(input)));
  assert.equal(hearthJobTaskId('job-001'), 'hearthjob:job-001');
  assert.equal(hearthJobXRequestId('job-001'), 'hearthjob:job-001');
  assert.notEqual(computeHearthJobFingerprint(input), computeHearthJobFingerprint({ ...input, objective: 'Different' }));
});

test('P8.11 a general job does not require X-only scope or validation fields', () => {
  const result = validateHearthJob({
    version: 'hearth-job-v1',
    job_id: 'general-minimal',
    kind: 'general',
    objective: 'Summarize the current workspace status.',
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.scope, null);
  assert.deepEqual(result.value.validation, { required: [], optional: [] });
});

test('P8.12 generic text fields redact secret-shaped content before routing', () => {
  const parsed = parseHearthJob({
    version: 'hearth-job-v1',
    job_id: 'secret-redaction',
    kind: 'general',
    objective: 'Inspect this credential safely: Bearer abcdefghijklmnopqrstuvwxyz123456',
    known_evidence: ['{"token":"super-secret-token-value"}'],
  });
  const serialized = JSON.stringify(parsed);
  assert.doesNotMatch(serialized, /abcdefghijklmnopqrstuvwxyz123456/);
  assert.doesNotMatch(serialized, /super-secret-token-value/);
  assert.match(serialized, /REDACTED/);
});
