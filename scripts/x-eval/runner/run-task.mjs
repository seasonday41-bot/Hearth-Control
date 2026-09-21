// X-Eval v1 Step 5 - run ONE task through the Isolated Snapshot Runner (eval-only).
//
//   frozen X v0.1 (main checkout)  ->  snapshot(parent + baseline commit + visible validator ONLY)
//   preflight (validators must FAIL at baseline)  ->  X  ->  external checks  ->  hidden scorer (outside)  ->  cleanup
//
// The model adapter is injected. Step 5 only supplies stubs (runner/stubs.mjs); no real model is wired here.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  EVAL_DIR, REPO, sha256, loadFrozenX, executorIdentity, createSnapshot, buildVisibleFiles, runHiddenScorer,
  uniqueScorerTokens, shaTokens, referenceAddedLines, grepTree, findTokens, gitIn,
} from './lib.mjs';
import { TASKS, ACCEPTED_PROVENANCE } from '../tasks/tasks-v1.mjs';
import { LANES, evalOverrides, effectiveConfig } from './lanes.mjs';
import { scoreFinalTree } from './score.mjs';

export const RUNNER_VERSION = 'x-eval-runner-v3-gold-v1.1';

/** Wraps an adapter and records every call: exact request, options, raw response, wall time. Never alters either. */
const recordingAdapter = (inner, calls) => ({
  async generate(request, options) {
    const startedAt = Date.now();
    const result = await inner.generate(request, options);
    const promptText = (request.messages ?? []).map((m) => m.content).join('\n');
    const { signal: _signal, ...recordedOptions } = options ?? {};
    const longResponse = Boolean(options?.longResponse ?? request.longResponse);
    const passedNumPredict = options?.num_predict ?? request.num_predict ?? null;
    calls.push({
      index: calls.length, startedAt, ms: Date.now() - startedAt, promptBytes: Buffer.byteLength(promptText), promptSha256: sha256(promptText),
      messages: request.messages, format: request.format ?? null, options: recordedOptions, request_num_predict: request.num_predict ?? null, request_long_response: request.longResponse ?? null,
      effective_num_predict: longResponse ? Math.max(passedNumPredict ?? 0, 4096) : passedNumPredict,
      result: { ok: result?.ok ?? null, model: result?.model ?? null, finishReason: result?.finishReason ?? null, text: result?.text ?? null, error: result?.error ?? null },
    });
    return result;
  },
  cancel: inner.cancel?.bind(inner),
});

export async function runTask({ task, adapterFactory, adapterName, workRoot, artifactsRoot, sample = 0, keep = false, baselineRev = null, lane = LANES.model_quality, guard = null }) {
  const contextOptions = lane.contextOptions;
  const modelOptions = lane.modelOptions;
  if (!ACCEPTED_PROVENANCE.includes(task.provenance)) throw new Error(`refused: validator_provenance '${task.provenance}' is not accepted for Gold v1`);
  const frozen = await loadFrozenX();
  const runId = `${task.id}-${adapterName.replace(/[^a-z0-9]+/gi, '-')}-s${sample}-${Date.now().toString(36)}`;
  const artifactsDir = path.join(artifactsRoot, runId);
  fs.mkdirSync(artifactsDir, { recursive: true });
  const record = {
    runner: RUNNER_VERSION, run_id: runId, task: { id: task.id, tier: task.tier, hint_level: task.hint_level }, validator_provenance: task.provenance,
    lane: lane.id, eval_overrides: evalOverrides(lane), effective_config: effectiveConfig(lane), gold: task.gold ?? null,
    adapter: adapterName, sample, executor: { ...executorIdentity(), module: frozen.modulePath, model_options: modelOptions ?? null, context_options: contextOptions ?? null },
    preflight: null, context_round1: null, model_calls: [], timing: {}, repair_outcome: null, gate_result: null, x_result: null, x_error: null,
    diff: null, checks: { out_of_scope: [], test_tampering: [], wrong_file: null }, hidden: null, leak: null, isolation: null, outcome: null, cleanup: null,
  };
  let snap = null;
  const t0 = Date.now();
  try {
    // 1-3. snapshot: parent tree + ONE baseline commit + the visible validator only
    const visibleFiles = await buildVisibleFiles(task);
    snap = createSnapshot({ workRoot, rev: baselineRev ?? task.parent, injectFiles: visibleFiles });
    const visibleHashes = Object.fromEntries(visibleFiles.map((f) => [f.file, sha256(f.content)]));

    // isolation facts (recorded, asserted by the smoke)
    const gw = new frozen.ReadOnlyToolGateway({ workspace: snap.root });
    const gitView = {}; for (const op of ['branch', 'head', 'log', 'status']) gitView[op] = String(await gw.gitInspect({ operation: op }).then((r) => r.output).catch((e) => `ERR ${e.message}`)).trim();
    record.isolation = {
      snapshot_is_outside_repo: !path.resolve(snap.root).startsWith(`${REPO}${path.sep}`), snapshot_dirname: path.basename(snap.root),
      commits_reachable: Number(gitIn(snap.root, ['rev-list', '--all', '--count']).trim()), remotes: gitIn(snap.root, ['remote']).trim(),
      refs: gitIn(snap.root, ['for-each-ref', '--format=%(refname)']).trim().split('\n').filter(Boolean),
      executor_outside_snapshot: !path.resolve(frozen.modulePath).startsWith(`${path.resolve(snap.root)}${path.sep}`),
      scorer_outside_snapshot: !path.resolve(EVAL_DIR).startsWith(`${path.resolve(snap.root)}${path.sep}`), git_inspect_view: gitView,
    };

    // 4. preflight: BOTH validators must fail at the baseline, or the run is a harness error and the model is never called
    const visibleCmd = task.xTask.validation.required[0];
    const [pv] = await frozen.runRequiredValidation({ workspace: { root: snap.root }, scope: { allowed_paths: ['x'] }, validation: { required: [visibleCmd], optional: [] } }, {});
    const ph = await runHiddenScorer(task, snap.root);
    record.preflight = { ok: pv.status === 'failed' && ph.status === 'failed' && !ph.crashed, visible_at_baseline: pv.status, hidden_at_baseline: ph.status, hidden_crashed: ph.crashed };
    if (!record.preflight.ok) { record.outcome = { label: 'HARNESS_ERROR', reason: 'preflight: a validator did not fail at the baseline' }; return record; }

    // 5. build the x-task-v1 (workspace = snapshot only)
    const xtask = frozen.parseXTask({ ...task.xTask, task_id: `XEVAL-${sha256(task.id).slice(0, 8)}`, workspace: { repo: 'Hearth-Control', root: snap.root } });

    // leak scan BEFORE the model: snapshot content + task text
    const uniq = uniqueScorerTokens(task, visibleFiles);
    const tokens = [...shaTokens(task), ...uniq.tokens];
    const added = referenceAddedLines(task);
    record.leak = { tokens_used: tokens.length, natural_tokens_excluded: uniq.excluded, snapshot_hits: grepTree(snap.root, tokens), task_hits: findTokens(JSON.stringify(xtask), tokens), task_reference_line_hits: findTokens(JSON.stringify(xtask), added), prompt_hits: null, prompt_reference_line_hits: null };

    // round-1 context packet as X will load it (deterministic on the unchanged tree)
    const packet = await frozen.loadTaskContext(xtask, contextOptions);
    record.context_round1 = { files: packet.files.map((f) => ({ path: f.path, status: f.status, bytes: f.bytes })), omitted: packet.omitted, blockers: packet.blockers, search_results: packet.search_results.length,
      oracle_files_in_context: task.oracle_files.map((f) => ({ file: f, status: packet.files.find((x) => x.path === f)?.status ?? 'absent' })) };

    // 6. run the FROZEN X against the snapshot
    const inner = adapterFactory({ task, xtask, snapshotRoot: snap.root, visibleFiles });
    const calls = record.model_calls;
    const tx = Date.now();
    try {
      const { repairOutcome, gateResult, xResult } = await frozen.executeXTask(xtask, recordingAdapter(inner, calls), { contextOptions, modelOptions, signal: guard?.signal });
      record.repair_outcome = repairOutcome; record.gate_result = gateResult; record.x_result = xResult;
    } catch (error) { record.x_error = { name: error?.name ?? 'Error', message: String(error?.message ?? error).slice(0, 500) }; }
    record.timing = { x_start: tx, x_end: Date.now(), x_ms: Date.now() - tx };
    if (guard?.signal?.aborted) record.stopped_by_guard = String(guard.signal.reason?.message ?? 'guard abort');
    if (calls[0]) {
      const p0 = calls[0].messages.map((m) => m.content).join('\n');
      record.leak.prompt_hits = findTokens(p0, tokens); record.leak.prompt_reference_line_hits = findTokens(p0, added);
    }

    // 7-9. ONE scoring path (score.mjs): diff, scope/tamper, hidden scorer (outside, after X), regression net, outcome
    const scored = await scoreFinalTree({ frozen, task, xtask, snapshot: snap, visibleHashes, gate: record.gate_result, xError: record.x_error, guardStop: record.stopped_by_guard ?? null });
    record.diff = scored.diff; record.checks = scored.checks; record.hidden = scored.hidden; record.regression_net = scored.regression_net; record.integrity = scored.integrity; record.outcome = scored.outcome;
    record.hidden.started_after_x_ended = record.hidden.startedAt >= record.timing.x_end;
    return record;
  } catch (error) {
    record.outcome = { label: 'HARNESS_ERROR', reason: `runner: ${String(error?.message ?? error).slice(0, 400)}` };
    return record;
  } finally {
    record.timing.total_ms = Date.now() - t0;
    const snapshotRoot = snap?.root;
    if (snapshotRoot && !keep) fs.rmSync(snapshotRoot, { recursive: true, force: true });
    record.cleanup = { snapshot_removed: snapshotRoot ? !fs.existsSync(snapshotRoot) : true, kept: keep && !!snapshotRoot, artifacts_dir: artifactsDir };
    // artifacts live OUTSIDE the snapshot; the patch is stored separately from the record
    if (record.diff) { fs.writeFileSync(path.join(artifactsDir, 'final.patch'), record.diff.patch); record.diff = { numstat: record.diff.numstat, status: record.diff.status, patch_file: 'final.patch' }; }
    fs.writeFileSync(path.join(artifactsDir, 'run-record.json'), `${JSON.stringify(record, null, 2)}\n`);
  }
}

// ---- CLI ------------------------------------------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const { values } = parseArgs({ options: { task: { type: 'string' }, adapter: { type: 'string', default: 'stub:noop' }, 'work-dir': { type: 'string' }, 'artifacts-dir': { type: 'string' }, keep: { type: 'boolean', default: false } } });
  if (!values.task || !values['work-dir'] || !values['artifacts-dir']) { console.error('usage: run-task.mjs --task <id> [--adapter stub:<name>] --work-dir D --artifacts-dir A [--keep]'); process.exit(2); }
  if (!values.adapter.startsWith('stub:')) { console.error('Only stub adapters are enabled in Step 5. A real model is wired in Step 6, after the smoke passes.'); process.exit(2); }
  const { makeStub } = await import('./stubs.mjs');
  const task = TASKS.find((t) => t.id === values.task);
  if (!task) { console.error(`unknown task ${values.task}`); process.exit(2); }
  const rec = await runTask({ task, adapterFactory: (ctx) => makeStub(values.adapter.slice(5), ctx), adapterName: values.adapter, workRoot: path.resolve(values['work-dir']), artifactsRoot: path.resolve(values['artifacts-dir']), keep: values.keep });
  console.log(JSON.stringify({ run_id: rec.run_id, outcome: rec.outcome, artifacts: rec.cleanup.artifacts_dir }, null, 2));
}
