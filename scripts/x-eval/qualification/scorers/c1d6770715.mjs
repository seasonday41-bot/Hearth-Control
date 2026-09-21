// Gold v1.1 (promoted from the proposal after the Qwen baseline found a hole). Hidden scorer: X result gate must collapse the 10 known structural execution
// failures to ONE stable reason_code while preserving the raw identifier in
// evidence. Independent of the visible test: drives the gate AND buildXResult,
// and adds negative controls the visible test does not assert together.
import assert from 'node:assert/strict';
import { createScorer, parseRoot, load } from './_lib.mjs';

const root = parseRoot();
const s = createScorer();
let gateMod; let builderMod;
await s.check('load result-gate + result-builder', async () => {
  gateMod = await load(root, 'mcp/x/result-gate.mjs');
  builderMod = await load(root, 'mcp/x/result-builder.mjs');
});
if (!gateMod || !builderMod) s.finish();

const STABLE = 'structural_execution_failure';
const task = {
  task_id: 'TASK-SCORER-1', parent_task_id: null, revision: 1, attempt: 1, known_evidence: [],
  validation: { required: ['node --test scripts/test-a.mjs'], optional: [] },
  timing: { estimated_minutes: 10, first_check_after_minutes: 1, soft_deadline_minutes: 5, hard_timeout_minutes: 15 },
};
const escalated = (blocker) => ({
  task_id: task.task_id, status: 'escalation_required', total_rounds: 1, blockers: [],
  rounds: [{ round: 1, kind: 'execution', classification: 'escalate', validation: null,
    executor: { status: 'blocked', files_changed: [], changes: [], blockers: [blocker] } }],
});

const WITH_CODE = ['PATH_REJECTED', 'INVALID_SCOPE', 'WRITE_FAILED', 'UNREADABLE_TARGET'];
const WITH_REASON = ['context_load_failed', 'schema_invalid', 'unsupported_action', 'missing_field', 'too_many_actions', 'too_many_files'];
const blockerFor = (id) => (WITH_CODE.includes(id) ? { reason: 'write_failed', code: id, detail: 'scorer detail' } : { reason: id, code: null, detail: 'scorer detail' });

const reasonCodes = new Set();
for (const id of [...WITH_CODE, ...WITH_REASON]) {
  await s.check(`gate: ${id} -> FAILED / ${STABLE}, raw identifier kept in evidence`, () => {
    const gate = gateMod.evaluateResultGate(escalated(blockerFor(id)));
    reasonCodes.add(gate.reason_code);
    assert.equal(gate.gate_status, 'FAILED');
    assert.equal(gate.reason_code, STABLE);
    assert.equal(gate.evidence.blocker.code ?? gate.evidence.blocker.reason, id);
  });
  await s.check(`x-result: ${id} -> reason_code ${STABLE}; raw identifier listed in blockers`, () => {
    const ro = escalated(blockerFor(id));
    const xr = builderMod.buildXResult(task, ro, gateMod.evaluateResultGate(ro));
    assert.equal(xr.reason_code, STABLE);
    assert.ok(xr.blockers.some((b) => b.reason === id), `raw '${id}' missing from xResult.blockers`);
  });
}
await s.check('taxonomy is stable: all 10 identifiers share exactly one reason_code', () => {
  assert.equal(reasonCodes.size, 1);
});
for (const code of ['PROTECTED_PATH', 'SYMLINK_ESCAPE']) {
  await s.check(`control: ${code} stays NEEDS_REVIEW / safety_boundary_review`, () => {
    const gate = gateMod.evaluateResultGate(escalated({ reason: 'write_failed', code, detail: 'd' }));
    assert.equal(gate.gate_status, 'NEEDS_REVIEW');
    assert.equal(gate.reason_code, 'safety_boundary_review');
  });
}
await s.check('control: an unrecognized code stays NEEDS_REVIEW / unrecognized_repair_outcome', () => {
  const gate = gateMod.evaluateResultGate(escalated({ reason: 'write_failed', code: 'BRAND_NEW_CODE', detail: 'd' }));
  assert.equal(gate.gate_status, 'NEEDS_REVIEW');
  assert.equal(gate.reason_code, 'unrecognized_repair_outcome');
});

// ---- v1.1 controls: behavior the reference fix must NOT change ------------------
for (const [reason, rounds] of [
  ['invalid_task_scope', []],
  ['invalid_validation_command', [{ round: 1, kind: 'validation', classification: 'escalate', executor: { status: 'completed', files_changed: [], changes: [], blockers: [] },
    validation: { required: [{ command: 'rm -rf /', status: 'invalid_command', exitCode: null }], optional: [] } }]],
]) {
  await s.check(`control (v2): top-level blocker ${reason} stays FAILED with its OWN reason_code`, () => {
    const gate = gateMod.evaluateResultGate({ task_id: task.task_id, status: 'escalation_required', rounds, total_rounds: rounds.length, blockers: [{ reason, detail: 'd' }] });
    assert.equal(gate.gate_status, 'FAILED');
    assert.equal(gate.reason_code, reason);
  });
}
await s.check('control (v2): an unrecognized top-level blocker stays NEEDS_REVIEW / unrecognized_repair_outcome', () => {
  const gate = gateMod.evaluateResultGate({ task_id: task.task_id, status: 'escalation_required', rounds: [], total_rounds: 0, blockers: [{ reason: 'some_future_reason', detail: 'd' }] });
  assert.equal(gate.gate_status, 'NEEDS_REVIEW');
  assert.equal(gate.reason_code, 'unrecognized_repair_outcome');
});
s.finish();
