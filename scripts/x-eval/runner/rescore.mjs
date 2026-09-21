#!/usr/bin/env node
// Offline RE-SCORING of a stored model patch through the SAME scoring path as a live run (score.mjs).
// No model call, no Ollama. Also runs the archived Gold v1 scorer for comparison.
//   node scripts/x-eval/runner/rescore.mjs --task <id> --record <run-record.json> --work-dir D [--out FILE]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createSnapshot, loadFrozenX, buildVisibleFiles, runHiddenScorer, sha256, lockFingerprint } from './lib.mjs';
import { scoreFinalTree } from './score.mjs';
import { TASKS } from '../tasks/tasks-v1.mjs';

const { values } = parseArgs({ options: { task: { type: 'string' }, record: { type: 'string' }, 'work-dir': { type: 'string' }, out: { type: 'string' } } });
const task = TASKS.find((t) => t.id === values.task);
if (!task || !values.record || !values['work-dir']) { console.error('usage: rescore.mjs --task <id> --record <run-record.json> --work-dir D [--out FILE]'); process.exit(2); }
const rec = JSON.parse(fs.readFileSync(values.record, 'utf8'));
const patch = path.resolve(path.dirname(values.record), rec.diff?.patch_file ?? 'final.patch');
const frozen = await loadFrozenX();
const visible = await buildVisibleFiles(task);
const snap = createSnapshot({ workRoot: path.resolve(values['work-dir']), rev: task.parent, injectFiles: visible });
try {
  execFileSync('git', ['apply', patch], { cwd: snap.root });
  const xtask = frozen.parseXTask({ ...task.xTask, task_id: 'XEVAL-RESCORE', workspace: { repo: 'Hearth-Control', root: snap.root } });
  const visibleHashes = Object.fromEntries(visible.map((f) => [f.file, sha256(f.content)]));
  const v1 = await runHiddenScorer({ ...task, hidden: `../scorers-v1-archive/${task.hidden}` }, snap.root);
  const scored = await scoreFinalTree({ frozen, task, xtask, snapshot: snap, visibleHashes, gate: rec.gate_result });
  const out = {
    task: task.id, lock_fingerprint: lockFingerprint(), source_run: rec.run_id, source_outcome_under_v1_rules: rec.outcome,
    x_gate_recorded: rec.gate_result ? `${rec.gate_result.gate_status}/${rec.gate_result.reason_code}` : null,
    hidden_v1_archived: { status: v1.status, pass: `${v1.total - v1.failing.length}/${v1.total}` },
    hidden_current: { status: scored.hidden.status, pass: `${scored.hidden.total - scored.hidden.failing.length}/${scored.hidden.total}`, failing: scored.hidden.failing },
    regression_net: { files_run: scored.regression_net.ran, regressions: scored.regression_net.regressions, regression_details: scored.regression_net.regression_details }, checks: scored.checks, outcome_current: scored.outcome, recorded_regressions: rec.checks?.regressions ?? null,
  };
  if (values.out) fs.writeFileSync(values.out, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out, null, 2));
} finally { fs.rmSync(snap.root, { recursive: true, force: true }); }
