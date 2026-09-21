#!/usr/bin/env node
// X-Eval v1 - Step 4: validator qualification (eval-only helper).
//
// For each candidate, in ISOLATED temporary snapshots (git archive, never a
// checkout of the main working tree), proves that a validator DISCRIMINATES:
//
//   visible validator : parent(+fix's tests overlaid) must FAIL, fixed must PASS
//   hidden scorer     : parent must FAIL, fixed must PASS
//
// It does not call a model, Ollama, or X's executor. The visible validator is
// run through X's own frozen `runRequiredValidation` (import only) so the
// verdict uses X's real command allowlist, `--test-isolation=none`, env
// reduction and timeout. Hidden scorers are eval-owned scripts outside the
// snapshot; they are never part of any x-task-v1.
//
// Usage: node scripts/x-eval/qualify-validators.mjs --work-dir DIR [--only ID] [--runs 2] [--out FILE]

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

const git = (args, opts = {}) => execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
const gitShow = (rev, file) => git(['show', `${rev}:${file}`]);
const gitHas = (rev, file) => { try { git(['cat-file', '-e', `${rev}:${file}`], { stdio: 'ignore' }); return true; } catch { return false; } };

// -------------------------------------------------------------- snapshots ----

const makeSnapshot = (workDir, label, rev, overlays = []) => {
  const dir = path.join(workDir, label);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('sh', ['-c', `git -C "${REPO}" archive --format=tar "${rev}" | tar -x -C "${dir}"`]);
  // Dependencies come from the main checkout's node_modules (current versions).
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'));
  for (const { file, content } of overlays) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  return dir;
};

// ----------------------------------------------------------------- runners ----

const FAIL_NAME = /^\s*(?:✖|not ok \d+ -|FAIL)\s+(.+?)(?:\s+\([\d.]+ms\))?\s*$/;
const API_ABSENT = /does not provide an export named|is not a function|Cannot find module|is not defined|ERR_MODULE_NOT_FOUND|Cannot read properties of undefined/;

const summarize = (text) => {
  const failing = [];
  for (const line of String(text).split('\n')) {
    const m = FAIL_NAME.exec(line);
    if (m && !failing.includes(m[1]) && failing.length < 12) failing.push(m[1]);
  }
  return { failing, apiAbsent: API_ABSENT.test(text) };
};

const xRunner = await import(pathToFileURL(path.join(REPO, 'mcp/x/validation-runner.mjs')).href);

const runVisible = async (root, command) => {
  const task = { workspace: { root }, scope: { allowed_paths: ['src'] }, validation: { required: [command], optional: [] } };
  const [result] = await xRunner.runRequiredValidation(task, {});
  const out = `${result.stdout}\n${result.stderr}`;
  return { status: result.status, exitCode: result.exitCode, timedOut: result.timedOut, durationMs: result.durationMs, ...summarize(out), tail: out.trim().split('\n').slice(-6).join('\n').slice(-700) };
};

const runHidden = (root, scorer) => new Promise((resolve) => {
  const started = Date.now();
  const child = spawn(process.execPath, [scorer, '--root', root], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG },
  });
  let stdout = ''; let stderr = '';
  const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  child.on('close', (code, signal) => {
    clearTimeout(timer);
    let checks = null;
    try { checks = JSON.parse(stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop()); } catch { /* scorer crashed */ }
    const failing = checks ? checks.checks.filter((c) => !c.ok).map((c) => c.name) : [];
    resolve({
      status: signal ? 'killed' : (code === 0 ? 'passed' : 'failed'), exitCode: code, durationMs: Date.now() - started,
      total: checks ? checks.checks.length : 0,
      failing, apiAbsent: checks ? checks.checks.some((c) => !c.ok && c.kind === 'api') : API_ABSENT.test(stderr),
      crashed: checks === null, tail: (checks ? '' : `${stdout}\n${stderr}`).trim().slice(-700),
    });
  });
});

// ------------------------------------------------------------------- main ----

const { values } = parseArgs({ options: {
  'work-dir': { type: 'string' }, only: { type: 'string' }, runs: { type: 'string', default: '2' },
  out: { type: 'string', default: path.join(HERE, 'qualification-results-v1.json') },
  mutants: { type: 'boolean', default: false }, audit: { type: 'boolean', default: false }, 'skip-main': { type: 'boolean', default: false },
} });
if (!values['work-dir']) { console.error('--work-dir is required (use the session scratchpad)'); process.exit(2); }
const WORK = path.resolve(values['work-dir']);
const RUNS = Number(values.runs);
const { CANDIDATES, MUTANTS, AUDIT_MUTANTS } = await import(pathToFileURL(path.join(HERE, 'qualification', 'candidates.mjs')).href);
const { TASKS } = await import(pathToFileURL(path.join(HERE, 'tasks', 'tasks-v1.mjs')).href);
const { runNet } = await import(pathToFileURL(path.join(HERE, 'runner', 'regression-net.mjs')).href);
const { loadFrozenX } = await import(pathToFileURL(path.join(HERE, 'runner', 'lib.mjs')).href);

const repeat = async (fn) => {
  const runs = [];
  for (let i = 0; i < RUNS; i += 1) runs.push(await fn());
  const statuses = new Set(runs.map((r) => r.status));
  return { runs, stable: statuses.size === 1, status: runs[0].status, total: runs[0].total ?? null, failing: runs[0].failing, apiAbsent: runs.some((r) => r.apiAbsent), tail: runs[0].tail, durationMs: Math.max(...runs.map((r) => r.durationMs)) };
};

const results = [];
for (const cand of values['skip-main'] ? [] : CANDIDATES.filter((c) => !values.only || c.id === values.only)) {
  console.error(`\n=== ${cand.id} ${cand.label}`);
  const record = { id: cand.id, label: cand.label, parent: cand.parent, fixed: cand.fixed, phases: {} };
  const fixedSnap = makeSnapshot(WORK, `${cand.id}-fixed`, cand.fixed);
  const parentPlain = makeSnapshot(WORK, `${cand.id}-parent`, cand.parent);

  for (const v of cand.visible) {
    const overlays = v.overlay.map((o) => ({ file: o.file, content: o.derive ? o.derive(gitShow(cand.fixed, o.file)) : gitShow(cand.fixed, o.file) }));
    const parentOverlay = makeSnapshot(WORK, `${cand.id}-parent-${v.name}`, cand.parent, overlays);
    // Derived (eval-edited) variants must also be applied to the FIXED tree.
    const fixedForVisible = overlays.some((o, i) => v.overlay[i].derive) ? makeSnapshot(WORK, `${cand.id}-fixed-${v.name}`, cand.fixed, overlays) : fixedSnap;
    const phase = { command: v.command, note: v.note ?? null };
    const ownFile = v.parentOwnCommand;
    phase.parentOwn = ownFile ? await repeat(() => runVisible(parentPlain, ownFile)) : null;
    phase.parentWithFixTests = await repeat(() => runVisible(parentOverlay, v.command));
    phase.fixed = await repeat(() => runVisible(fixedForVisible, v.command));
    record.phases[`visible:${v.name}`] = phase;
    console.error(`  visible:${v.name}: parentOwn=${phase.parentOwn?.status ?? 'n/a'} parent=${phase.parentWithFixTests.status} fixed=${phase.fixed.status}`);
  }
  if (cand.hidden) {
    const scorer = path.join(HERE, 'qualification', 'scorers', cand.hidden);
    const phase = { scorer: `scripts/x-eval/qualification/scorers/${cand.hidden}` };
    phase.parent = await repeat(() => runHidden(parentPlain, scorer));
    phase.fixed = await repeat(() => runHidden(fixedSnap, scorer));
    record.phases.hidden = phase;
    console.error(`  hidden: parent=${phase.parent.status} fixed=${phase.fixed.status}`);
  }
  results.push(record);
  fs.writeFileSync(values.out, `${JSON.stringify({ runs: RUNS, node: process.version, host: os.platform() + '-' + os.arch(), results }, null, 2)}\n`);
}

// --------------------------------------------------- sensitivity probe ----
const mutantResults = [];
if (values.mutants || values.audit) {
  const frozenX = TASKS.length ? await loadFrozenX() : null;
  for (const m of (values.audit ? AUDIT_MUTANTS : MUTANTS).filter((x) => !values.only || x.cand === values.only)) {
    const cand = CANDIDATES.find((c) => c.id === m.cand);
    const outcome = { cand: m.cand, id: m.id, kind: m.kind, expect: m.expect, actual: {}, ok: true };
    const applyMutation = (dir) => {
      const file = path.join(dir, m.file);
      const src = fs.readFileSync(file, 'utf8');
      const hits = src.split(m.from).length - 1;
      if (hits !== 1) throw new Error(`mutant ${m.id}: pattern found ${hits} times in ${m.file} (need exactly 1)`);
      fs.writeFileSync(file, src.replace(m.from, () => m.to));
    };
    for (const v of cand.visible) {
      const key = `visible:${v.name}`;
      if (!(key in m.expect) && !(m.observe ?? []).includes(key)) continue;
      const overlays = v.overlay.map((o) => ({ file: o.file, content: o.derive ? o.derive(gitShow(cand.fixed, o.file)) : gitShow(cand.fixed, o.file) }));
      const dir = makeSnapshot(WORK, `${cand.id}-mut-${m.id.replace(/[^a-z0-9]+/gi, '-')}-${v.name}`, cand.fixed, overlays);
      applyMutation(dir);
      const r = await runVisible(dir, v.command);
      outcome.actual[key] = r.status === 'passed' ? 'pass' : 'fail';
    }
    if ('hidden' in m.expect || 'net' in m.expect || (m.observe ?? []).includes('net')) {
      const dir = makeSnapshot(WORK, `${cand.id}-mut-${m.id.replace(/[^a-z0-9]+/gi, '-')}-hidden`, cand.fixed);
      applyMutation(dir);
      const r = await runHidden(dir, path.join(HERE, 'qualification', 'scorers', cand.hidden));
      outcome.actual.hidden = r.status === 'passed' ? 'pass' : 'fail';
      outcome.hidden_failing = r.failing.slice(0, 4);
      const task = TASKS.find((t) => t.id === m.cand);
      if (task && frozenX) { const net = await runNet(task, dir, frozenX); outcome.actual.net = net.regressions.length ? 'fail' : 'pass'; outcome.net_regressions = net.regressions.slice(0, 4); }
    }
    outcome.observe = m.observe ?? [];
    outcome.ok = Object.entries(m.expect).every(([k, v]) => outcome.actual[k] === v);
    mutantResults.push(outcome);
    console.error(`  mutant ${m.cand}/${m.id} [${m.kind}]: ${JSON.stringify(outcome.actual)} expected ${JSON.stringify(m.expect)} -> ${outcome.ok ? 'as expected' : 'UNEXPECTED'}`);
  }
  const prior = fs.existsSync(values.out) ? JSON.parse(fs.readFileSync(values.out, 'utf8')) : {};
  fs.writeFileSync(values.out, `${JSON.stringify(values.audit ? { ...prior, audit_mutants: mutantResults } : { ...prior, mutants: mutantResults }, null, 2)}\n`);
}
console.error(`\nwrote ${path.relative(process.cwd(), values.out)}`);
