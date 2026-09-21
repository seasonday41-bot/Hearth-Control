#!/usr/bin/env node
// X-Eval v1 Step 6B - real-model baseline: model_quality lane, MEASURABLE tasks only, 1 run per task.
// `--adapter stub:oracle` = dry run of the whole pipeline (sampler, guards, results) with NO Ollama.
// `--adapter ollama` needs --confirm-real-model. Any stop rule HALTS the sequence; nothing is rerun.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { EVAL_DIR, REPO, executorIdentity, lockFingerprint } from './lib.mjs';
import { runTask } from './run-task.mjs';
import { LANES, MODEL, MEMORY_GUARD, evalOverrides, effectiveConfig } from './lanes.mjs';
import { sampleOnce } from './host-sampler.mjs';
import { startSampler as startSampler1, AMENDMENT } from './runtime-protocol.mjs';
import { startSampler as startSampler2, measureBaseline, AMENDMENT2 } from './runtime-protocol-2.mjs';
import { detectExplanationActionConflicts } from './telemetry.mjs';
import { stopConditions } from './stop-rules.mjs';
import { TASKS, MEASURABLE_IDS } from '../tasks/tasks-v1.mjs';
import { makeStub } from './stubs.mjs';
import { verifyCandidate, readManifest } from './x-candidate.mjs';

const { values } = parseArgs({ options: {
  'work-dir': { type: 'string' }, 'artifacts-dir': { type: 'string' }, out: { type: 'string' }, adapter: { type: 'string', default: 'ollama' },
  'confirm-real-model': { type: 'boolean', default: false }, protocol: { type: 'string', default: '2' }, lane: { type: 'string', default: 'model_quality' }, tasks: { type: 'string' },
} });
const die = (m) => { console.error(m); process.exit(2); };
if (!values['work-dir'] || !values['artifacts-dir']) die('--work-dir and --artifacts-dir are required');
if (values.lane !== 'model_quality') die('Step 6B runs the model_quality lane only (production_capability is defined but not run yet).');
if (!['1', '2'].includes(values.protocol)) die('--protocol must be 1 or 2');
const PROTO = values.protocol === '2' ? AMENDMENT2 : AMENDMENT;
const real = values.adapter === 'ollama';
if (!real && !values.adapter.startsWith('stub:')) die("--adapter must be 'ollama' or 'stub:<name>'");
if (real && !values['confirm-real-model']) die('a real model needs --confirm-real-model');
const taskIds = values.tasks ? values.tasks.split(',') : [...MEASURABLE_IDS];
for (const id of taskIds) if (!MEASURABLE_IDS.includes(id)) die(`refused: ${id} is not a MEASURABLE Gold v1 task (STRUCTURAL_PROBE and HOLD are excluded from model-quality runs)`);
const lane = LANES.model_quality;
const out = values.out ?? path.join(EVAL_DIR, real ? 'baseline-qwen-v1-results.json' : 'baseline-dryrun-results.json');
const WORK = path.resolve(values['work-dir']); const ART = path.resolve(values['artifacts-dir']);
const sh = (c, a) => { try { return execFileSync(c, a, { encoding: 'utf8', timeout: 10_000 }).trim(); } catch { return null; } };
const OLLAMA = 'http://127.0.0.1:11434';
const getJson = async (p) => { try { return await (await fetch(`${OLLAMA}${p}`, { signal: AbortSignal.timeout(5000) })).json(); } catch { return null; } };

// ---- self-tests of the guard machinery (must pass BEFORE any model call) ------------------------------------------
const selfTest = async () => {
  const t = [];
  const feed = (arr) => { let i = 0; return async () => arr[Math.min(i++, arr.length - 1)]; };
  const base = { t: 0, pressure_level: 1, swap_used_mb: 1000, free_pct: 60, ollama_rss_mb: 0 };
  const P = { ...base, pressure_level: 2 };
  const drive = async (samples, ms = 90) => { const c = new AbortController(); const s = startSampler1({ controller: c, sampleFn: feed(samples), intervalMs: 3 }); await new Promise((r) => setTimeout(r, ms)); return { c, m: await s.stop() }; };
  let r = await drive([base, base]); t.push(['quiet host: no warn, no halt, no abort', !r.c.signal.aborted && r.m.flags.length === 0 && r.m.warnings.length === 0]);
  r = await drive([base, P, P, P, base]); t.push(['pressure>=2 x3 is a WARN only (recorded, no halt flag, no abort)', r.m.warnings.length === 1 && r.m.flags.length === 0 && !r.c.signal.aborted]);
  r = await drive([base, ...Array(20).fill(P), base]); t.push(['pressure>=2 x15 is a HALT flag (no abort)', r.m.flags.some((f) => /pressure_level>=2 for 15/.test(f)) && !r.c.signal.aborted]);
  r = await drive([base, ...Array(14).fill(P), base]); t.push(['pressure>=2 x14 then recovery is NOT a halt', r.m.flags.length === 0 && r.m.warnings.length === 1]);
  r = await drive([base, { ...base, swap_used_mb: 1520 }]); t.push(['swap growth >= 512 MB is a HALT flag (no abort)', r.m.flags.some((f) => /swap_growth>=512/.test(f)) && !r.c.signal.aborted]);
  r = await drive([base, { ...base, swap_used_mb: 1400 }]); t.push(['swap growth 400 MB is not a halt', r.m.flags.length === 0]);
  r = await drive([base, ...Array(4).fill({ ...base, free_pct: 9 }), base]); t.push(['free < 10% x3 is a HALT flag (no abort)', r.m.flags.some((f) => /free_pct<10/.test(f)) && !r.c.signal.aborted]);
  r = await drive([base, { ...base, free_pct: 9 }, { ...base, free_pct: 9 }, base]); t.push(['free < 10% x2 then recovery is not a halt', r.m.flags.length === 0]);
  r = await drive([base, { ...base, pressure_level: 4 }]); t.push(['ABORT: pressure level 4 (unchanged)', r.c.signal.aborted && /pressure_level>=4/.test(r.m.aborted)]);
  r = await drive([base, { ...base, swap_used_mb: 3100 }]); t.push(['ABORT: swap growth >= 2048 MB (unchanged)', r.c.signal.aborted && /swap_growth>=2048/.test(r.m.aborted)]);
  r = await drive([base, { ...base, free_pct: 4 }]); t.push(['ABORT: free < 5% single sample (unchanged)', r.c.signal.aborted && /free_pct<5/.test(r.m.aborted)]);
  if (values.protocol === '2') {
    t.length = 0; // amendment 2 replaces the pressure tests of amendment 1
    const d2 = async (baselinePressure, samples, ms = 90) => { const c = new AbortController(); const s = startSampler2({ baselinePressure, controller: c, sampleFn: feed(samples), intervalMs: 3 }); await new Promise((r) => setTimeout(r, ms)); return { c, m: await s.stop() }; };
    const L = (n) => ({ ...base, pressure_level: n });
    let q = await measureBaseline({ sampleFn: feed([L(1), L(1), L(2), L(1), L(1)]), intervalMs: 1 });
    t.push(['baseline = median of 5 samples ([1,1,2,1,1] -> 1) and start is allowed', q.baseline_pressure === 1 && q.start_allowed && q.samples.length === 5]);
    q = await measureBaseline({ sampleFn: feed([L(2), L(2), L(2), L(1), L(2)]), intervalMs: 1 }); t.push(['a steady level-2 machine gives baseline 2 and may start', q.baseline_pressure === 2 && q.start_allowed]);
    q = await measureBaseline({ sampleFn: feed([L(4), L(4), L(4), L(2), L(4)]), intervalMs: 1 }); t.push(['baseline pressure >= 3 (i.e. 4) REFUSES to start', q.baseline_pressure === 4 && !q.start_allowed && /baseline pressure 4/.test(q.refusals.join())]);
    q = await measureBaseline({ sampleFn: feed([L(1), L(1), L(1), L(1), L(4)]), intervalMs: 1 }); t.push(['median 1 but one baseline sample at an ABORT threshold also refuses', !q.start_allowed && q.baseline_pressure === 1]);
    let r = await d2(1, [L(1), L(2), L(2), L(2), L(1)]); t.push(['baseline 1: pressure > baseline x3 is a WARN only', r.m.warnings.length === 1 && r.m.flags.length === 0 && !r.c.signal.aborted]);
    r = await d2(1, [L(1), ...Array(20).fill(L(2)), L(1)]); t.push(['baseline 1: pressure >= 2 x15 is a HALT flag (no abort)', r.m.flags.some((f) => /baseline\(1\)\+1 for 15/.test(f)) && !r.c.signal.aborted]);
    r = await d2(1, [L(1), ...Array(14).fill(L(2)), L(1)]); t.push(['baseline 1: x14 then recovery is not a halt', r.m.flags.length === 0]);
    r = await d2(2, [L(2), ...Array(40).fill(L(2)), L(2)], 200); t.push(['baseline 2: staying at level 2 (the machine steady state) produces NO warn and NO halt', r.m.warnings.length === 0 && r.m.flags.length === 0 && !r.c.signal.aborted && r.m.longest_run_pressure_ge2 >= 20]);
    r = await d2(2, [L(2), L(4)]); t.push(['baseline 2: a jump to level 4 ABORTS (unchanged ABORT)', r.c.signal.aborted && /pressure_level>=4/.test(r.m.aborted)]);
    r = await d2(1, [base, { ...base, swap_used_mb: 1520 }]); t.push(['swap growth >= 512 MB is a HALT flag (no abort)', r.m.flags.some((f) => /swap_growth>=512/.test(f)) && !r.c.signal.aborted]);
    r = await d2(1, [base, { ...base, swap_used_mb: 1400 }]); t.push(['swap growth 400 MB is not a halt', r.m.flags.length === 0]);
    r = await d2(1, [base, ...Array(4).fill({ ...base, free_pct: 9 }), base]); t.push(['free < 10% x3 is a HALT flag (no abort)', r.m.flags.some((f) => /free_pct<10/.test(f)) && !r.c.signal.aborted]);
    r = await d2(1, [base, { ...base, free_pct: 9 }, { ...base, free_pct: 9 }, base]); t.push(['free < 10% x2 then recovery is not a halt', r.m.flags.length === 0]);
    r = await d2(1, [base, { ...base, swap_used_mb: 3100 }]); t.push(['ABORT: swap growth >= 2048 MB (unchanged)', r.c.signal.aborted && /swap_growth>=2048/.test(r.m.aborted)]);
    r = await d2(1, [base, { ...base, free_pct: 4 }]); t.push(['ABORT: free < 5% single sample (unchanged)', r.c.signal.aborted && /free_pct<5/.test(r.m.aborted)]);
    const tele = detectExplanationActionConflicts([{ result: { text: JSON.stringify({ explanation: 'No edit is required here.', actions: [{ type: 'patch', path: 'a', edits: [{ old_string: 'x', new_string: 'y' }] }] }) } }, { result: { text: JSON.stringify({ explanation: 'No edit is required here.', actions: [] }) } }, { result: { text: JSON.stringify({ explanation: 'Fix it.', actions: [{ type: 'create' }] }) } }, { result: { text: 'not json' } }]);
    t.push(['telemetry: conflict only when the explanation says no edit AND actions exist; 1 of 3 parseable calls; never used for outcome', tele.conflicts.length === 1 && tele.calls_examined === 3 && tele.used_for_outcome === false && tele.conflicts[0].call === 1]);
  }
  const rec = (o) => ({ model_calls: [], outcome: { label: 'FAILURE' }, ...o });
  t.push(['stop rule: finish_reason=length', stopConditions(rec({ model_calls: [{ result: { ok: true, finishReason: 'length' } }] }), {}).includes('finish_reason=length')]);
  t.push(['stop rule: model call failed', stopConditions(rec({ model_calls: [{ result: { ok: false, error: { code: 'TIMEOUT' } } }] }), {}).some((x) => /TIMEOUT/.test(x))]);
  t.push(['stop rule: harness error', stopConditions(rec({ outcome: { label: 'HARNESS_ERROR', reason: 'x' } }), {}).length === 1]);
  t.push(['stop rule: a HALT flag stops the sequence', stopConditions(rec({}), { flags: ['HALT x'] }).length === 1]);
  t.push(['stop rule: WARN alone does NOT stop', stopConditions(rec({}), { flags: [], warnings: ['w'] }).length === 0]);
  t.push(['stop rule (v1.1): outcome REVIEW halts for analysis', stopConditions(rec({ outcome: { label: 'REVIEW' } }), {}).length === 1]);
  t.push(['a clean wrong answer is NOT a stop reason', stopConditions(rec({ outcome: { label: 'FAILURE' }, model_calls: [{ result: { ok: true, finishReason: 'stop' } }] }), { flags: [], warnings: [] }).length === 0]);
  t.push(['a FALSE_SUCCESS is NOT a stop reason', stopConditions(rec({ outcome: { label: 'FALSE_SUCCESS' } }), { flags: [] }).length === 0]);
  return t;
};
const st = await selfTest();
const EXPECTED_FINGERPRINT = 'f6ac8bfae42af5c5417e2da485f1b61f94c3e3ed6bb72cf5f3f8b142a9bdc03f'; // Gold v1.2 (v1.1 was a472f193ea1e788af8cc16d1cad1facaf9018acf18c6f491f7afc7a7f22f1d12)
if (lockFingerprint() !== EXPECTED_FINGERPRINT) die(`Gold v1.1 fingerprint mismatch: ${lockFingerprint()} != ${EXPECTED_FINGERPRINT}; refusing to run`);
// X v0.2: the executor under test must be EXACTLY the frozen candidate (scripts/x-eval/x-v02-candidate.json), or nothing runs.
const candidateCheck = verifyCandidate();
if (!candidateCheck.ok) die(`X candidate freeze check failed; refusing to run:\n- ${candidateCheck.problems.join('\n- ')}`);
for (const [n, ok] of st) console.error(`${ok ? 'PASS' : 'FAIL'}  guard self-test: ${n}`);
if (!st.every(([, ok]) => ok)) die('guard self-test failed; refusing to run');

// ---- environment + adapter --------------------------------------------------------------------------------------------
const result = {
  protocol: 'x-eval-baseline-v1', started_at: new Date().toISOString(), adapter: values.adapter, lane: lane.id, lock_fingerprint: lockFingerprint(),
  effective_config: effectiveConfig(lane), eval_overrides: evalOverrides(lane), runtime_protocol: PROTO, gold_v1_1_memory_guard_superseded: MEMORY_GUARD, executor: executorIdentity(), x_candidate: { manifest: 'scripts/x-eval/x-v02-candidate.json', x_sha256: readManifest().x_sha256, tests_sha256: readManifest().tests_sha256, x_file_count: readManifest().x_file_count, verified_at_start: true },
  machine: { model: sh('sysctl', ['-n', 'hw.model']), chip: sh('sysctl', ['-n', 'machdep.cpu.brand_string']), ram_gb: os.totalmem() / 2 ** 30, macos: sh('sw_vers', ['-productVersion']), node: process.version },
  host_before: await sampleOnce(), ollama: null, warmup: null, baseline_measurement: null, runs: [], halted: null,
};
let adapterFactory;
if (real) {
  const [ver, tags] = await Promise.all([getJson('/api/version'), getJson('/api/tags')]);
  const tag = tags?.models?.find((m) => m.name === MODEL);
  if (!ver || !tag) die(`Ollama not reachable or model '${MODEL}' not installed (this runner never pulls models).`);
  result.ollama = { version: ver.version, model: tag.name, digest: tag.digest, size_bytes: tag.size, details: tag.details };
  const { createOllamaModelAdapter } = await import(pathToFileURL(path.join(REPO, 'mcp/x/model-adapter.mjs')).href);
  const adapter = createOllamaModelAdapter();
  adapterFactory = () => adapter;
  // warm-up: load the model with the LANE's num_ctx so load time is not charged to task 1. Not scored.
  const t0 = Date.now();
  const w = await adapter.generate({ messages: [{ role: 'user', content: 'Return exactly this JSON: {"ok":true}' }], format: 'json' }, { ...lane.modelOptions });
  result.warmup = { ms: Date.now() - t0, ok: w.ok, finish_reason: w.finishReason, error: w.error, text: w.text?.slice(0, 80), ollama_ps: await getJson('/api/ps') };
  console.error(`warm-up: ok=${w.ok} ${result.warmup.ms} ms; loaded context_length=${result.warmup.ollama_ps?.models?.[0]?.context_length}`);
  if (!w.ok) { result.halted = { at: 'warmup', reasons: ['warm-up failed'] }; fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`); die('warm-up failed; nothing was run'); }
} else {
  adapterFactory = (ctx) => makeStub(values.adapter.slice(5), ctx);
}

// ---- amendment 2: post-warm-up pressure baseline; refuse to start when it is already >= 3 ------------------------------------
let baselinePressure = null;
if (values.protocol === '2') {
  const bm = await measureBaseline({ intervalMs: real ? AMENDMENT2.interval_ms : 5 });
  result.baseline_measurement = bm;
  baselinePressure = bm.baseline_pressure;
  console.error(`baseline (post-warm-up, ${bm.samples.length} samples): pressure=${bm.baseline_pressure} minFree=${bm.baseline_free_pct_min}% swapUsed=${bm.swap_used_mb.toFixed(0)}MB start_allowed=${bm.start_allowed}`);
  if (!bm.start_allowed) {
    result.halted = { at: 'pre-task', reasons: [`baseline refuses start: ${bm.refusals.join('; ')}`] };
    fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
    die(`NOT STARTED: ${result.halted.reasons[0]}`);
  }
}

// ---- sequential runs, halting on the first stop rule --------------------------------------------------------------------
for (const id of taskIds) {
  const task = TASKS.find((x) => x.id === id);
  const controller = new AbortController();
  const sampler = values.protocol === '2' ? startSampler2({ baselinePressure, controller }) : startSampler1({ controller });
  const rec = await runTask({ task, adapterFactory, adapterName: real ? `ollama:${MODEL}` : values.adapter, workRoot: WORK, artifactsRoot: ART, lane, guard: controller });
  const mem = await sampler.stop();
  const telemetry = detectExplanationActionConflicts(rec.model_calls); // telemetry only: never passed to stopConditions or the outcome
  if (rec.cleanup?.artifacts_dir) fs.writeFileSync(path.join(rec.cleanup.artifacts_dir, 'telemetry.json'), `${JSON.stringify(telemetry, null, 2)}\n`);
  const reasons = stopConditions(rec, mem);
  const calls = rec.model_calls;
  const summary = {
    task: id, gold_class: task.gold.class, interpretation: task.gold.interpretation, tier: task.tier, provenance: task.provenance, outcome: rec.outcome, gate: rec.gate_result ? { status: rec.gate_result.gate_status, reason_code: rec.gate_result.reason_code } : null,
    repair_status: rec.repair_outcome?.status ?? null, rounds: rec.repair_outcome?.total_rounds ?? null, model_calls: calls.length, finish_reasons: calls.map((c) => c.result?.finishReason ?? null),
    prompt_bytes: calls.map((c) => c.promptBytes), response_chars: calls.map((c) => c.result?.text?.length ?? 0), call_ms: calls.map((c) => c.ms), x_ms: rec.timing?.x_ms ?? null, total_ms: rec.timing?.total_ms ?? null,
    diff: rec.diff?.numstat ?? null, hidden: rec.hidden ? `${rec.hidden.total - rec.hidden.failing.length}/${rec.hidden.total}` : null, checks: rec.checks, context_round1: rec.context_round1?.files ?? null,
    memory: mem, telemetry: { explanation_action_conflict: telemetry }, ollama_ps: real ? await getJson('/api/ps') : null, stop_reasons: reasons, artifacts_dir: rec.cleanup?.artifacts_dir,
  };
  result.runs.push(summary);
  console.error(`${id}: ${rec.outcome.label} rounds=${summary.rounds} calls=${calls.length} finish=${summary.finish_reasons.join(',')} x=${summary.x_ms}ms hidden=${summary.hidden} mem(minFree=${mem.min_free_pct}% swap+${mem.swap_growth_mb_max}MB lvl=${mem.max_pressure_level})`);
  fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  if (reasons.length) { result.halted = { at: id, reasons }; console.error(`HALT at ${id}: ${reasons.join(' | ')}`); break; }
}
result.finished_at = new Date().toISOString();
fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
console.error(`\nwrote ${out}${result.halted ? `  (HALTED at ${result.halted.at})` : ''}`);
process.exit(result.halted ? 3 : 0);
