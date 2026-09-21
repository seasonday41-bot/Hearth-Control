// X-Eval Gold v1.2: REGRESSION NET (eval-only, offline). v1.2: the comparison key is the TEST NAME ONLY; the failure message
// is kept as metadata (a correct fix may word its error differently from the reference fix).
//
// Idea: a fix must not break behavior it was not meant to change. For each task the net is a set of the PARENT's own
// test files: the parent version of the visible test (when it existed) plus every existing parent test that references
// the changed source file. A test name is "allowed to fail" only if it also fails at the parent (pre-existing) or at the
// REFERENCE fix (intentionally changed). Any other failing name on the final tree is a REGRESSION.
//
// The allowed-failure sets are computed once from the parent and reference trees (build) and stored, so scoring needs
// only the final tree. Net files are injected under neutral names AFTER X has finished and are removed again, so X never
// sees them and they never appear in the final diff.
import fs from 'node:fs';
import path from 'node:path';
import { EVAL_DIR, gitRepo, gitShow, createSnapshot, loadFrozenX, sha256 } from './lib.mjs';

export const NET_FILE = path.join(EVAL_DIR, 'tasks', 'regression-nets-v1.2.json');
const FAIL = /^\s*(✖|FAIL)\s+(.+?)(?:\s+\([\d.]+ms\))?\s*$/;
const clean = (s) => s.replace(/\/(?:Users|private|var|tmp)\/[^\s:)'"]*/g, '<path>').slice(0, 200);
/** Test names DECLARED in a test file's source (`test('name', ...)`), used to split "name: message" without guessing. */
export const declaredTestNames = (source) => [...String(source).matchAll(/\btest\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]).sort((x, y) => y.length - x.length);
/** Failing tests as {name, message}. `name` is the comparison key; `message` is metadata only. */
export const parseFailures = (text, declared = []) => {
  const out = new Map();
  for (const line of String(text).split('\n')) {
    const m = FAIL.exec(line);
    if (!m) continue;
    const [, marker, rest] = m;
    let name = rest; let message = '';
    if (marker === 'FAIL') { // plain-script format: "FAIL  <name>: <message>"
      const known = declared.find((d) => rest === d || rest.startsWith(`${d}:`));
      const cut = known ? known.length : rest.indexOf(': ');
      if (cut > 0) { name = rest.slice(0, cut); message = rest.slice(cut).replace(/^:\s*/, ''); }
    }
    name = clean(name);
    if (name === 'failing tests:' || out.has(name)) continue;
    out.set(name, clean(message));
  }
  return [...out].map(([name, message]) => ({ name, message }));
};
export const failingNames = (text, declared = []) => parseFailures(text, declared).map((f) => f.name);

const relatedTests = (task) => {
  const found = new Set();
  for (const f of task.oracle_files) {
    const needle = f.split('/').slice(-2).join('/');
    for (const line of (gitRepo(['grep', '-l', '-F', '-e', needle, task.parent, '--', 'scripts'], { allowFail: true }) ?? '').split('\n')) {
      const p = line.slice(task.parent.length + 1);
      if (/^scripts\/test-[A-Za-z0-9_-]+\.mjs$/.test(p)) found.add(p);
    }
  }
  return [...found].sort();
};

const runFile = async (frozen, root, file, declared = []) => {
  const [r] = await frozen.runRequiredValidation({ workspace: { root }, scope: { allowed_paths: ['x'] }, validation: { required: [`node --test ${file}`], optional: [] } }, {});
  const failures = parseFailures(`${r.stdout}\n${r.stderr}`, declared);
  return { status: r.status, failing: failures.map((f) => f.name), failures, durationMs: r.durationMs };
};
const netName = (i) => `scripts/test-xeval-net-${i}.mjs`;

/** Tree with the net files (parent versions) injected under neutral names. */
export const withNetFiles = (task, files) => files.map((f, i) => ({ file: netName(i), content: gitShow(task.parent, f.origin) }));

export async function buildNet(task, { runs = 2 } = {}) {
  const frozen = await loadFrozenX();
  const origins = [...new Set([...(task.visible_parent_exists !== false ? [task.visible_file] : []), ...relatedTests(task)])]
    .filter((f) => gitRepo(['cat-file', '-e', `${task.parent}:${f}`], { allowFail: true }) !== null);
  const files = origins.map((origin, i) => ({ origin, injected_as: netName(i) }));
  const inject = withNetFiles(task, files);
  const work = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'xeval-net-'));
  const trees = { parent: createSnapshot({ workRoot: work, rev: task.parent, injectFiles: inject }), fixed: createSnapshot({ workRoot: work, rev: task.fixed, injectFiles: inject }) };
  const out = [];
  try {
    for (const f of files) {
      const rec = { ...f, parent: [], fixed: [] };
      const declared = declaredTestNames(gitShow(task.parent, f.origin));
      for (const which of ['parent', 'fixed']) for (let k = 0; k < runs; k += 1) rec[which].push(await runFile(frozen, trees[which].root, f.injected_as, declared));
      const stable = (arr) => new Set(arr.map((r) => `${r.status}|${r.failing.join('\n')}`)).size === 1;
      rec.stable = stable(rec.parent) && stable(rec.fixed);
      rec.parent_status = rec.parent[0].status; rec.fixed_status = rec.fixed[0].status;
      rec.allowed_failures = [...new Set([...rec.parent[0].failing, ...rec.fixed[0].failing])];
      rec.allowed_failure_messages = Object.fromEntries([...rec.parent[0].failures, ...rec.fixed[0].failures].map((f) => [f.name, f.message]).filter(([, m]) => m)); // metadata only, never compared
      // A file that FAILS with no parseable test names cannot be compared name-by-name: it is only usable if it passes at both.
      rec.usable = rec.stable && ((rec.parent_status === 'passed' && rec.fixed_status === 'passed') || (rec.allowed_failures.length > 0 && rec.parent[0].status !== 'timed_out' && rec.fixed[0].status !== 'timed_out'));
      rec.max_ms = Math.max(...rec.parent.map((r) => r.durationMs), ...rec.fixed.map((r) => r.durationMs));
      delete rec.parent; delete rec.fixed;
      out.push(rec);
    }
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
  return out;
}

export const loadNets = () => JSON.parse(fs.readFileSync(NET_FILE, 'utf8')).tasks;

/** Run the net on a FINAL tree. Injects the neutral files, runs, and removes them again. */
export async function runNet(task, root, frozen) {
  const net = loadNets()[task.id];
  if (!net) return { ran: 0, regressions: [], per_file: [], note: 'no net for this task' };
  const usable = net.files.filter((f) => f.usable);
  const added = [];
  try {
    for (const f of usable) {
      const dest = path.join(root, f.injected_as);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, gitShow(task.parent, f.origin));
      added.push(dest);
    }
    const per_file = []; const regressions = []; const regression_details = [];
    for (const f of usable) {
      const r = await runFile(frozen, root, f.injected_as, declaredTestNames(gitShow(task.parent, f.origin)));
      const allowed = new Set(f.allowed_failures);
      const badFailures = r.failures.filter((x) => !allowed.has(x.name));
      const bad = badFailures.map((x) => x.name);
      const wholeFile = r.status !== 'passed' && r.failing.length === 0 && f.parent_status === 'passed' && f.fixed_status === 'passed';
      if (wholeFile) bad.push('<whole file failed / crashed>');
      for (const n of bad) regressions.push(`${f.origin}: ${n}`);
      for (const x of badFailures) regression_details.push({ file: f.origin, name: x.name, message: x.message }); // message = metadata
      per_file.push({ file: f.origin, status: r.status, failing: r.failing.length, regressions: bad.length, ms: r.durationMs });
    }
    return { ran: usable.length, skipped_unusable: net.files.length - usable.length, regressions, regression_details, per_file };
  } finally { for (const p of added) fs.rmSync(p, { force: true }); }
}
export { sha256 };
