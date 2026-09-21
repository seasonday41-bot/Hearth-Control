// X v0.2 Slice 4: deterministic permanent-failure classification. PRECONDITION_FAILED is refined by a structured `subtype` set by
// the code that detects the condition (edit-writer / local-executor); the repair loop and Result Gate read the subtype, never the
// `detail` text. Deterministic: temp workspaces, fake ModelAdapter, no model, no network.
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FAILURE_SUBTYPES, failureSubtypeOf } from '../mcp/x/failure-kinds.mjs';
import { classifyExecutorFailure, runTaskWithRepair } from '../mcp/x/repair-loop.mjs';
import { evaluateResultGate } from '../mcp/x/result-gate.mjs';
import { createFile, replaceFile, applyEdits } from '../mcp/x/edit-writer.mjs';
import { X_TASK_VERSION } from '../mcp/x/task-contract.mjs';

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-x-fc-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const write = (root, rel, content) => { const abs = path.join(root, rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, content); return abs; };
const sha = (text) => import('node:crypto').then((c) => c.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'));

const task = (root, over = {}) => ({
  version: X_TASK_VERSION, task_id: 'TASK-FC', parent_task_id: null, revision: 1, attempt: 1, based_on_result_id: null,
  objective: 'Change the value.', problem: 'The value is wrong.', expected_behavior: 'It is right.', observed_behavior: 'It is wrong.', why_this_matters: 'w',
  known_evidence: [], suspected_area: ['src/a.js'], workspace: { repo: 'r', root },
  scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: [] }, constraints: { preserve: [], do_not: [] },
  allowed_tools: ['repo_read', 'repo_edit'], acceptance_criteria: ['a'], validation: { required: [], optional: [] }, verification: null,
  done_criteria: ['d'], teaching_notes: [], uncertainty_policy: { policy: 'bounded_autonomy', stop_conditions: [] },
  repair_budget: { initial_attempts: 1, max_repairs: 2, max_total_rounds: 3 },
  timing: { estimated_minutes: 5, first_check_after_minutes: 1, soft_deadline_minutes: 3, hard_timeout_minutes: 10 }, commit_policy: { mode: 'never' }, ...over,
});
/** Fake adapter: one queued response per call (last repeats); `before(callIndex)` may mutate the workspace during the "model call". */
const adapterOf = (responses, before = null) => {
  const calls = [];
  return {
    calls,
    generate: async (request) => {
      calls.push(request);
      if (before) await before(calls.length);
      const payload = responses[Math.min(calls.length - 1, responses.length - 1)];
      return { ok: true, provider: 'fake', model: 'fake', requestedModel: null, text: JSON.stringify(payload), finishReason: 'stop', usage: null, error: null };
    },
  };
};
const patch = (p, old_string, new_string) => ({ type: 'patch', path: p, edits: [{ old_string, new_string }] });
const bigFile = () => `${Array.from({ length: 400 }, (_, i) => `const line${i + 1} = ${i + 1}; // ${'x'.repeat(30)}`).join('\n')}\n`;
const blockerOf = (outcome, round = 0) => outcome.rounds[round].executor.blockers[0];

// ------------------------------------------------------------------ the table and the classifier ----

test('FC1 subtype table: every subtype is classified and has a failure class; lookups need code PRECONDITION_FAILED and a known subtype', () => {
  assert.ok(Object.isFrozen(FAILURE_SUBTYPES));
  for (const [name, info] of Object.entries(FAILURE_SUBTYPES)) {
    assert.ok(['repairable', 'escalate'].includes(info.classification), name);
    assert.ok(['live_state', 'model_edit', 'context_limitation', 'structural'].includes(info.failure_class), name);
    assert.ok(Object.isFrozen(info));
    assert.equal(info.classification === 'escalate', ['context_limitation', 'structural'].includes(info.failure_class), `${name}: permanent classes escalate, transient classes repair`);
  }
  assert.deepEqual(Object.entries(FAILURE_SUBTYPES).filter(([, i]) => i.classification === 'escalate').map(([n]) => n).sort(), ['excerpt_provenance_invalid', 'no_usable_context', 'precondition_missing', 'unseen_context']);
  assert.equal(failureSubtypeOf({ code: 'PRECONDITION_FAILED', subtype: 'unseen_context' }), FAILURE_SUBTYPES.unseen_context);
  for (const bad of [null, {}, { code: 'PRECONDITION_FAILED' }, { code: 'PRECONDITION_FAILED', subtype: 'nope' }, { code: 'PRECONDITION_FAILED', subtype: '__proto__' }, { code: 'PRECONDITION_FAILED', subtype: 'toString' }, { code: 'PATH_REJECTED', subtype: 'unseen_context' }, { reason: 'write_failed', subtype: 'unseen_context' }]) {
    assert.equal(failureSubtypeOf(bad), null, JSON.stringify(bad));
  }
});

test('FC2 classifyExecutorFailure: subtype decides for PRECONDITION_FAILED; no/unknown subtype keeps the old repairable default; other codes are untouched', () => {
  const of = (blocker) => classifyExecutorFailure({ blockers: [blocker] });
  assert.equal(of({ reason: 'write_failed', code: 'PRECONDITION_FAILED' }), 'repairable', 'compat: no subtype');
  assert.equal(of({ reason: 'write_failed', code: 'PRECONDITION_FAILED', subtype: 'from_the_future' }), 'repairable', 'compat: unknown subtype');
  for (const [name, info] of Object.entries(FAILURE_SUBTYPES)) assert.equal(of({ reason: 'write_failed', code: 'PRECONDITION_FAILED', subtype: name }), info.classification, name);
  assert.equal(of({ reason: 'write_failed', code: 'PATH_REJECTED', subtype: 'stale_live_state' }), 'escalate', 'a subtype never turns a structural code repairable');
  assert.equal(of({ reason: 'write_failed', code: 'WRITE_LIMIT_EXCEEDED', subtype: 'unseen_context' }), 'repairable', 'nor the other way round');
  assert.equal(of({ reason: 'malformed_json' }), 'repairable');
  assert.equal(of({ reason: 'never_heard_of_it' }), 'escalate');
});

test('FC3 the classification never reads the human-readable detail: same subtype, any detail text -> same class', () => {
  const details = ['old_string not found', 'refusing to patch text that was not shown', '', null, undefined, 'no complete (status: ok) snapshot', 'expectedHash did not match the current file content'];
  for (const detail of details) {
    assert.equal(classifyExecutorFailure({ blockers: [{ reason: 'write_failed', code: 'PRECONDITION_FAILED', subtype: 'no_usable_context', detail }] }), 'escalate');
    assert.equal(classifyExecutorFailure({ blockers: [{ reason: 'write_failed', code: 'PRECONDITION_FAILED', subtype: 'edit_mismatch', detail }] }), 'repairable');
    assert.equal(classifyExecutorFailure({ blockers: [{ reason: 'write_failed', code: 'PRECONDITION_FAILED', detail }] }), 'repairable');
  }
  for (const file of ['repair-loop.mjs', 'result-gate.mjs', 'failure-kinds.mjs']) {
    const source = fs.readFileSync(new URL(`../mcp/x/${file}`, import.meta.url), 'utf8');
    assert.equal(/\.detail\b[^;\n]*\.(?:match|test|includes|startsWith|search)\(|(?:match|test|includes)\([^)]*\.detail/.test(source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), false, `${file} must not inspect detail text`);
  }
});

// ------------------------------------------------------------------ sources set the subtype ----

test('FC4 edit-writer sets the subtype at the point of detection; successes and other codes keep their exact previous shape', async () => {
  const root = tmp(); write(root, 'src/a.js', 'one two one\n'); write(root, 'src/b.js', 'x\n');
  const t = task(root);
  const actual = await sha('one two one\n');
  assert.equal((await replaceFile(t, 'src/a.js', 'y', { expectedHash: 'deadbeef' })).subtype, 'stale_live_state');
  assert.equal((await replaceFile(t, 'src/a.js', 'y', { expectedContent: 'other' })).subtype, 'stale_live_state');
  assert.equal((await replaceFile(t, 'src/a.js', 'y', {})).subtype, 'precondition_missing');
  assert.equal((await createFile(t, 'src/a.js', 'y')).subtype, 'create_target_exists');
  assert.equal((await applyEdits(t, 'src/a.js', [{ old_string: 'zzz', new_string: 'y' }])).subtype, 'edit_mismatch');
  assert.equal((await applyEdits(t, 'src/a.js', [{ old_string: 'one', new_string: 'y' }])).subtype, 'edit_ambiguous');
  assert.equal((await applyEdits(t, 'src/a.js', [{ old_string: 'two', new_string: 'y' }], { expectedHash: 'deadbeef' })).subtype, 'stale_live_state');
  // excerpt-mode (uniqueInOriginal)
  const u = (edits) => applyEdits(t, 'src/a.js', edits, { expectedHash: actual, uniqueInOriginal: true });
  assert.equal((await u([{ old_string: 'zzz', new_string: 'y' }])).subtype, 'edit_mismatch');
  assert.equal((await u([{ old_string: 'one', new_string: 'y' }])).subtype, 'edit_ambiguous');
  assert.equal((await u([{ old_string: 'two', new_string: 'y', replace_all: true }])).subtype, 'edit_form_invalid');
  // shown-range gate: real text that was not shown vs text that is not in the file at all; stale beats both
  const shown = { texts: ['one two'], label: '1-1' };
  const s = (edits, extra = {}) => applyEdits(t, 'src/a.js', edits, { expectedHash: actual, uniqueInOriginal: true, shown, ...extra });
  const unseen = await s([{ old_string: 'two one', new_string: 'y' }]);
  assert.equal(unseen.subtype, 'unseen_context');
  assert.match(unseen.detail, /not entirely within a shown excerpt of this file \(1-1\); refusing to patch text that was not shown/);
  assert.equal((await s([{ old_string: 'not in file', new_string: 'y' }])).subtype, 'edit_mismatch');
  assert.equal((await s([{ old_string: 'two one', new_string: 'y' }], { expectedHash: 'deadbeef' })).subtype, 'stale_live_state');
  // shape: no subtype key on success or on non-PRECONDITION failures
  const ok = await applyEdits(t, 'src/b.js', [{ old_string: 'x', new_string: 'z' }]);
  assert.equal(ok.status, 'ok'); assert.equal('subtype' in ok, false);
  const rejected = await createFile(t, '../outside.js', 'x');
  assert.equal(rejected.status, 'error'); assert.equal('subtype' in rejected, false);
  assert.equal('subtype' in (await applyEdits(t, 'src/nope.js', [{ old_string: 'x', new_string: 'y' }])), false, 'UNREADABLE_TARGET is untouched');
});

// ------------------------------------------------------------------ end to end: rounds and gate ----

test('FC5 truncated / no-usable-context target: ONE round, no second model call, Result Gate reports a structural context limitation (not transient exhaustion)', async () => {
  const root = tmp(); write(root, 'src/a.js', bigFile());
  const adapter = adapterOf([{ actions: [patch('src/a.js', 'const line250 = 250;', 'const line250 = 0;')] }]);
  const outcome = await runTaskWithRepair(task(root), adapter, { contextOptions: { retrieval: false } });
  assert.equal(outcome.total_rounds, 1);
  assert.equal(adapter.calls.length, 1);
  assert.equal(outcome.status, 'escalation_required');
  assert.equal(blockerOf(outcome).code, 'PRECONDITION_FAILED');
  assert.equal(blockerOf(outcome).subtype, 'no_usable_context');
  assert.equal(outcome.rounds[0].classification, 'escalate');
  assert.equal(fs.readFileSync(path.join(root, 'src/a.js'), 'utf8'), bigFile(), 'file untouched');
  const gate = evaluateResultGate(outcome);
  assert.equal(gate.reason_code, 'structural_execution_failure');
  assert.equal(gate.gate_status, 'FAILED');
  assert.equal(gate.evidence.failure_class, 'context_limitation');
  assert.equal(gate.evidence.blocker.subtype, 'no_usable_context');
  assert.notEqual(gate.reason_code, 'repair_budget_exhausted_transient');
});

test('FC6 Slice-1 negative probe D shape: an edit in an UNSHOWN region of an excerpted file escalates after 1 round; a mis-copied old_string still gets the full repair budget', async () => {
  const root = tmp(); write(root, 'src/a.js', bigFile());
  const t = task(root, { suspected_area: ['src/a.js:10-15'] });
  const unseen = adapterOf([{ actions: [patch('src/a.js', 'const line300 = 300;', 'const line300 = 0;')] }]);
  const outcome = await runTaskWithRepair(t, unseen);
  assert.equal(outcome.total_rounds, 1); assert.equal(unseen.calls.length, 1);
  assert.equal(blockerOf(outcome).subtype, 'unseen_context');
  assert.match(blockerOf(outcome).detail, /not entirely within a shown excerpt/);
  assert.equal(evaluateResultGate(outcome).reason_code, 'structural_execution_failure');
  assert.equal(evaluateResultGate(outcome).evidence.failure_class, 'context_limitation');
  assert.equal(fs.readFileSync(path.join(root, 'src/a.js'), 'utf8'), bigFile());

  const miscopied = adapterOf([{ actions: [patch('src/a.js', 'const line12 = 12; // TYPO', 'const line12 = 0;')] }]);
  const exhausted = await runTaskWithRepair(t, miscopied);
  assert.equal(exhausted.total_rounds, 3, 'budget unchanged');
  assert.equal(miscopied.calls.length, 3);
  assert.equal(blockerOf(exhausted, 2).subtype, 'edit_mismatch');
  assert.deepEqual(exhausted.rounds.map((r) => r.classification), ['repairable', 'repairable', 'repairable']);
  assert.equal(evaluateResultGate(exhausted).reason_code, 'repair_budget_exhausted_transient');
  assert.equal(evaluateResultGate(exhausted).evidence.failure_class, 'model_edit');
});

test('FC7 stale hash / drift between context load and write stays repairable, and the next round (fresh context) succeeds', async () => {
  const root = tmp(); const file = write(root, 'src/a.js', 'const v = 1;\nconst w = 2;\n');
  const drift = (call) => { if (call === 1) fs.writeFileSync(file, 'const v = 1;\nconst w = 2;\n// touched by someone else\n'); };
  const adapter = adapterOf([{ actions: [patch('src/a.js', 'const v = 1;', 'const v = 9;')] }, { actions: [patch('src/a.js', 'const v = 1;', 'const v = 9;')] }], drift);
  const outcome = await runTaskWithRepair(task(root), adapter);
  assert.equal(blockerOf(outcome).subtype, 'stale_live_state');
  assert.equal(outcome.rounds[0].classification, 'repairable');
  assert.equal(outcome.status, 'validated');
  assert.equal(outcome.total_rounds, 2);
  assert.equal(fs.readFileSync(file, 'utf8'), 'const v = 9;\nconst w = 2;\n// touched by someone else\n');
});

test('FC8 a non-unique old_string on a complete file stays repairable and a longer unique one succeeds', async () => {
  const root = tmp(); const file = write(root, 'src/a.js', 'let a = 1;\nlet a = 1;\nlet b = 2;\n');
  const adapter = adapterOf([{ actions: [patch('src/a.js', 'let a = 1;', 'let a = 5;')] }, { actions: [patch('src/a.js', 'let a = 1;\nlet b = 2;', 'let a = 1;\nlet b = 5;')] }]);
  const outcome = await runTaskWithRepair(task(root), adapter);
  assert.equal(blockerOf(outcome).subtype, 'edit_ambiguous');
  assert.equal(outcome.rounds[0].classification, 'repairable');
  assert.equal(outcome.status, 'validated'); assert.equal(outcome.total_rounds, 2);
  assert.equal(fs.readFileSync(file, 'utf8'), 'let a = 1;\nlet a = 1;\nlet b = 5;\n');
});

test('FC8b an old_string mismatch on a complete file stays repairable and a corrected copy succeeds', async () => {
  const root = tmp(); const file = write(root, 'src/a.js', 'const v = 1;\n');
  const adapter = adapterOf([{ actions: [patch('src/a.js', 'const  v = 1;', 'const v = 9;')] }, { actions: [patch('src/a.js', 'const v = 1;', 'const v = 9;')] }]);
  const outcome = await runTaskWithRepair(task(root), adapter);
  assert.equal(blockerOf(outcome).subtype, 'edit_mismatch');
  assert.equal(outcome.status, 'validated'); assert.equal(outcome.total_rounds, 2);
  assert.equal(fs.readFileSync(file, 'utf8'), 'const v = 9;\n');
});

test('FC9 choosing a read-only reference file as the edit target is model-correctable (repairable/model_edit): the write is refused, the file is untouched, and the next round can pick an authorized editable target', async () => {
  const root = tmp();
  const a = write(root, 'src/a.js', "const l = require('../lib/l.js');\nconst v = 1;\n");
  const lib = write(root, 'lib/l.js', `${Array.from({ length: 40 }, () => '// filler').join('\n')}\nfunction frobnicateWidget() {}\n`);
  const t = task(root, { problem: 'Behavior of `frobnicateWidget` is wrong.', scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: [], reference_paths: ['lib'] } });
  const adapter = adapterOf([
    { actions: [patch('lib/l.js', 'function frobnicateWidget() {}', 'function frobnicateWidget() { return 1; }')] }, // round 1: the reference file
    { actions: [patch('src/a.js', 'const v = 1;', 'const v = 2;')] }, // round 2: an authorized editable target
  ]);
  const outcome = await runTaskWithRepair(t, adapter);
  assert.equal(blockerOf(outcome).code, 'PRECONDITION_FAILED');
  assert.equal(blockerOf(outcome).subtype, 'read_only_target');
  assert.match(blockerOf(outcome).detail, /read-only reference context/);
  assert.equal(outcome.rounds[0].classification, 'repairable');
  assert.equal(adapter.calls.length, 2);
  assert.match(adapter.calls[1].messages.map((m) => m.content).join('\n'), /read-only reference context \(status: reference\); it cannot be edited/, 'the refusal is in the next round\'s evidence');
  assert.equal(outcome.status, 'validated');
  assert.equal(fs.readFileSync(lib, 'utf8').includes('return 1'), false, 'the reference file was never written');
  assert.equal(fs.readFileSync(a, 'utf8'), "const l = require('../lib/l.js');\nconst v = 2;\n");
});

test('FC9b the write boundary still refuses a reference-file write on its own; a model that keeps choosing the reference file exhausts the normal budget as model_edit (transient), never a permanent failure', async () => {
  const root = tmp(); write(root, 'src/a.js', "const l = require('../lib/l.js');\n");
  const lib = write(root, 'lib/l.js', `${Array.from({ length: 40 }, () => '// filler').join('\n')}\nfunction frobnicateWidget() {}\n`);
  const t = task(root, { problem: 'Behavior of `frobnicateWidget` is wrong.', scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: [], reference_paths: ['lib'] } });
  const direct = await applyEdits(t, 'lib/l.js', [{ old_string: 'function frobnicateWidget() {}', new_string: 'x' }]);
  assert.equal(direct.code, 'PATH_REJECTED');
  assert.equal(fs.readFileSync(lib, 'utf8').includes('function frobnicateWidget() {}'), true);
  const stubborn = adapterOf([{ actions: [{ type: 'replace', path: 'lib/l.js', content: 'x' }] }]);
  const outcome = await runTaskWithRepair(t, stubborn);
  assert.equal(outcome.total_rounds, 3, 'budget unchanged'); assert.equal(stubborn.calls.length, 3);
  assert.deepEqual(outcome.rounds.map((r) => blockerOf(outcome, r.round - 1).subtype), ['read_only_target', 'read_only_target', 'read_only_target']);
  const gate = evaluateResultGate(outcome);
  assert.deepEqual([gate.gate_status, gate.reason_code, gate.evidence.failure_class], ['NEEDS_REVIEW', 'repair_budget_exhausted_transient', 'model_edit']);
  assert.equal(fs.readFileSync(lib, 'utf8').includes('function frobnicateWidget() {}'), true);
});

test('FC10 a file created earlier IN THE SAME RUN is stale context, not a permanent limitation: the next round sees it and repairs', async () => {
  const root = tmp(); write(root, 'src/a.js', 'x\n');
  const adapter = adapterOf([
    { actions: [{ type: 'create', path: 'src/new.js', content: 'const k = 1;\n' }, patch('src/new.js', 'const k = 1;', 'const k = 2;')] },
    { actions: [patch('src/new.js', 'const k = 1;', 'const k = 2;')] },
  ]);
  const outcome = await runTaskWithRepair(task(root), adapter);
  assert.equal(blockerOf(outcome).subtype, 'stale_live_state');
  assert.equal(outcome.rounds[0].classification, 'repairable');
  assert.equal(outcome.status, 'validated'); assert.equal(outcome.total_rounds, 2);
  assert.equal(fs.readFileSync(path.join(root, 'src/new.js'), 'utf8'), 'const k = 2;\n');
});

test('FC11 create on an existing path: a SHOWN file is repairable (use patch); an existing but never-shown file is a permanent context limitation', async () => {
  const root = tmp(); write(root, 'src/a.js', 'const v = 1;\n'); write(root, 'src/hidden.js', 'secret-ish\n');
  const shown = adapterOf([{ actions: [{ type: 'create', path: 'src/a.js', content: 'x' }] }, { actions: [patch('src/a.js', 'const v = 1;', 'const v = 2;')] }]);
  const ok = await runTaskWithRepair(task(root), shown);
  assert.equal(blockerOf(ok).subtype, 'create_target_exists');
  assert.equal(ok.status, 'validated'); assert.equal(ok.total_rounds, 2);
  const hidden = adapterOf([{ actions: [{ type: 'create', path: 'src/hidden.js', content: 'x' }] }, { actions: [] }]);
  const stuck = await runTaskWithRepair(task(root), hidden);
  assert.equal(blockerOf(stuck).subtype, 'no_usable_context');
  assert.equal(stuck.total_rounds, 1); assert.equal(hidden.calls.length, 1);
  assert.equal(fs.readFileSync(path.join(root, 'src/hidden.js'), 'utf8'), 'secret-ish\n');
});

test('FC12 Result Gate: permanent subtypes -> FAILED structural_execution_failure with failure_class/subtype in evidence; transient exhaustion keeps its reason; subtype-less PRECONDITION_FAILED is unchanged', () => {
  const outcome = (blocker, classification) => ({ task_id: 'T', status: 'escalation_required', total_rounds: classification === 'escalate' ? 1 : 3, blockers: [], rounds: [{ round: 1, kind: 'execution', classification, executor: { status: 'failed', blockers: [blocker] }, validation: null }] });
  const pre = (subtype) => ({ reason: 'write_failed', code: 'PRECONDITION_FAILED', path: 'src/a.js', detail: 'whatever', ...(subtype ? { subtype } : {}) });
  for (const [name, info] of Object.entries(FAILURE_SUBTYPES)) {
    const gate = evaluateResultGate(outcome(pre(name), info.classification));
    if (info.classification === 'escalate') {
      assert.deepEqual([gate.gate_status, gate.hearth_outcome, gate.reason_code, gate.waiting_reason], ['FAILED', 'error', 'structural_execution_failure', null], name);
    } else {
      assert.deepEqual([gate.gate_status, gate.reason_code, gate.waiting_reason], ['NEEDS_REVIEW', 'repair_budget_exhausted_transient', 'supervisor_review'], name);
    }
    assert.equal(gate.evidence.failure_class, info.failure_class, name);
    assert.equal(gate.evidence.blocker.subtype, name);
  }
  const legacy = evaluateResultGate(outcome(pre(null), 'repairable'));
  assert.deepEqual([legacy.gate_status, legacy.reason_code], ['NEEDS_REVIEW', 'repair_budget_exhausted_transient']);
  assert.equal('failure_class' in legacy.evidence, false);
  assert.deepEqual(Object.keys(legacy.evidence.blocker).sort(), ['code', 'detail', 'reason'], 'evidence shape unchanged when there is no subtype');
  const unknown = evaluateResultGate(outcome({ ...pre('from_the_future') }, 'repairable'));
  assert.equal(unknown.reason_code, 'repair_budget_exhausted_transient');
});

test('FC13 validation repair behavior and budgets are unchanged: a failing required validation still uses every round and ends transient', async () => {
  const root = tmp(); write(root, 'src/a.js', 'x\n'); write(root, 'scripts/test-fail.mjs', "import test from 'node:test';\ntest('bad', () => { throw new Error('nope'); });\n");
  const adapter = adapterOf([{ actions: [] }]);
  const outcome = await runTaskWithRepair(task(root, { validation: { required: ['node --test scripts/test-fail.mjs'], optional: [] } }), adapter);
  assert.equal(outcome.total_rounds, 3); assert.equal(adapter.calls.length, 3);
  assert.deepEqual(outcome.rounds.map((r) => r.classification), ['repairable', 'repairable', 'repairable']);
  const gate = evaluateResultGate(outcome);
  assert.equal(gate.reason_code, 'repair_budget_exhausted_transient');
  assert.equal('failure_class' in gate.evidence, false);
});

test('FC14 blockers of other failures carry no subtype key (shape unchanged)', async () => {
  const root = tmp(); write(root, 'src/a.js', 'x\n');
  const adapter = adapterOf([{ actions: [{ type: 'create', path: 'other/file.js', content: 'x' }] }]);
  const outcome = await runTaskWithRepair(task(root), adapter);
  assert.equal(blockerOf(outcome).code, 'PATH_REJECTED');
  assert.equal('subtype' in blockerOf(outcome), false);
});
