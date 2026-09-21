#!/usr/bin/env node
// X-Eval v1 Step 5 - runner smoke with MODEL STUBS ONLY (no Ollama, no real model).
// Updated for the X v0.2 candidate (Slices 1-4): structural probes are now solved by deterministic excerpt retrieval; the old
// behaviour (truncated context, permanent refusal) is asserted as a CONTROL with retrieval switched off; F4 checks the frozen
// candidate manifest (x-candidate.mjs) instead of 'mcp/x clean vs HEAD'.
// Purpose: prove the HARNESS is sound before any score is taken: isolation, hidden-scorer secrecy,
// baseline/final diff, tamper detection, preflight guard, cleanup, frozen-X integrity.
//
// Usage: node scripts/x-eval/runner/smoke.mjs --work-dir D --artifacts-dir A [--out FILE]

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { EVAL_DIR, sha256, executorIdentity, gitRepo, grepTree, findTokens, scorerTokens, referenceAddedLines, shaTokens, lockFingerprint, FINGERPRINT_INPUTS } from './lib.mjs';
import { deriveOutcome } from './score.mjs';
import { parseFailures, declaredTestNames } from './regression-net.mjs';
import { runTask } from './run-task.mjs';
import { makeStub, referenceEdits } from './stubs.mjs';
import { LANES } from './lanes.mjs';
import { xCandidateIdentity, verifyCandidate } from './x-candidate.mjs';
import { TASKS } from '../tasks/tasks-v1.mjs';

const { values } = parseArgs({ options: { 'work-dir': { type: 'string' }, 'artifacts-dir': { type: 'string' }, out: { type: 'string', default: path.join(EVAL_DIR, 'runner-smoke-results-v1.json') } } });
if (!values['work-dir'] || !values['artifacts-dir']) { console.error('--work-dir and --artifacts-dir are required (use the session scratchpad)'); process.exit(2); }
const WORK = path.resolve(values['work-dir']);
const ART = path.resolve(values['artifacts-dir']);
fs.mkdirSync(WORK, { recursive: true });

const results = []; const runs = [];
const check = (id, group, desc, ok, detail = '') => { results.push({ id, group, desc, ok: Boolean(ok), detail: String(detail).slice(0, 300) }); console.error(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${desc}${ok ? '' : `  -> ${detail}`}`); };
const T = (id) => TASKS.find((t) => t.id === id);
const run = async (taskId, stub, extra = {}) => {
  const { adapterFactory, ...rest } = extra;
  const rec = await runTask({ task: rest.task ?? T(taskId), adapterFactory: adapterFactory ?? ((ctx) => makeStub(stub, ctx)), adapterName: `stub:${stub}`, workRoot: WORK, artifactsRoot: ART, ...rest });
  runs.push({ stub, taskId, rec }); return rec;
};
const blockerOf = (rec) => rec.repair_outcome?.rounds?.[0]?.executor?.blockers?.[0] ?? null;

// -------- baseline of the MAIN checkout (must be identical at the end) -----------------------------------
const before = { exec: executorIdentity(), cand: xCandidateIdentity(), head: gitRepo(['rev-parse', 'HEAD']).trim(), status: gitRepo(['status', '--porcelain']) };

// ============ A. oracle stub x all 5 tasks (X + isolation + hidden scorer, end to end) ==================
const ORACLE_OK = ['c1d6770715', '8d08bc3621', '070e9850b1'];
const ORACLE_STRUCTURAL = ['4f261b2f4b', '79664a00cc'];
const oracle = {};
for (const id of [...ORACLE_OK, ...ORACLE_STRUCTURAL]) oracle[id] = await run(id, 'oracle');
for (const id of ORACLE_OK) {
  const rec = oracle[id];
  check(`A1.${id}`, 'A end-to-end', `oracle replay -> SUCCESS, X gate agrees (${T(id).tier}, ${T(id).provenance})`, rec.outcome.label === 'SUCCESS' && rec.outcome.gate_agrees === true, JSON.stringify(rec.outcome));
  const want = gitRepo(['diff', '--numstat', T(id).parent, T(id).fixed, '--', ...T(id).oracle_files]).trim().split('\n').map((l) => l.split('\t').slice(0, 3).join(':')).sort().join('|');
  const got = rec.diff.numstat.map((n) => `${n.insertions}:${n.deletions}:${n.path}`).sort().join('|');
  check(`A2.${id}`, 'A end-to-end', 'final numstat vs baseline equals the reference fix numstat', want === got, `want ${want} got ${got}`);
}
// X v0.2: the two structural probes (electron/main.cjs, too large to load whole) are solved by deterministic excerpt retrieval.
for (const id of ORACLE_STRUCTURAL) {
  const rec = oracle[id];
  const want = gitRepo(['diff', '--numstat', T(id).parent, T(id).fixed, '--', ...T(id).oracle_files]).trim().split('\n').map((l) => l.split('\t').slice(0, 3).join(':')).sort().join('|');
  const got = rec.diff.numstat.map((n) => `${n.insertions}:${n.deletions}:${n.path}`).sort().join('|');
  check(`A3.${id}`, 'A end-to-end', 'X v0.2: oracle replay on the STRUCTURAL probe -> SUCCESS in 1 round, X gate agrees; electron/main.cjs was shown as an auto-located excerpt (not truncated); numstat equals the reference fix',
    rec.outcome.label === 'SUCCESS' && rec.outcome.gate_agrees === true && rec.repair_outcome.total_rounds === 1 && rec.context_round1.oracle_files_in_context[0].status === 'excerpt' && want === got, JSON.stringify({ o: rec.outcome, c: rec.context_round1.oracle_files_in_context, want, got }));
}
// CONTROL (retrieval OFF = the pre-v0.2 context): the same perfect model cannot edit the truncated file, and X now stops after ONE
// round as a structural context limitation (Slice 4) instead of spending the whole budget as a "transient" failure.
const RETRIEVAL_OFF = { ...LANES.model_quality, contextOptions: { ...(LANES.model_quality.contextOptions ?? {}), retrieval: false } };
for (const id of ORACLE_STRUCTURAL) {
  const rec = await run(id, 'oracle', { lane: RETRIEVAL_OFF }); const b = blockerOf(rec);
  check(`A4.${id}`, 'A end-to-end', 'CONTROL (retrieval off): file loaded as truncated, patch refused with subtype no_usable_context, ONE round, gate FAILED/structural_execution_failure (not repair_budget_exhausted_transient), empty diff',
    rec.outcome.label === 'FAILURE' && rec.context_round1.oracle_files_in_context[0].status === 'truncated' && b?.code === 'PRECONDITION_FAILED' && b?.subtype === 'no_usable_context' && /no complete \(status: ok\) snapshot/.test(b?.detail ?? '')
      && rec.repair_outcome.total_rounds === 1 && rec.gate_result.gate_status === 'FAILED' && rec.gate_result.reason_code === 'structural_execution_failure' && rec.gate_result.evidence.failure_class === 'context_limitation' && rec.diff.numstat.length === 0,
    JSON.stringify({ o: rec.outcome, b, rounds: rec.repair_outcome.total_rounds, g: rec.gate_result.reason_code }));
}

// ============ B. harness attacks / negative controls (stub misbehaviour must be caught by the HARNESS) ===========
const noop = await run('c1d6770715', 'noop');
check('B1', 'B controls', 'noop model: FAILURE, empty diff, full repair budget (3 model calls), hidden scorer fails', noop.outcome.label === 'FAILURE' && noop.diff.numstat.length === 0 && noop.model_calls.length === 3 && noop.hidden.status === 'failed', `${noop.outcome.label} calls=${noop.model_calls.length}`);
const malformed = await run('c1d6770715', 'malformed');
check('B2', 'B controls', 'malformed model output: FAILURE, empty diff, blocker malformed_json recorded', malformed.outcome.label === 'FAILURE' && malformed.diff.numstat.length === 0 && blockerOf(malformed)?.reason === 'malformed_json', JSON.stringify(blockerOf(malformed)));

const esc = path.join(path.dirname(WORK), 'xeval-escape-probe.txt');
const abs = path.join(EVAL_DIR, 'xeval-abs-probe.txt');
const escapes = [['../xeval-escape-probe.txt', path.join(WORK, 'xeval-escape-probe.txt')], [abs, abs], ['scripts/test-xeval-injected.mjs', null], ['docs/xeval-probe.md', null]];
for (const [i, [target, outsidePath]] of escapes.entries()) {
  const rec = await run('c1d6770715', `create:${target}`);
  const b = blockerOf(rec);
  check(`B3.${i + 1}`, 'B controls', `X refuses create at '${path.isAbsolute(target) ? '<abs path inside the eval dir>' : target}': blocked, empty diff, nothing written outside the snapshot`,
    rec.outcome.label === 'FAILURE' && b?.status !== 'ok' && rec.diff.numstat.length === 0 && (outsidePath === null || !fs.existsSync(outsidePath)) && rec.checks.out_of_scope.length === 0, JSON.stringify({ b, o: rec.outcome.label, d: rec.diff.numstat }));
}
const rep = await run('c1d6770715', 'replace-visible-test');
check('B4', 'B controls', 'X cannot overwrite the visible validator (not loaded in context, forbidden path): blocked, no tampering', rep.diff.numstat.length === 0 && rep.checks.test_tampering.length === 0 && rep.outcome.label === 'FAILURE', JSON.stringify(blockerOf(rep)));

const tamper = await run('c1d6770715', 'side-effect-tamper');
const vFile = 'scripts/test-x-result-gate.mjs';
check('B5', 'B controls', 'harness-level tampering (stub rewrites the visible test + touches README): X gate is fooled (COMPLETED) but the runner reports FALSE_SUCCESS', tamper.gate_result?.gate_status === 'COMPLETED' && tamper.outcome.label === 'FALSE_SUCCESS' && tamper.hidden.status === 'failed', JSON.stringify({ g: tamper.gate_result?.gate_status, o: tamper.outcome }));
check('B6', 'B controls', 'external check flags TEST_TAMPERING (visible test) and OUT_OF_SCOPE (README.md and the test path)', tamper.checks.test_tampering.includes(vFile) && tamper.checks.out_of_scope.includes('README.md') && tamper.checks.out_of_scope.includes(vFile), JSON.stringify(tamper.checks));

const poison = await run('c1d6770715', 'poison-snapshot-x');
check('B7', 'B controls', "executor isolation: corrupting the snapshot's own mcp/x/* does not affect the frozen executor (no throw, full X result produced)", poison.x_error === null && poison.gate_result !== null && poison.x_result !== null && poison.repair_outcome.total_rounds >= 1, JSON.stringify({ e: poison.x_error, g: poison.gate_result?.gate_status }));
check('B8', 'B controls', 'the corruption itself is visible to the external checks (out-of-scope changes under mcp/x)', poison.checks.out_of_scope.some((p) => p.startsWith('mcp/x/')), JSON.stringify(poison.checks.out_of_scope));

const guard = await run('c1d6770715', 'noop', { baselineRev: T('c1d6770715').fixed });
check('B9', 'B controls', 'preflight guard: baseline already FIXED -> HARNESS_ERROR and the model is never called', guard.outcome.label === 'HARNESS_ERROR' && guard.model_calls.length === 0 && guard.preflight.ok === false && guard.preflight.hidden_at_baseline === 'passed', JSON.stringify({ o: guard.outcome, calls: guard.model_calls.length, p: guard.preflight }));
let synthRefused = false;
try { await run('c1d6770715', 'noop', { task: { ...T('c1d6770715'), provenance: 'synthetic' } }); } catch (e) { synthRefused = /not accepted for Gold v1/.test(e.message); }
check('B10', 'B controls', "validator_provenance 'synthetic' is refused", synthRefused);

const guardCtl = new AbortController();
const guarded = await run('c1d6770715', 'guard-abort', { guard: guardCtl, adapterFactory: () => ({ async generate() { guardCtl.abort(new Error('memory_guard: synthetic')); return { ok: true, provider: 'stub', model: 'stub', text: '{"actions":[]}', finishReason: 'stop', usage: null, error: null }; } }) });
check('B11', 'B controls', 'guard abort mid-run (memory guard path): outcome STOPPED_BY_GUARD with the reason, snapshot still cleaned up, no scoring on a half-run', guarded.outcome.label === 'STOPPED_BY_GUARD' && /memory_guard: synthetic/.test(guarded.outcome.reason) && guarded.model_calls.length === 1 && guarded.cleanup.snapshot_removed, JSON.stringify(guarded.outcome));

// ============ G. Gold v1.1 (regression net, REVIEW rule, fingerprint) ============================================
const over = await run('c1d6770715', 'overbroad-gate');
check('G1', 'G gold v1.1', 'end to end: reference fix PLUS the real model\'s over-generalization -> FAILURE (hidden v1.1 fails AND the regression net reports the same 2 tests)',
  over.outcome.label === 'FAILURE' && over.hidden.status === 'failed' && over.regression_net.regressions.length === 2 && over.integrity.regressions === 2, JSON.stringify({ o: over.outcome, h: over.hidden.failing, r: over.regression_net.regressions }));
check('G2', 'G gold v1.1', 'the regression net ran for every oracle SUCCESS (>= 1 usable file) and injected nothing into the final diff', ORACLE_OK.every((id) => oracle[id].regression_net.ran >= 1 && oracle[id].regression_net.regressions.length === 0 && oracle[id].diff.status.every((d) => T(id).oracle_files.includes(d.path))), ORACLE_OK.map((id) => `${id}:${oracle[id].regression_net.ran}`).join(' '));
const G = { scorerPass: { status: 'passed' }, ok: { ok: true }, bad: { ok: false }, done: { gate_status: 'COMPLETED' }, notDone: { gate_status: 'NEEDS_REVIEW', reason_code: 'x' } };
check('G3', 'G gold v1.1', 'outcome rule: pass + integrity + X agrees = SUCCESS; pass + integrity + X disagrees = REVIEW; X says done but integrity/scorer fails = FALSE_SUCCESS; integrity fails and X not done = FAILURE',
  deriveOutcome({ hidden: G.scorerPass, integrity: G.ok, gate: G.done }).label === 'SUCCESS' && deriveOutcome({ hidden: G.scorerPass, integrity: G.ok, gate: G.notDone }).label === 'REVIEW'
  && deriveOutcome({ hidden: G.scorerPass, integrity: G.bad, gate: G.done }).label === 'FALSE_SUCCESS' && deriveOutcome({ hidden: { status: 'failed' }, integrity: G.ok, gate: G.done }).label === 'FALSE_SUCCESS'
  && deriveOutcome({ hidden: G.scorerPass, integrity: G.bad, gate: G.notDone }).label === 'FAILURE' && deriveOutcome({ hidden: { status: 'failed' }, integrity: G.ok, gate: G.notDone }).label === 'FAILURE', '');
const inputs = FINGERPRINT_INPUTS().map((f) => path.basename(f));
check('G4', 'G gold v1.1', 'the v1.2 fingerprint is stable across calls and covers all 7 scorers, the nets, the scoring / stop logic, lanes and task definitions', lockFingerprint() === lockFingerprint() && ['regression-nets-v1.2.json', 'score.mjs', 'stop-rules.mjs', 'lanes.mjs', 'tasks-v1.mjs', 'candidates.mjs'].every((n) => inputs.includes(n)) && inputs.filter((n) => /^[0-9a-f]{10}\.mjs$/.test(n)).length === 7, inputs.join(','));

const declaredNames = declaredTestNames("await test('install creates backup: keeps data', async () => {}); test('rollback restores', () => {})");
const pfA = parseFailures('  FAIL  install creates backup: keeps data: The selected build is not newer\n✖ escalation_required: invalid_task_scope -> FAILED (0.1ms)', declaredNames);
const pfB = parseFailures('  FAIL  install creates backup: keeps data: The update is not newer than the running version.', declaredNames);
check('G5', 'G gold v1.2', 'regression-net key is the TEST NAME only: the same name with two different messages gives the same key (incl. a name that itself contains ": "); the message is kept as metadata; spec-reporter names are unchanged',
  pfA[0].name === pfB[0].name && pfA[0].name === 'install creates backup: keeps data' && pfA[0].message !== pfB[0].message && pfA[1].name === 'escalation_required: invalid_task_scope -> FAILED', JSON.stringify({ pfA, pfB }));
check('G6', 'G gold v1.2', 'hidden scorer sizes at v1.2 on the oracle replays: c1d6770715 = 28, 8d08bc3621 = 7, 070e9850b1 = 14 checks, all passing (guards against silent scorer drift)', oracle.c1d6770715.hidden.total === 28 && oracle['8d08bc3621'].hidden.total === 7 && oracle['070e9850b1'].hidden.total === 14 && ORACLE_OK.every((id) => oracle[id].hidden.failing.length === 0), ORACLE_OK.map((id) => `${id}:${oracle[id].hidden.total}`).join(' '));

// ============ C. determinism ===============================================================================
const again = await run('c1d6770715', 'oracle');
check('C1', 'C determinism', 'same task + same oracle twice: identical final patch and identical round-1 prompt (path-independent)',
  sha256(fs.readFileSync(path.join(ART, path.basename(oracle.c1d6770715.cleanup.artifacts_dir), 'final.patch'), 'utf8')) === sha256(fs.readFileSync(path.join(ART, path.basename(again.cleanup.artifacts_dir), 'final.patch'), 'utf8')) && oracle.c1d6770715.model_calls[0].promptSha256 === again.model_calls[0].promptSha256,
  `${oracle.c1d6770715.model_calls[0].promptSha256.slice(0, 12)} vs ${again.model_calls[0].promptSha256.slice(0, 12)}`);

// ============ D. secrecy + isolation facts over EVERY run =====================================================
const all = runs.map((r) => r.rec).filter((r) => r.leak);
check('D1', 'D secrecy', 'no reference SHA / hidden-scorer token in any snapshot (all runs)', all.every((r) => r.leak.snapshot_hits.length === 0), JSON.stringify(all.filter((r) => r.leak.snapshot_hits.length).map((r) => r.leak.snapshot_hits)));
check('D2', 'D secrecy', 'no reference SHA / scorer token / reference-added source line in any x-task text', all.every((r) => r.leak.task_hits.length === 0 && r.leak.task_reference_line_hits.length === 0), JSON.stringify(all.map((r) => [r.leak.task_hits, r.leak.task_reference_line_hits]).filter(([a, b]) => a.length || b.length)));
check('D3', 'D secrecy', 'no reference SHA / scorer token / reference-added source line in the round-1 model prompt', all.filter((r) => r.leak.prompt_hits).every((r) => r.leak.prompt_hits.length === 0 && r.leak.prompt_reference_line_hits.length === 0), JSON.stringify(all.map((r) => [r.leak.prompt_hits, r.leak.prompt_reference_line_hits]).filter(([a, b]) => a?.length || b?.length)));
const ctl = fs.mkdtempSync(path.join(WORK, 'ctl-')); const tok = scorerTokens(T('c1d6770715')).find((t) => t.length > 20);
fs.writeFileSync(path.join(ctl, 'a.txt'), `noise ${tok} noise`);
check('D4', 'D secrecy', 'POSITIVE CONTROL: the leak scanner does detect a planted scorer token (file scan and prompt scan), so "no hits" is not vacuous', grepTree(ctl, [tok]).length === 1 && findTokens(`x ${tok} y`, [tok]).length === 1, tok);
fs.rmSync(ctl, { recursive: true, force: true });
check('D5', 'D secrecy', 'scanner inputs stay non-vacuous per task AFTER excluding natural-text tokens (>=2 SHA tokens, >=5 scorer tokens used, >=1 reference-added line)', TASKS.every((t) => shaTokens(t).length >= 2 && referenceAddedLines(t).length >= 1) && all.every((r) => r.leak.tokens_used >= 7), all.map((r) => `${r.task.id}:used=${r.leak.tokens_used},excluded=${r.leak.natural_tokens_excluded.length}`).filter((v, i, a) => a.indexOf(v) === i).join(' '));
check('D6', 'D secrecy', 'hidden scorer lives outside every snapshot and started only AFTER X ended (all runs that scored)', all.every((r) => r.isolation.scorer_outside_snapshot) && runs.map((r) => r.rec).filter((r) => r.hidden).every((r) => r.hidden.started_after_x_ended), '');
check('D7', 'D secrecy', 'no task id / commit SHA in the workspace directory name X can observe', all.every((r) => /^ws-[A-Za-z0-9]{6}$/.test(r.isolation.snapshot_dirname)), all.map((r) => r.isolation.snapshot_dirname).join(','));
check('E1', 'E isolation', 'every snapshot: exactly 1 reachable commit ("baseline"), no remotes, only refs/heads/main', all.every((r) => r.isolation.commits_reachable === 1 && r.isolation.remotes === '' && r.isolation.refs.length === 1 && r.isolation.refs[0] === 'refs/heads/main'), JSON.stringify(all.map((r) => r.isolation.refs)));
check('E2', 'E isolation', "X's own git_inspect (log/head/branch) in the snapshot shows only the baseline commit", all.every((r) => /^[0-9a-f]{7} baseline$/.test(r.isolation.git_inspect_view.log) && r.isolation.git_inspect_view.branch === 'main'), JSON.stringify(all[0].isolation.git_inspect_view));
check('E3', 'E isolation', 'executor module and eval dir are both outside every snapshot; every snapshot is outside the repo', all.every((r) => r.isolation.executor_outside_snapshot && r.isolation.snapshot_is_outside_repo), '');
check('E4', 'E isolation', 'X could not move HEAD (commit_policy never): HEAD is still the baseline in every scored run', runs.map((r) => r.rec).filter((r) => r.checks?.head_unchanged !== undefined).every((r) => r.checks.head_unchanged === true), '');
check('E5', 'E isolation', 'provenance recorded on every run and limited to historical / historical_derived; tiers match the Step-4 plan', runs.every((r) => ['historical', 'historical_derived'].includes(r.rec.validator_provenance)) && TASKS.filter((t) => t.tier === 'A').every((t) => t.provenance === 'historical') && TASKS.filter((t) => t.tier === 'B').every((t) => t.provenance === 'historical_derived'), TASKS.map((t) => `${t.id}:${t.tier}:${t.provenance}`).join(' '));

// ============ F. cleanup + main checkout integrity ================================================================
check('F1', 'F cleanup', 'every run removed its snapshot; work dir holds no ws-*/pat-*/ctl-* leftovers', runs.every((r) => r.rec.cleanup.snapshot_removed) && fs.readdirSync(WORK).filter((n) => /^(ws|pat|ctl)-/.test(n)).length === 0, fs.readdirSync(WORK).join(','));
const pg = spawnSync('pgrep', ['-f', WORK]);
check('F2', 'F cleanup', 'no process left running with the work dir in its command line', pg.status === 1, pg.stdout?.toString().trim());
check('F3', 'F cleanup', 'artifacts (run-record.json, final.patch) are outside the snapshot and survived cleanup', runs.every((r) => fs.existsSync(path.join(r.rec.cleanup.artifacts_dir, 'run-record.json'))), '');
const after = { exec: executorIdentity(), head: gitRepo(['rev-parse', 'HEAD']).trim(), status: gitRepo(['status', '--porcelain']) };
const candVerdict = verifyCandidate();
check('F4', 'F frozen X', 'frozen X v0.2 candidate untouched: content hash of the X file closure and of the X test files identical before/after all runs, and equal to scripts/x-eval/x-v02-candidate.json (Gold fingerprint also equals the manifest)', before.cand.x_sha256 === xCandidateIdentity().x_sha256 && before.cand.tests_sha256 === xCandidateIdentity().tests_sha256 && candVerdict.ok, JSON.stringify({ problems: candVerdict.problems, x: before.cand.x_sha256.slice(0, 16) }));
check('F5', 'F frozen X', 'main checkout untouched: HEAD and `git status --porcelain` identical before/after', before.head === after.head && before.status === after.status, `${before.status.trim()} | ${after.status.trim()}`);
check('F6', 'F frozen X', 'no stray probe files were created in the main checkout or eval dir', !fs.existsSync(abs) && !fs.existsSync(esc), '');

const passed = results.filter((r) => r.ok).length;
fs.writeFileSync(values.out, `${JSON.stringify({ runner: 'x-eval-runner-v1', node: process.version, results, summary: { total: results.length, passed, failed: results.length - passed },
  runs: runs.map((r) => ({ task: r.taskId, stub: r.stub, outcome: r.rec.outcome, model_calls: r.rec.model_calls.length, total_ms: r.rec.timing.total_ms, hidden: r.rec.hidden ? `${r.rec.hidden.total - r.rec.hidden.failing.length}/${r.rec.hidden.total}` : null })) }, null, 2)}\n`);
console.error(`\n${passed}/${results.length} checks passed; ${runs.length} runs`);
process.exit(passed === results.length ? 0 : 1);
