import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateResultGate, GATE_STATUSES, WAITING_REASONS } from '../mcp/x/result-gate.mjs';

/** Minimal RepairOutcome fixture builder -- mirrors the shape `finalize()` in repair-loop.mjs produces. */
const outcome = (status, rounds, blockers = []) => ({
  task_id: 'TASK-GATE-1',
  status,
  rounds,
  total_rounds: rounds.length,
  blockers,
});

const passedRequired = (commands) => commands.map((command) => ({ command, status: 'passed', exitCode: 0 }));
const failedRequired = (commands) => commands.map((command) => ({ command, status: 'failed', exitCode: 1 }));

const validationRound = (round, required, classification = null) => ({
  round, kind: 'validation',
  executor: { status: 'completed' },
  validation: { required, optional: [] },
  classification,
});

const executionRound = (round, executorStatus, blockerReason, classification, blockerCode = null) => ({
  round, kind: 'execution',
  executor: { status: executorStatus, blockers: [{ reason: blockerReason, code: blockerCode, detail: 'test detail' }] },
  validation: null,
  classification,
});

test('validated + real passing required evidence -> COMPLETED', () => {
  const result = evaluateResultGate(outcome('validated', [validationRound(1, passedRequired(['node --test scripts/test-a.mjs']))]));
  assert.equal(result.gate_status, 'COMPLETED');
  assert.equal(result.hearth_outcome, 'completed');
  assert.equal(result.reason_code, 'validated');
  assert.equal(result.waiting_reason, null);
});

test('validated + empty required array -> COMPLETED (empty required validation is valid evidence)', () => {
  const result = evaluateResultGate(outcome('validated', [validationRound(1, [])]));
  assert.equal(result.gate_status, 'COMPLETED');
  assert.equal(result.hearth_outcome, 'completed');
});

test('validated + zero rounds -> NEEDS_REVIEW', () => {
  const result = evaluateResultGate(outcome('validated', []));
  assert.equal(result.gate_status, 'NEEDS_REVIEW');
  assert.equal(result.hearth_outcome, 'waiting');
  assert.equal(result.reason_code, 'unrecognized_repair_outcome');
  assert.equal(result.waiting_reason, 'supervisor_review');
});

test('validated + final execution round -> NEEDS_REVIEW', () => {
  const result = evaluateResultGate(outcome('validated', [executionRound(1, 'completed', null, null)]));
  assert.equal(result.gate_status, 'NEEDS_REVIEW');
  assert.equal(result.reason_code, 'unrecognized_repair_outcome');
});

test('validated + required validation failed -> NEEDS_REVIEW', () => {
  const result = evaluateResultGate(outcome('validated', [validationRound(1, failedRequired(['node --test scripts/test-a.mjs']))]));
  assert.equal(result.gate_status, 'NEEDS_REVIEW');
  assert.equal(result.reason_code, 'unrecognized_repair_outcome');
});

test('validated + required validation timed_out -> NEEDS_REVIEW', () => {
  const timedOut = [{ command: 'node --test scripts/test-a.mjs', status: 'timed_out', exitCode: null }];
  const result = evaluateResultGate(outcome('validated', [validationRound(1, timedOut)]));
  assert.equal(result.gate_status, 'NEEDS_REVIEW');
  assert.equal(result.reason_code, 'unrecognized_repair_outcome');
});

test('validated + unexpected top-level blocker -> NEEDS_REVIEW', () => {
  const result = evaluateResultGate(outcome(
    'validated',
    [validationRound(1, passedRequired(['node --test scripts/test-a.mjs']))],
    [{ reason: 'some_future_blocker', detail: 'unexpected' }],
  ));
  assert.equal(result.gate_status, 'NEEDS_REVIEW');
  assert.equal(result.reason_code, 'unrecognized_repair_outcome');
});

test('escalation_required: invalid_task_scope -> FAILED', () => {
  const result = evaluateResultGate(outcome('escalation_required', [], [{ reason: 'invalid_task_scope', detail: 'scope error' }]));
  assert.equal(result.gate_status, 'FAILED');
  assert.equal(result.hearth_outcome, 'error');
  assert.equal(result.reason_code, 'invalid_task_scope');
  assert.equal(result.waiting_reason, null);
});

test('escalation_required: invalid_validation_command -> FAILED', () => {
  const rounds = [validationRound(1, [{ command: 'rm -rf /', status: 'invalid_command', exitCode: null }], 'escalate')];
  const result = evaluateResultGate(outcome('escalation_required', rounds, [{ reason: 'invalid_validation_command', detail: 'bad command' }]));
  assert.equal(result.gate_status, 'FAILED');
  assert.equal(result.reason_code, 'invalid_validation_command');
});

test('escalation_required: unrecognized top-level blocker reason -> NEEDS_REVIEW, does not fall through to round classification', () => {
  // The last round here looks like a clean structural FAILED (PATH_REJECTED)
  // on its own -- if the gate incorrectly fell through past the unknown
  // top-level blocker, it would wrongly report FAILED instead of NEEDS_REVIEW.
  const rounds = [executionRound(1, 'blocked', 'write_failed', 'escalate', 'PATH_REJECTED')];
  const result = evaluateResultGate(outcome('escalation_required', rounds, [{ reason: 'some_future_blocker', detail: 'unknown' }]));
  assert.equal(result.gate_status, 'NEEDS_REVIEW');
  assert.equal(result.reason_code, 'unrecognized_repair_outcome');
  assert.equal(result.waiting_reason, 'supervisor_review');
});

for (const code of ['PATH_REJECTED', 'INVALID_SCOPE', 'WRITE_FAILED', 'UNREADABLE_TARGET']) {
  test(`escalation_required: execution blocker ${code} -> FAILED`, () => {
    const rounds = [executionRound(1, 'blocked', 'write_failed', 'escalate', code)];
    const result = evaluateResultGate(outcome('escalation_required', rounds));
    assert.equal(result.gate_status, 'FAILED');
    assert.equal(result.hearth_outcome, 'error');
    assert.equal(result.reason_code, code);
    assert.equal(result.waiting_reason, null);
  });
}

for (const reason of ['context_load_failed', 'schema_invalid', 'unsupported_action', 'missing_field', 'too_many_actions', 'too_many_files']) {
  test(`escalation_required: execution blocker reason ${reason} (no code) -> FAILED`, () => {
    const rounds = [executionRound(1, 'blocked', reason, 'escalate')];
    const result = evaluateResultGate(outcome('escalation_required', rounds));
    assert.equal(result.gate_status, 'FAILED');
    assert.equal(result.reason_code, reason);
  });
}

for (const code of ['PROTECTED_PATH', 'SYMLINK_ESCAPE']) {
  test(`escalation_required: safety-boundary code ${code} -> NEEDS_REVIEW/safety_boundary_review`, () => {
    const rounds = [executionRound(1, 'blocked', 'write_failed', 'escalate', code)];
    const result = evaluateResultGate(outcome('escalation_required', rounds));
    assert.equal(result.gate_status, 'NEEDS_REVIEW');
    assert.equal(result.hearth_outcome, 'waiting');
    assert.equal(result.reason_code, 'safety_boundary_review');
    assert.equal(result.waiting_reason, 'supervisor_review');
  });
}

test('escalation_required: model_request_failed exhaustion -> NEEDS_REVIEW/external_dependency', () => {
  const rounds = [executionRound(3, 'blocked', 'model_request_failed', 'repairable')];
  const result = evaluateResultGate(outcome('escalation_required', rounds));
  assert.equal(result.gate_status, 'NEEDS_REVIEW');
  assert.equal(result.reason_code, 'model_unavailable_after_repair');
  assert.equal(result.waiting_reason, 'external_dependency');
});

for (const reason of ['PRECONDITION_FAILED', 'WRITE_LIMIT_EXCEEDED', 'malformed_json', 'response_too_large']) {
  test(`escalation_required: repairable execution exhaustion (${reason}) -> NEEDS_REVIEW/supervisor_review`, () => {
    const rounds = [executionRound(3, 'blocked', reason, 'repairable')];
    const result = evaluateResultGate(outcome('escalation_required', rounds));
    assert.equal(result.gate_status, 'NEEDS_REVIEW');
    assert.equal(result.reason_code, 'repair_budget_exhausted_transient');
    assert.equal(result.waiting_reason, 'supervisor_review');
  });
}

test('escalation_required: required validation still failing after repair exhaustion -> NEEDS_REVIEW/supervisor_review (not FAILED)', () => {
  const rounds = [validationRound(3, failedRequired(['node --test scripts/test-a.mjs']), 'repairable')];
  const result = evaluateResultGate(outcome('escalation_required', rounds));
  assert.equal(result.gate_status, 'NEEDS_REVIEW');
  assert.equal(result.hearth_outcome, 'waiting');
  assert.equal(result.reason_code, 'repair_budget_exhausted_transient');
  assert.equal(result.waiting_reason, 'supervisor_review');
});

test('escalation_required: unknown/future execution blocker code -> NEEDS_REVIEW (fail closed, not FAILED)', () => {
  const rounds = [executionRound(1, 'blocked', 'write_failed', 'escalate', 'SOME_FUTURE_CODE')];
  const result = evaluateResultGate(outcome('escalation_required', rounds));
  assert.equal(result.gate_status, 'NEEDS_REVIEW');
  assert.equal(result.reason_code, 'unrecognized_repair_outcome');
  assert.equal(result.waiting_reason, 'supervisor_review');
});

test('escalation_required: no rounds and no top-level blocker -> NEEDS_REVIEW (fail closed)', () => {
  const result = evaluateResultGate(outcome('escalation_required', []));
  assert.equal(result.gate_status, 'NEEDS_REVIEW');
  assert.equal(result.reason_code, 'unrecognized_repair_outcome');
});

test('malformed input: not an object -> TypeError', () => {
  assert.throws(() => evaluateResultGate(null), TypeError);
  assert.throws(() => evaluateResultGate('validated'), TypeError);
});

test('malformed input: unknown status -> TypeError', () => {
  assert.throws(() => evaluateResultGate({ status: 'done', rounds: [], blockers: [] }), TypeError);
});

test('malformed input: rounds not an array -> TypeError', () => {
  assert.throws(() => evaluateResultGate({ status: 'validated', rounds: null, blockers: [] }), TypeError);
});

test('malformed input: blockers not an array -> TypeError', () => {
  assert.throws(() => evaluateResultGate({ status: 'validated', rounds: [], blockers: null }), TypeError);
});

test('exact gate/hearth bijection holds across every gate status this module can emit', () => {
  const cases = [
    outcome('validated', [validationRound(1, passedRequired(['node --test scripts/test-a.mjs']))]),
    outcome('escalation_required', [], [{ reason: 'invalid_task_scope', detail: 'x' }]),
    outcome('escalation_required', [executionRound(3, 'blocked', 'model_request_failed', 'repairable')]),
  ];
  const seen = new Set();
  for (const repairOutcome of cases) {
    const result = evaluateResultGate(repairOutcome);
    seen.add(result.gate_status);
    assert.ok(GATE_STATUSES.includes(result.gate_status));
    if (result.gate_status === 'COMPLETED') assert.equal(result.hearth_outcome, 'completed');
    if (result.gate_status === 'NEEDS_REVIEW') assert.equal(result.hearth_outcome, 'waiting');
    if (result.gate_status === 'FAILED') assert.equal(result.hearth_outcome, 'error');
    // waiting_reason is non-null iff hearth_outcome === 'waiting'.
    if (result.hearth_outcome === 'waiting') {
      assert.ok(WAITING_REASONS.includes(result.waiting_reason));
    } else {
      assert.equal(result.waiting_reason, null);
    }
  }
  assert.deepEqual([...seen].sort(), ['COMPLETED', 'FAILED', 'NEEDS_REVIEW']);
});

test('returned result is frozen and the input RepairOutcome is not mutated', () => {
  const input = outcome('validated', [validationRound(1, passedRequired(['node --test scripts/test-a.mjs']))]);
  const snapshot = JSON.parse(JSON.stringify(input));
  const result = evaluateResultGate(input);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.evidence));
  assert.deepEqual(JSON.parse(JSON.stringify(input)), snapshot);
});
