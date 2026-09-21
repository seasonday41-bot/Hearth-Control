// Offline builder for tasks/regression-nets-v1.2.json (parent + reference trees only; no model, no Ollama).
import fs from 'node:fs';
import { TASKS } from '../tasks/tasks-v1.mjs';
import { buildNet, NET_FILE } from './regression-net.mjs';
const VISIBLE = { c1d6770715: 'scripts/test-x-result-gate.mjs', '8d08bc3621': 'scripts/test-remote-stager-electron-asar.mjs', '070e9850b1': 'scripts/test-updater.mjs' };
const tasks = {};
for (const t of TASKS.filter((x) => x.gold.class === 'MEASURABLE')) {
  const files = await buildNet({ ...t, visible_file: VISIBLE[t.id], visible_parent_exists: t.id !== '8d08bc3621' });
  tasks[t.id] = { visible_test: VISIBLE[t.id], files };
  console.error(t.id, files.map((f) => `${f.origin}[${f.parent_status}->${f.fixed_status}${f.usable ? '' : ' UNUSABLE'}${f.stable ? '' : ' UNSTABLE'} allowed=${f.allowed_failures.length} ${f.max_ms}ms]`).join('  '));
}
fs.writeFileSync(NET_FILE, `${JSON.stringify({ version: 'regression-nets-v1.2', note: 'allowed_failures = test NAMES failing at the parent or at the reference fix (pre-existing or intentionally changed); allowed_failure_messages is metadata only and is never compared. Built offline.', tasks }, null, 2)}\n`);
