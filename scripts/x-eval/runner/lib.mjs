// X-Eval v1 Step 5 - Isolated Snapshot Runner: shared helpers (eval-only).
//
// Executor = the CURRENT frozen X v0.1, imported from the main checkout.
// Target   = a temp snapshot of a historical parent (git archive + git init + one baseline commit).
// The two never share a code path, and nothing here writes inside the main checkout.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const EVAL_DIR = path.resolve(HERE, '..');
export const REPO = path.resolve(EVAL_DIR, '..', '..');
export const SCORERS_DIR = path.join(EVAL_DIR, 'qualification', 'scorers');

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---- git ------------------------------------------------------------------

const SNAP_GIT_ENV = {
  PATH: process.env.PATH, HOME: process.env.TMPDIR || '/tmp', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'x-eval', GIT_AUTHOR_EMAIL: 'x-eval@example.invalid', GIT_COMMITTER_NAME: 'x-eval', GIT_COMMITTER_EMAIL: 'x-eval@example.invalid',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z', GIT_TERMINAL_PROMPT: '0',
};
export const gitIn = (cwd, args, { allowFail = false } = {}) => {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: SNAP_GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { if (allowFail) return null; throw error; }
};
export const gitRepo = (args, opts) => gitIn(REPO, args, opts); // read-only use on the main checkout
export const gitShow = (rev, file) => gitRepo(['show', `${rev}:${file}`]);

// ---- frozen executor ---------------------------------------------------------

export const loadFrozenX = async () => {
  const imp = (rel) => import(pathToFileURL(path.join(REPO, rel)).href);
  const [exec, contract, loader, validation, gateway] = await Promise.all([
    imp('mcp/x/execute-x-task.mjs'), imp('mcp/x/task-contract.mjs'), imp('mcp/x/context-loader.mjs'),
    imp('mcp/x/validation-runner.mjs'), imp('mcp/skills/gateway.mjs'),
  ]);
  return { executeXTask: exec.executeXTask, parseXTask: contract.parseXTask, loadTaskContext: loader.loadTaskContext,
    isAuthorized: loader.isAuthorized, runRequiredValidation: validation.runRequiredValidation, ReadOnlyToolGateway: gateway.ReadOnlyToolGateway,
    modulePath: path.join(REPO, 'mcp/x/execute-x-task.mjs') };
};

export const executorIdentity = () => {
  const files = gitRepo(['ls-files', '-s', '--', 'mcp/x']);
  const clean = spawnSync('git', ['diff', '--quiet', 'HEAD', '--', 'mcp/x'], { cwd: REPO, env: SNAP_GIT_ENV }).status === 0;
  return { repo_head: gitRepo(['rev-parse', 'HEAD']).trim(), mcp_x_index_sha256: sha256(files), mcp_x_worktree_clean_vs_HEAD: clean };
};

// ---- snapshot -----------------------------------------------------------------

/** git archive <rev> -> neutral temp dir -> git init + ONE baseline commit. node_modules is a symlink excluded from git. */
export const createSnapshot = ({ workRoot, rev, injectFiles = [] }) => {
  fs.mkdirSync(workRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(workRoot, 'ws-'));
  const r = spawnSync('sh', ['-c', 'git -C "$XE_REPO" archive --format=tar "$XE_REV" | tar -x -C "$XE_DIR"'],
    { env: { ...process.env, XE_REPO: REPO, XE_REV: rev, XE_DIR: root }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`snapshot archive failed: ${r.stderr}`);
  fs.rmSync(path.join(root, 'pax_global_header'), { force: true }); // tar may materialize git archive's commit-id header
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(root, 'node_modules'));
  gitIn(root, ['init', '--quiet', '--initial-branch=main']);
  fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), 'node_modules\n');
  for (const { file, content } of injectFiles) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  gitIn(root, ['add', '-A']);
  gitIn(root, ['commit', '--quiet', '-m', 'baseline']);
  return { root, baseline: gitIn(root, ['rev-parse', 'HEAD']).trim() };
};

/** Final diff vs baseline, including new files. Stages inside the SNAPSHOT only. */
export const captureDiff = (root, baseline) => {
  gitIn(root, ['add', '-A']);
  const numstat = gitIn(root, ['diff', '--cached', '--numstat', baseline]).trim().split('\n').filter(Boolean)
    .map((l) => { const [i, d, ...p] = l.split('\t'); return { path: p.join('\t'), insertions: i === '-' ? 0 : Number(i), deletions: d === '-' ? 0 : Number(d) }; });
  const status = gitIn(root, ['diff', '--cached', '--name-status', baseline]).trim().split('\n').filter(Boolean)
    .map((l) => { const [s, ...p] = l.split('\t'); return { status: s, path: p.join('\t') }; });
  return { numstat, status, patch: gitIn(root, ['diff', '--cached', baseline]) };
};

// ---- visible validator files (reuse the Step-4 qualified variants) -----------------

export const buildVisibleFiles = async (task) => {
  const { CANDIDATES } = await import(pathToFileURL(path.join(EVAL_DIR, 'qualification', 'candidates.mjs')).href);
  const cand = CANDIDATES.find((c) => c.id === task.visible.candidate);
  const variant = cand?.visible.find((v) => v.name === task.visible.variant);
  if (!variant) throw new Error(`no qualified visible variant ${task.visible.candidate}:${task.visible.variant}`);
  return variant.overlay.map((o) => ({ file: o.file, content: o.derive ? o.derive(gitShow(cand.fixed, o.file)) : gitShow(cand.fixed, o.file) }));
};

// ---- hidden scorer (always OUTSIDE the snapshot) --------------------------------------

export const runHiddenScorer = (task, snapshotRoot) => new Promise((resolve) => {
  const scorer = path.join(SCORERS_DIR, task.hidden);
  const started = Date.now();
  const child = spawn(process.execPath, [scorer, '--root', snapshotRoot], {
    cwd: snapshotRoot, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG },
  });
  let out = ''; let err = '';
  const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  child.on('close', (code, signal) => {
    clearTimeout(timer);
    let checks = null;
    try { checks = JSON.parse(out.trim().split('\n').filter((l) => l.startsWith('{')).pop()).checks; } catch { /* crashed */ }
    resolve({ scorer: `qualification/scorers/${task.hidden}`, startedAt: started, endedAt: Date.now(), status: signal ? 'killed' : (code === 0 ? 'passed' : 'failed'),
      exitCode: code, crashed: checks === null, total: checks?.length ?? 0, failing: (checks ?? []).filter((c) => !c.ok).map((c) => c.name), tail: checks ? '' : `${out}\n${err}`.trim().slice(-500) });
  });
});

// ---- leak scanning ----------------------------------------------------------------------

/** Distinctive strings of a hidden scorer: its check names (literal only), file name, and path fragments. */
export const scorerTokens = (task) => {
  const src = fs.readFileSync(path.join(SCORERS_DIR, task.hidden), 'utf8');
  const names = [...src.matchAll(/\.check\(\s*(['"`])([^'"`$]+?)\1/g)].map((m) => m[2]).filter((s) => s.length >= 12);
  return [...new Set([...names, task.hidden, 'qualification/scorers', 'scripts/x-eval', 'x-eval/'])];
};
/** Tokens that already occur in LEGITIMATE baseline material (the injected visible validator or the parent tree)
 *  cannot prove a leak, so they are excluded; the count is recorded on the run for transparency. */
export const uniqueScorerTokens = (task, visibleFiles) => {
  const all = scorerTokens(task);
  const visibleText = visibleFiles.map((f) => f.content).join('\n');
  const natural = all.filter((t) => visibleText.includes(t) || gitRepo(['grep', '-F', '-l', '-e', t, task.parent], { allowFail: true }));
  return { tokens: all.filter((t) => !natural.includes(t)), excluded: natural };
};
export const shaTokens = (task) => {
  const full = gitRepo(['rev-parse', task.fixed]).trim();
  return [full, full.slice(0, 7), task.fixed].filter((v, i, a) => v.length >= 7 && a.indexOf(v) === i);
};
/** Whole trimmed lines the reference fix ADDED to source files (>=25 chars, absent from the parent's own text). */
export const referenceAddedLines = (task) => {
  const lines = new Set();
  for (const file of task.oracle_files) {
    const parentText = gitShow(task.parent, file);
    for (const l of gitRepo(['diff', '-U0', task.parent, task.fixed, '--', file]).split('\n')) {
      if (l.startsWith('+') && !l.startsWith('+++')) { const t = l.slice(1).trim(); if (t.length >= 25 && !parentText.includes(t)) lines.add(t); }
    }
  }
  return [...lines];
};
/** Files under `root` (skipping node_modules and git objects) that contain any token. */
export const grepTree = (root, tokens) => {
  if (!tokens.length) return [];
  const patterns = path.join(fs.mkdtempSync(path.join(path.dirname(root), 'pat-')), 'p');
  fs.writeFileSync(patterns, `${tokens.join('\n')}\n`);
  const r = spawnSync('grep', ['-rIlF', '--exclude-dir=node_modules', '--exclude-dir=objects', '-f', patterns, '.'], { cwd: root, encoding: 'utf8' });
  fs.rmSync(path.dirname(patterns), { recursive: true, force: true });
  return r.stdout.split('\n').filter(Boolean);
};
export const findTokens = (text, tokens) => tokens.filter((t) => text.includes(t));

// ---- lock fingerprint (Gold v1.2): covers task defs, lanes/guard, validator variants, ALL scorers, regression nets,
// and the scoring / stop logic. Any edit to any of them changes the hash. (Gold v1's narrower hash is kept in the docs.)
export const FINGERPRINT_INPUTS = () => [
  path.join(EVAL_DIR, 'tasks', 'tasks-v1.mjs'), path.join(EVAL_DIR, 'tasks', 'regression-nets-v1.2.json'), path.join(EVAL_DIR, 'qualification', 'candidates.mjs'),
  ...['lanes.mjs', 'score.mjs', 'regression-net.mjs', 'stop-rules.mjs', 'host-sampler.mjs', 'run-task.mjs', 'lib.mjs'].map((f) => path.join(HERE, f)),
  ...fs.readdirSync(SCORERS_DIR).sort().map((f) => path.join(SCORERS_DIR, f)),
];
export const lockFingerprint = () => sha256(FINGERPRINT_INPUTS().map((f) => `${path.relative(EVAL_DIR, f)}\n${fs.readFileSync(f, 'utf8')}`).join('\n---\n'));
