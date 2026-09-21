#!/usr/bin/env node
// X v0.2 Slice 2: deterministic retrieval probes. Stub (oracle) model only: no Ollama. The locked Gold task definitions are
// NOT edited or given ranges; lanes are copied here only to switch retrieval off for a control.
//   node scripts/x-eval/runner/oracle-probes-v02-slice2.mjs --work-dir D --artifacts-dir A [--out FILE]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { EVAL_DIR, executorIdentity, lockFingerprint } from './lib.mjs';
import { runTask } from './run-task.mjs';
import { makeStub } from './stubs.mjs';
import { LANES } from './lanes.mjs';
import { TASKS } from '../tasks/tasks-v1.mjs';

const { values } = parseArgs({ options: { 'work-dir': { type: 'string' }, 'artifacts-dir': { type: 'string' }, out: { type: 'string', default: path.join(EVAL_DIR, 'oracle-probes-v02-slice2-results.json') } } });
if (!values['work-dir'] || !values['artifacts-dir']) { console.error('--work-dir and --artifacts-dir are required'); process.exit(2); }
const off = (lane) => ({ ...lane, contextOptions: { ...(lane.contextOptions ?? {}), retrieval: false } });
const LANE = { mq: LANES.model_quality, mq_off: off(LANES.model_quality), prod: LANES.production_capability, prod_off: off(LANES.production_capability) };
const T = (id) => TASKS.find((t) => t.id === id);
// Cross-file retrieval probe (NOT a Gold task): the same 8d08bc3621 task text and hidden scorer, plus an EXPLICIT read-only
// reference authority for one file. The Gold definition is not edited; this derived task exists only inside this script.
const withReference = (id, referencePaths) => { const t = T(id); return { ...t, xTask: { ...t.xTask, scope: { ...t.xTask.scope, reference_paths: referencePaths } } }; };
const TASK_FOR = { xref: () => withReference('8d08bc3621', ['electron/updater.cjs']) };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

const plan = [
  ['4f261b2f4b', 'mq_off', 'control: retrieval OFF (Slice-1 behavior)'], ['4f261b2f4b', 'mq', 'retrieval ON, model_quality (20,000 B/file)'], ['4f261b2f4b', 'prod', 'retrieval ON, production_capability (8,000 B/file, no override)'],
  ['79664a00cc', 'mq_off', 'control: retrieval OFF (Slice-1 behavior)'], ['79664a00cc', 'mq', 'retrieval ON, model_quality (20,000 B/file)'], ['79664a00cc', 'prod', 'retrieval ON, production_capability (8,000 B/file, no override)'],
  ['8d08bc3621', 'mq_off', 'control: retrieval OFF'], ['8d08bc3621', 'mq', 'retrieval ON, model_quality, STRICT Gold scope (no reference_paths)'], ['8d08bc3621', 'prod', 'retrieval ON, production_capability, STRICT Gold scope (no reference_paths)'],
  ['8d08bc3621', 'mq', 'CROSS-FILE probe: + explicit reference_paths [electron/updater.cjs], model_quality', 'xref'], ['8d08bc3621', 'prod', 'CROSS-FILE probe: + explicit reference_paths [electron/updater.cjs], production_capability', 'xref'],
  ['c1d6770715', 'mq_off', 'control: retrieval OFF'], ['c1d6770715', 'mq', 'retrieval ON'],
  ['070e9850b1', 'mq_off', 'control: retrieval OFF'], ['070e9850b1', 'mq', 'retrieval ON'],
];
const rows = [];
const fpBefore = lockFingerprint();
for (const [id, laneKey, label, variant] of plan) {
  const rec = await runTask({ task: variant ? TASK_FOR[variant]() : T(id), adapterFactory: (ctx) => makeStub('oracle', ctx), adapterName: 'stub:oracle', workRoot: path.resolve(values['work-dir']), artifactsRoot: path.resolve(values['artifacts-dir']), lane: LANE[laneKey] });
  const call = rec.model_calls[0];
  const prompt = call ? call.messages.map((m) => m.content).join('\n') : '';
  rows.push({
    task: id, variant: variant ?? null, config: label, lane: laneKey, outcome: rec.outcome.label, gate_agrees: rec.outcome.gate_agrees ?? null, hidden: rec.hidden ? `${rec.hidden.total - rec.hidden.failing.length}/${rec.hidden.total}` : null,
    files: (rec.context_round1?.files ?? []).map((f) => `${f.path}:${f.status}:${f.bytes}B`), prompt_bytes: call?.promptBytes ?? null, prompt_sha16: call ? sha(prompt) : null,
    clue_original_fs_in_prompt: prompt.includes('original-fs'), clue_asar_aware_comment_in_prompt: /ASAR-aware/.test(prompt), diff: rec.diff?.numstat ?? null, integrity_ok: rec.integrity?.ok ?? null,
    blocker: rec.repair_outcome?.rounds?.[0]?.executor?.blockers?.[0] ? String(rec.repair_outcome.rounds[0].executor.blockers[0].detail).slice(0, 150) : null,
  });
  const r = rows.at(-1);
  console.error(`${id}${variant ? '+' + variant : ''} | ${laneKey.padEnd(8)} | ${r.outcome.padEnd(8)} hidden=${r.hidden} prompt=${r.prompt_bytes}B files=${r.files.join(',')}${r.clue_original_fs_in_prompt ? ' [original-fs clue in prompt]' : ''}`);
}
fs.writeFileSync(values.out, `${JSON.stringify({ probe: 'x-v0.2-slice2-retrieval', gold_fingerprint: fpBefore, gold_fingerprint_locked: 'f6ac8bfae42af5c5417e2da485f1b61f94c3e3ed6bb72cf5f3f8b142a9bdc03f', executor: executorIdentity(), rows }, null, 2)}\n`);
console.error(`wrote ${path.relative(process.cwd(), values.out)}`);
