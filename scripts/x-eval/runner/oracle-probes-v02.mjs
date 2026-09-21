#!/usr/bin/env node
// X v0.2 Slice 1: oracle re-test of the two STRUCTURAL_PROBE tasks (4f261b2f4b, 79664a00cc). Stub model only: no Ollama.
// The oracle replays the reference fix. Task copies are built HERE (the locked Gold task definitions are not edited); a copy
// differs from the Gold task only by adding `path:START-END` hints to `suspected_area`, derived from the reference edits.
//   node scripts/x-eval/runner/oracle-probes-v02.mjs --work-dir D --artifacts-dir A [--out FILE]
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { EVAL_DIR, gitShow, executorIdentity, lockFingerprint } from './lib.mjs';
import { runTask } from './run-task.mjs';
import { makeStub, referenceEdits } from './stubs.mjs';
import { LANES } from './lanes.mjs';
import { TASKS } from '../tasks/tasks-v1.mjs';

const { values } = parseArgs({ options: { 'work-dir': { type: 'string' }, 'artifacts-dir': { type: 'string' }, out: { type: 'string', default: path.join(EVAL_DIR, 'oracle-probes-v02-results.json') } } });
if (!values['work-dir'] || !values['artifacts-dir']) { console.error('--work-dir and --artifacts-dir are required'); process.exit(2); }

const lineSpan = (text, needle) => { const at = text.indexOf(needle); if (at < 0) throw new Error('edit text not found in parent'); const start = text.slice(0, at).split('\n').length; return [start, start + needle.split('\n').length - 1]; };
const rangesFor = (task) => task.oracle_files.flatMap((file) => {
  const parentText = gitShow(task.parent, file);
  return referenceEdits(task.parent, task.fixed, file).map((e) => lineSpan(parentText, e.old_string)).map(([a, b]) => `${file}:${a}-${b}`);
});
const withHints = (task, hints) => ({ ...task, xTask: { ...task.xTask, suspected_area: hints } });

const CONFIGS = [
  { id: 'A. locked Gold task (file-level hint, NO ranges), model_quality', lane: LANES.model_quality, hints: () => null, expect: 'FAILURE (unchanged: X v0.2 changes nothing without a range hint)' },
  { id: 'B. + range hints, model_quality (20,000 B/file)', lane: LANES.model_quality, hints: (t) => rangesFor(t), expect: 'SUCCESS' },
  { id: 'C. + range hints, production_capability (DEFAULT 8,000 B/file, no override)', lane: LANES.production_capability, hints: (t) => rangesFor(t), expect: 'SUCCESS (no global cap raised)' },
  { id: 'D. NEGATIVE: hint covers only the FIRST edit; the oracle also edits an unshown region', lane: LANES.production_capability, hints: (t) => rangesFor(t).slice(0, 1), expect: 'FAILURE, file untouched (edit outside the shown excerpt refused)', needsMultiEdit: true },
];

const rows = [];
const before = { exec: executorIdentity(), fp: lockFingerprint() };
for (const task of TASKS.filter((t) => t.gold.class === 'STRUCTURAL_PROBE')) {
  for (const cfg of CONFIGS) {
    const hints = cfg.hints(task);
    if (cfg.needsMultiEdit && rangesFor(task).length < 2) { rows.push({ task: task.id, config: cfg.id, skipped: 'reference fix has a single edit hunk; nothing to leave out' }); continue; }
    const t = hints ? withHints(task, hints) : task;
    const rec = await runTask({ task: t, adapterFactory: (ctx) => makeStub('oracle', ctx), adapterName: 'stub:oracle', workRoot: path.resolve(values['work-dir']), artifactsRoot: path.resolve(values['artifacts-dir']), lane: cfg.lane });
    const blocker = rec.repair_outcome?.rounds?.[0]?.executor?.blockers?.[0] ?? null;
    const file = rec.context_round1?.files?.[0];
    rows.push({
      task: task.id, config: cfg.id, expected: cfg.expect, hints: hints ?? task.xTask.suspected_area, outcome: rec.outcome.label, gate_agrees: rec.outcome.gate_agrees ?? null,
      gate: rec.gate_result ? `${rec.gate_result.gate_status}/${rec.gate_result.reason_code}` : null, rounds: rec.repair_outcome?.total_rounds ?? null,
      context: file ? { status: file.status, bytes: file.bytes } : null, prompt_bytes: rec.model_calls[0]?.promptBytes ?? null,
      diff: rec.diff?.numstat ?? null, hidden: rec.hidden ? `${rec.hidden.total - rec.hidden.failing.length}/${rec.hidden.total}` : null, blocker: blocker ? { code: blocker.code, detail: (blocker.detail ?? '').slice(0, 170) } : null,
      integrity_ok: rec.integrity?.ok ?? null, effective_max_bytes_per_file: rec.effective_config?.maxBytesPerFile ?? null,
    });
    console.error(`${task.id} | ${cfg.id.slice(0, 60)} -> ${rec.outcome.label}${rec.outcome.gate_agrees ? ' (gate agrees)' : ''} ctx=${file?.status}/${file?.bytes}B prompt=${rec.model_calls[0]?.promptBytes}B hidden=${rows.at(-1).hidden}`);
  }
}
const after = { exec: executorIdentity() };
const out = { probe: 'x-v0.2-slice1-oracle-structural-probes', gold_fingerprint: before.fp, gold_fingerprint_expected: 'f6ac8bfae42af5c5417e2da485f1b61f94c3e3ed6bb72cf5f3f8b142a9bdc03f', executor: after.exec, rows };
fs.writeFileSync(values.out, `${JSON.stringify(out, null, 2)}\n`);
console.error(`wrote ${path.relative(process.cwd(), values.out)}`);
