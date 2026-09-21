// Step 6E analysis probe (offline, not part of the lock). Usage: node scripts/x-eval/analysis/probe-net-message-sensitivity.mjs <work-dir>
// ad-hoc offline probe (scratchpad, not part of the lock): two mutants of the FIXED updater.cjs, scored by all three layers.
import fs from 'node:fs'; import path from 'node:path';
import { createSnapshot, gitShow, loadFrozenX, runHiddenScorer, buildVisibleFiles } from '../runner/lib.mjs';
import { runNet } from '../runner/regression-net.mjs';
import { TASKS } from '../tasks/tasks-v1.mjs';
const task = TASKS.find((t) => t.id === '070e9850b1'); const frozen = await loadFrozenX(); const visible = await buildVisibleFiles(task);
const WORK = process.argv[2];
const MUT = [
  { id: 'A. behaviorally EQUIVALENT fix, different error message text', from: "throw new Error('The selected build is not newer than the currently running version.');", to: "throw new Error('The update is not newer than the running version.');" },
  { id: 'B. WRONG: publicManifest drops buildId (what the Qwen patch did)', from: 'buildId: manifest.buildId, ', to: '' },
];
for (const m of MUT) {
  const snap = createSnapshot({ workRoot: WORK, rev: task.fixed, injectFiles: visible });
  const f = path.join(snap.root, 'electron/updater.cjs'); const src = fs.readFileSync(f, 'utf8');
  const hits = src.split(m.from).length - 1; if (hits < 1) { console.log(m.id, 'anchor not found'); continue; }
  fs.writeFileSync(f, src.replace(m.from, () => m.to));
  const [v] = await frozen.runRequiredValidation({ workspace: { root: snap.root }, scope: { allowed_paths: ['x'] }, validation: { required: [task.xTask.validation.required[0]], optional: [] } }, {});
  const h = await runHiddenScorer(task, snap.root); const net = await runNet(task, snap.root, frozen);
  console.log(`${m.id}\n   visible=${v.status}  hidden=${h.status} (${h.total - h.failing.length}/${h.total})  net regressions=${net.regressions.length}${net.regressions[0] ? '  e.g. ' + net.regressions[0].slice(0, 120) : ''}`);
  fs.rmSync(snap.root, { recursive: true, force: true });
}
