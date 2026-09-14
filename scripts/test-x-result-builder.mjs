import assert from 'node:assert/strict';
import test from 'node:test';
import { buildXResult, X_RESULT_VERSION } from '../mcp/x/result-builder.mjs';
import { evaluateResultGate } from '../mcp/x/result-gate.mjs';

/** Minimal x-task-v1-shaped fixture -- only the fields buildXResult actually reads. */
const baseTask = (overrides = {}) => ({
  task_id: 'TASK-RESULT-1',
  parent_task_id: null,
  revision: 1,
  attempt: 1,
  known_evidence: [],
  validation: { required: ['node --test scripts/test-a.mjs'], optional: ['node --test scripts/test-b.mjs'] },
  timing: { estimated_minutes: 10, first_check_after_minutes: 1, soft_deadline_minutes: 5, hard_timeout_minutes: 15 },
  ...overrides,
});

const outcome = (taskId, status, rounds, blockers = []) => ({
  task_id: taskId,
  status,
  rounds,
  total_rounds: rounds.length,
  blockers,
});

const vres = (command, status, extra = {}) => ({
  command,
  status,
  exitCode: extra.exitCode ?? (status === 'passed' ? 0 : status === 'timed_out' ? null : 1),
  durationMs: extra.durationMs ?? 10,
  summary: extra.summary ?? `${command}: ${status}`,
});

const validationRound = (round, required, optional = [], classification = null, executorOverrides = {}) => ({
  round,
  kind: 'validation',
  executor: { status: 'completed', files_changed: [], changes: [], blockers: [], ...executorOverrides },
  validation: { required, optional },
  classification,
});

const executionRound = (round, executorStatus, blocker, classification, executorOverrides = {}) => ({
  round,
  kind: 'execution',
  executor: {
    status: executorStatus,
    files_changed: [],
    changes: [],
    blockers: blocker ? [blocker] : [],
    ...executorOverrides,
  },
  validation: null,
  classification,
});

/** Runs the real Phase 8 gate against a fixture so tests never hand-author a gateResult shape that might drift from what Phase 8 actually produces. */
const gateFor = (repairOutcome) => evaluateResultGate(repairOutcome);

test('COMPLETED: passing final validation round produces a well-formed x-result-v1', () => {
  const task = baseTask();
  const ro = outcome(task.task_id, 'validated', [validationRound(1, [vres('node --test scripts/test-a.mjs', 'passed')], [vres('node --test scripts/test-b.mjs', 'passed')])]);
  const gate = gateFor(ro);
  const result = buildXResult(task, ro, gate);

  assert.equal(result.version, X_RESULT_VERSION);
  assert.equal(result.task_id, task.task_id);
  assert.equal(result.gate_status, 'COMPLETED');
  assert.equal(result.hearth_outcome, 'completed');
  assert.equal(result.waiting_reason, null);
  assert.equal(result.reason_code, gate.reason_code);
  assert.equal(result.commit.created, false);
  assert.equal(result.commit.sha, null);
  assert.equal(result.root_cause, null);
  assert.equal(result.why_fix_works, null);
  assert.equal(result.lesson_candidate, null);
  assert.deepEqual(result.remaining_risks, []);
  // Locked naming: next_recommended_action / timing, never next_action / timings.
  assert.ok('next_recommended_action' in result);
  assert.ok(!('next_action' in result));
  assert.ok('timing' in result);
  assert.ok(!('timings' in result));
});

test('regression: Round 1 validation failed, Round 2 terminal execution escalation -> validation entries are all not_run, never copied from Round 1', () => {
  const task = baseTask({ validation: { required: ['node --test scripts/test-a.mjs'], optional: [] } });
  const rounds = [
    validationRound(1, [vres('node --test scripts/test-a.mjs', 'failed')], [], 'repairable'),
    executionRound(2, 'blocked', { reason: 'schema_invalid', code: null, detail: 'bad json' }, 'escalate'),
  ];
  const ro = outcome(task.task_id, 'escalation_required', rounds);
  const gate = gateFor(ro);
  const result = buildXResult(task, ro, gate);

  assert.equal(result.validation.length, 1);
  assert.equal(result.validation[0].name, 'node --test scripts/test-a.mjs');
  assert.equal(result.validation[0].status, 'not_run');
  assert.equal(result.validation[0].exit_code, null);
  assert.equal(result.validation[0].failure_origin, null);
});

test('final validation round normalization: passed maps to passed with exit_code and null failure_origin', () => {
  const task = baseTask({ validation: { required: ['node --test scripts/test-a.mjs'], optional: [] } });
  const ro = outcome(task.task_id, 'validated', [validationRound(1, [vres('node --test scripts/test-a.mjs', 'passed', { exitCode: 0 })])]);
  const gate = gateFor(ro);
  const result = buildXResult(task, ro, gate);
  assert.deepEqual(result.validation[0], { name: 'node --test scripts/test-a.mjs', required: true, status: 'passed', exit_code: 0, failure_origin: null, stdout_ref: null, stderr_ref: null });
});

test('timed_out validation result normalizes to failed with failure_origin unknown', () => {
  const task = baseTask({ validation: { required: ['node --test scripts/test-a.mjs'], optional: [] } });
  const rounds = [validationRound(3, [vres('node --test scripts/test-a.mjs', 'timed_out', { exitCode: null })], [], 'repairable')];
  const ro = outcome(task.task_id, 'escalation_required', rounds);
  const gate = gateFor(ro);
  const result = buildXResult(task, ro, gate);
  assert.equal(result.validation[0].status, 'failed');
  assert.equal(result.validation[0].failure_origin, 'unknown');
  assert.equal(result.validation[0].exit_code, null);
});

test('invalid_command validation result normalizes to failed', () => {
  const task = baseTask({ validation: { required: ['rm -rf /'], optional: [] } });
  const rounds = [validationRound(1, [vres('rm -rf /', 'invalid_command', { exitCode: null })], [], 'escalate')];
  const ro = outcome(task.task_id, 'escalation_required', rounds, [{ reason: 'invalid_validation_command', detail: 'bad command' }]);
  const gate = gateFor(ro);
  const result = buildXResult(task, ro, gate);
  assert.equal(result.validation[0].status, 'failed');
  assert.equal(result.validation[0].failure_origin, 'unknown');
});

test('optional command not_run when required failed and optional never ran', () => {
  const task = baseTask({ validation: { required: ['node --test scripts/test-a.mjs'], optional: ['node --test scripts/test-b.mjs'] } });
  // Optional never ran (repair-loop only runs optional after required passes) -- validation.optional is [].
  const rounds = [validationRound(1, [vres('node --test scripts/test-a.mjs', 'failed')], [], 'repairable')];
  const ro = outcome(task.task_id, 'escalation_required', rounds);
  const gate = gateFor(ro);
  const result = buildXResult(task, ro, gate);
  const optionalEntry = result.validation.find((v) => v.name === 'node --test scripts/test-b.mjs');
  assert.equal(optionalEntry.required, false);
  assert.equal(optionalEntry.status, 'not_run');
});

test('repair_attempts is total_rounds - 1, floored at 0', () => {
  const task = baseTask();
  for (const totalRounds of [1, 2, 3]) {
    const rounds = Array.from({ length: totalRounds }, (_, i) =>
      i === totalRounds - 1
        ? validationRound(i + 1, [vres('node --test scripts/test-a.mjs', 'passed')])
        : executionRound(i + 1, 'blocked', { reason: 'model_request_failed', code: null, detail: 'timeout' }, 'repairable'));
    const ro = outcome(task.task_id, 'validated', rounds);
    const gate = gateFor(ro);
    const result = buildXResult(task, ro, gate);
    assert.equal(result.repair_attempts, totalRounds - 1, `total_rounds=${totalRounds}`);
  }
});

test('files_changed dedupes across multiple rounds', () => {
  const task = baseTask();
  const rounds = [
    executionRound(1, 'blocked', { reason: 'model_request_failed', code: null, detail: 'x' }, 'repairable', { files_changed: ['src/a.js', 'src/b.js'] }),
    validationRound(2, [vres('node --test scripts/test-a.mjs', 'passed')], [], null, { files_changed: ['src/b.js', 'src/c.js'] }),
  ];
  const ro = outcome(task.task_id, 'validated', rounds);
  const gate = gateFor(ro);
  const result = buildXResult(task, ro, gate);
  assert.deepEqual([...result.files_changed].sort(), ['src/a.js', 'src/b.js', 'src/c.js']);
  assert.equal(result.final_diff_summary.files_changed, 3);
  assert.equal(result.final_diff_summary.insertions, null);
  assert.equal(result.final_diff_summary.deletions, null);
});

test('commit is always the fixed no-op shape', () => {
  const task = baseTask();
  const ro = outcome(task.task_id, 'validated', [validationRound(1, [vres('node --test scripts/test-a.mjs', 'passed')])]);
  const gate = gateFor(ro);
  const result = buildXResult(task, ro, gate);
  assert.deepEqual(result.commit, { created: false, sha: null, branch: null });
});

test('timing.validation_minutes sums durationMs across ALL rounds, not only the final one', () => {
  const task = baseTask();
  const rounds = [
    validationRound(1, [vres('node --test scripts/test-a.mjs', 'failed', { durationMs: 30_000 })], [], 'repairable'),
    executionRound(2, 'blocked', { reason: 'model_request_failed', code: null, detail: 'x' }, 'repairable'),
    validationRound(3, [vres('node --test scripts/test-a.mjs', 'passed', { durationMs: 30_000 })]),
  ];
  const ro = outcome(task.task_id, 'validated', rounds);
  const gate = gateFor(ro);
  const result = buildXResult(task, ro, gate);
  assert.equal(result.timing.validation_minutes, 1); // 60,000ms total / 60,000
  assert.equal(result.timing.actual_minutes, null);
  assert.equal(result.timing.repair_minutes, null);
  assert.equal(result.timing.estimated_minutes, 10);
});

test('timing.validation_minutes is null when no validation round ever ran', () => {
  const task = baseTask();
  const ro = outcome(task.task_id, 'escalation_required', [executionRound(1, 'blocked', { reason: 'schema_invalid', code: null, detail: 'x' }, 'escalate')]);
  const gate = gateFor(ro);
  const result = buildXResult(task, ro, gate);
  assert.equal(result.timing.validation_minutes, null);
});

test('bounds: change_summary entry count is capped', () => {
  const task = baseTask();
  const changes = Array.from({ length: 250 }, (_, i) => ({ operation: 'create', path: `src/file-${i}.js`, status: 'ok' }));
  const rounds = [validationRound(1, [vres('node --test scripts/test-a.mjs', 'passed')], [], null, { changes })];
  const ro = outcome(task.task_id, 'validated', rounds);
  const gate = gateFor(ro);
  const result = buildXResult(task, ro, gate);
  assert.ok(result.change_summary.length <= 100);
});

test('bounds: change_summary string fields (operation/path/status) are truncated', () => {
  const task = baseTask();
  const changes = [{ operation: 'create', path: 'x'.repeat(5000), status: 'ok' }];
  const rounds = [validationRound(1, [vres('node --test scripts/test-a.mjs', 'passed')], [], null, { changes })];
  const ro = outcome(task.task_id, 'validated', rounds);
  const gate = gateFor(ro);
  const result = buildXResult(task, ro, gate);
  assert.ok(Buffer.byteLength(result.change_summary[0].path, 'utf8') <= 500);
});

test('bounds: evidence_found entry count and per-entry byte size are capped', () => {
  const task = baseTask({ known_evidence: Array.from({ length: 200 }, (_, i) => `evidence-${i}-${'x'.repeat(2000)}`) });
  const ro = outcome(task.task_id, 'validated', [validationRound(1, [vres('node --test scripts/test-a.mjs', 'passed')])]);
  const gate = gateFor(ro);
  const result = buildXResult(task, ro, gate);
  assert.ok(result.evidence_found.length <= 50);
  for (const entry of result.evidence_found) {
    assert.ok(Buffer.byteLength(entry, 'utf8') <= 500);
  }
});

test('exact gate fields pass through verbatim from gateResult', () => {
  const task = baseTask();
  const ro = outcome(task.task_id, 'escalation_required', [executionRound(1, 'blocked', { reason: 'write_failed', code: 'PROTECTED_PATH', detail: 'blocked' }, 'escalate')]);
  const gate = gateFor(ro);
  const result = buildXResult(task, ro, gate);
  assert.equal(result.gate_status, gate.gate_status);
  assert.equal(result.hearth_outcome, gate.hearth_outcome);
  assert.equal(result.reason_code, gate.reason_code);
  assert.equal(result.waiting_reason, gate.waiting_reason);
});

test('result_id: defaults to a unique crypto.randomUUID() per call', () => {
  const task = baseTask();
  const ro = outcome(task.task_id, 'validated', [validationRound(1, [vres('node --test scripts/test-a.mjs', 'passed')])]);
  const gate = gateFor(ro);
  const a = buildXResult(task, ro, gate);
  const b = buildXResult(task, ro, gate);
  assert.notEqual(a.result_id, b.result_id);
  assert.match(a.result_id, /^[0-9a-f-]{36}$/);
});

test('result_id: an injected override is used verbatim', () => {
  const task = baseTask();
  const ro = outcome(task.task_id, 'validated', [validationRound(1, [vres('node --test scripts/test-a.mjs', 'passed')])]);
  const gate = gateFor(ro);
  const result = buildXResult(task, ro, gate, { resultId: 'fixed-result-id-1' });
  assert.equal(result.result_id, 'fixed-result-id-1');
});

test('result_id: an empty injected override throws TypeError', () => {
  const task = baseTask();
  const ro = outcome(task.task_id, 'validated', [validationRound(1, [vres('node --test scripts/test-a.mjs', 'passed')])]);
  const gate = gateFor(ro);
  assert.throws(() => buildXResult(task, ro, gate, { resultId: '' }), TypeError);
});

// --- Cross-input correlation ---------------------------------------------

test('cross-input: repairOutcome.task_id mismatch -> TypeError', () => {
  const task = baseTask();
  const ro = outcome('SOME-OTHER-TASK', 'validated', [validationRound(1, [vres('node --test scripts/test-a.mjs', 'passed')])]);
  const gate = gateFor(ro);
  assert.throws(() => buildXResult(task, ro, gate), TypeError);
});

test('cross-input: gateResult.evidence.task_id mismatch -> TypeError', () => {
  const task = baseTask();
  const ro = outcome(task.task_id, 'validated', [validationRound(1, [vres('node --test scripts/test-a.mjs', 'passed')])]);
  const gate = gateFor(ro);
  const mismatchedGate = { ...gate, evidence: { ...gate.evidence, task_id: 'SOME-OTHER-TASK' } };
  assert.throws(() => buildXResult(task, ro, mismatchedGate), TypeError);
});

test('cross-input: total_rounds !== rounds.length -> TypeError', () => {
  const task = baseTask();
  const ro = outcome(task.task_id, 'validated', [validationRound(1, [vres('node --test scripts/test-a.mjs', 'passed')])]);
  const gate = gateFor(ro);
  const malformed = { ...ro, total_rounds: 99 };
  assert.throws(() => buildXResult(task, malformed, gate), TypeError);
});

// --- Bijection re-validation -----------------------------------------------

test('bijection: gate_status COMPLETED with hearth_outcome waiting -> TypeError', () => {
  const task = baseTask();
  const ro = outcome(task.task_id, 'validated', [validationRound(1, [vres('node --test scripts/test-a.mjs', 'passed')])]);
  const gate = gateFor(ro);
  const inconsistent = { ...gate, gate_status: 'COMPLETED', hearth_outcome: 'waiting' };
  assert.throws(() => buildXResult(task, ro, inconsistent), TypeError);
});

test('bijection: gate_status FAILED with hearth_outcome completed -> TypeError', () => {
  const task = baseTask();
  const ro = outcome(task.task_id, 'escalation_required', [executionRound(1, 'blocked', { reason: 'schema_invalid', code: null, detail: 'x' }, 'escalate')]);
  const gate = gateFor(ro);
  const inconsistent = { ...gate, gate_status: 'FAILED', hearth_outcome: 'completed' };
  assert.throws(() => buildXResult(task, ro, inconsistent), TypeError);
});

test('bijection: hearth_outcome waiting with null waiting_reason -> TypeError', () => {
  const task = baseTask();
  const ro = outcome(task.task_id, 'escalation_required', [executionRound(3, 'blocked', { reason: 'model_request_failed', code: null, detail: 'x' }, 'repairable')]);
  const gate = gateFor(ro);
  const inconsistent = { ...gate, waiting_reason: null };
  assert.throws(() => buildXResult(task, ro, inconsistent), TypeError);
});

test('bijection: hearth_outcome completed with a non-null waiting_reason -> TypeError', () => {
  const task = baseTask();
  const ro = outcome(task.task_id, 'validated', [validationRound(1, [vres('node --test scripts/test-a.mjs', 'passed')])]);
  const gate = gateFor(ro);
  const inconsistent = { ...gate, waiting_reason: 'supervisor_review' };
  assert.throws(() => buildXResult(task, ro, inconsistent), TypeError);
});

test('bijection: hearth_outcome error with a non-null waiting_reason -> TypeError', () => {
  const task = baseTask();
  const ro = outcome(task.task_id, 'escalation_required', [executionRound(1, 'blocked', { reason: 'schema_invalid', code: null, detail: 'x' }, 'escalate')]);
  const gate = gateFor(ro);
  const inconsistent = { ...gate, waiting_reason: 'supervisor_review' };
  assert.throws(() => buildXResult(task, ro, inconsistent), TypeError);
});

// --- Malformed inputs -------------------------------------------------------

test('malformed task -> TypeError', () => {
  const ro = outcome('T', 'validated', [validationRound(1, [vres('node --test scripts/test-a.mjs', 'passed')])]);
  const gate = gateFor(ro);
  assert.throws(() => buildXResult(null, ro, gate), TypeError);
  assert.throws(() => buildXResult({ task_id: '' }, ro, gate), TypeError);
});

test('malformed repairOutcome -> TypeError', () => {
  const task = baseTask();
  const gate = gateFor(outcome(task.task_id, 'validated', [validationRound(1, [vres('node --test scripts/test-a.mjs', 'passed')])]));
  assert.throws(() => buildXResult(task, null, gate), TypeError);
  assert.throws(() => buildXResult(task, { status: 'done', rounds: [], blockers: [], total_rounds: 0 }, gate), TypeError);
});

test('malformed gateResult -> TypeError', () => {
  const task = baseTask();
  const ro = outcome(task.task_id, 'validated', [validationRound(1, [vres('node --test scripts/test-a.mjs', 'passed')])]);
  assert.throws(() => buildXResult(task, ro, null), TypeError);
  assert.throws(() => buildXResult(task, ro, { gate_status: 'NOT_A_STATUS', hearth_outcome: 'completed', reason_code: 'x', waiting_reason: null }), TypeError);
});

// --- Immutability ------------------------------------------------------------

test('returned result is deeply frozen and none of the three inputs are mutated', () => {
  const task = baseTask({ known_evidence: ['seed evidence'] });
  const rounds = [validationRound(1, [vres('node --test scripts/test-a.mjs', 'passed')], [], null, { files_changed: ['src/a.js'], changes: [{ operation: 'create', path: 'src/a.js', status: 'ok' }] })];
  const ro = outcome(task.task_id, 'validated', rounds);
  const gate = gateFor(ro);
  const taskSnapshot = JSON.parse(JSON.stringify(task));
  const roSnapshot = JSON.parse(JSON.stringify(ro));
  const gateSnapshot = JSON.parse(JSON.stringify(gate));

  const result = buildXResult(task, ro, gate);

  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.evidence_found));
  assert.ok(Object.isFrozen(result.files_changed));
  assert.ok(Object.isFrozen(result.change_summary));
  assert.ok(Object.isFrozen(result.validation));
  assert.ok(Object.isFrozen(result.validation[0]));
  assert.ok(Object.isFrozen(result.blockers));
  assert.ok(Object.isFrozen(result.final_diff_summary));
  assert.ok(Object.isFrozen(result.commit));
  assert.ok(Object.isFrozen(result.timing));
  assert.ok(Object.isFrozen(result.remaining_risks));

  assert.deepEqual(JSON.parse(JSON.stringify(task)), taskSnapshot);
  assert.deepEqual(JSON.parse(JSON.stringify(ro)), roSnapshot);
  assert.deepEqual(JSON.parse(JSON.stringify(gate)), gateSnapshot);
});

// --- Outbound secret sanitization -------------------------------------------

test('secret redaction: Bearer token in task.known_evidence is redacted in evidence_found', () => {
  const task = baseTask({ known_evidence: ['auth uses Bearer abc123.def456-XYZ for the API call'] });
  const ro = outcome(task.task_id, 'validated', [validationRound(1, [vres('node --test scripts/test-a.mjs', 'passed')])]);
  const gate = gateFor(ro);
  const result = buildXResult(task, ro, gate);
  const joined = result.evidence_found.join('\n');
  assert.ok(!joined.includes('abc123.def456-XYZ'));
  assert.ok(joined.includes('Bearer [REDACTED]'));
});

test('secret redaction: a JWT in a validation summary is redacted in evidence_found', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dGhpc2lzYXNlY3JldA';
  const task = baseTask({ validation: { required: ['node --test scripts/test-a.mjs'], optional: [] } });
  const ro = outcome(task.task_id, 'validated', [validationRound(1, [vres('node --test scripts/test-a.mjs', 'passed', { summary: `node --test scripts/test-a.mjs: passed; token=${jwt}` })])]);
  const gate = gateFor(ro);
  const result = buildXResult(task, ro, gate);
  const joined = result.evidence_found.join('\n');
  assert.ok(!joined.includes(jwt));
  assert.ok(joined.includes('[REDACTED_JWT]'));
});

test('secret redaction: a secret in an execution blocker detail is redacted in evidence_found and blockers', () => {
  const task = baseTask();
  const rounds = [executionRound(1, 'blocked', { reason: 'write_failed', code: 'WRITE_FAILED', detail: 'config had "api_key": "sk-abcdefghijklmnopqrstuvwxyz123456"' }, 'escalate')];
  const ro = outcome(task.task_id, 'escalation_required', rounds);
  const gate = gateFor(ro);
  const result = buildXResult(task, ro, gate);
  const joined = JSON.stringify(result);
  assert.ok(!joined.includes('sk-abcdefghijklmnopqrstuvwxyz123456'));
});

test('secret redaction: PEM-shaped evidence in known_evidence is redacted', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK...\n-----END RSA PRIVATE KEY-----';
  const task = baseTask({ known_evidence: [`found leaked key: ${pem}`] });
  const ro = outcome(task.task_id, 'validated', [validationRound(1, [vres('node --test scripts/test-a.mjs', 'passed')])]);
  const gate = gateFor(ro);
  const result = buildXResult(task, ro, gate);
  const joined = result.evidence_found.join('\n');
  assert.ok(!joined.includes('MIIBOgIBAAJBAK'));
  assert.ok(joined.includes('[REDACTED_PRIVATE_KEY]'));
});

test('secret redaction: a secret in repairOutcome top-level blockers[].detail is absent from the full serialized result', () => {
  const task = baseTask();
  const ro = outcome(task.task_id, 'escalation_required', [], [{ reason: 'invalid_task_scope', detail: 'scope error near Bearer zzz999-token-value' }]);
  const gate = gateFor(ro);
  const result = buildXResult(task, ro, gate);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('zzz999-token-value'));
});

test('secret redaction: a secret in gateResult.evidence.blocker.detail is absent from the full serialized result', () => {
  const task = baseTask();
  const ro = outcome(task.task_id, 'escalation_required', [executionRound(1, 'blocked', { reason: 'write_failed', code: 'PATH_REJECTED', detail: '"password": "hunter2-super-secret-value"' }, 'escalate')]);
  const gate = gateFor(ro);
  assert.ok(gate.evidence.blocker.detail.includes('hunter2-super-secret-value')); // sanity: Phase 8 itself does not redact
  const result = buildXResult(task, ro, gate);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('hunter2-super-secret-value'));
});

test('secret redaction: no secret shape survives anywhere in JSON.stringify(result) for a mixed multi-source case', () => {
  const task = baseTask({ known_evidence: ['Bearer top-secret-known-evidence-token'] });
  const rounds = [
    validationRound(1, [vres('node --test scripts/test-a.mjs', 'failed', { summary: 'failed; api_key=sk-zzzzzzzzzzzzzzzzzzzzzzzzz' })], [], 'repairable'),
    executionRound(2, 'blocked', { reason: 'write_failed', code: 'WRITE_FAILED', detail: '"token": "final-round-secret-value"' }, 'escalate'),
  ];
  const ro = outcome(task.task_id, 'escalation_required', rounds, [{ reason: 'invalid_task_scope', detail: 'Bearer scope-blocker-secret' }]);
  const gate = gateFor(ro);
  const result = buildXResult(task, ro, gate);
  const serialized = JSON.stringify(result);
  for (const secret of ['top-secret-known-evidence-token', 'sk-zzzzzzzzzzzzzzzzzzzzzzzzz', 'final-round-secret-value', 'scope-blocker-secret']) {
    assert.ok(!serialized.includes(secret), `expected "${secret}" to be redacted`);
  }
});
