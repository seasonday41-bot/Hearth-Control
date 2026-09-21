#!/usr/bin/env node
// X-Eval v1 -- candidate mining ONLY.
//
// Reads Git history (read-only: git log / show / grep) and writes a list of
// commits that MIGHT make a good X evaluation task. It does not check out a
// worktree, run any test, call X, or touch mcp/x/*. A candidate is a
// suggestion for human review, not a benchmark task: a Git patch is only a
// usable ground truth if a human confirms the commit has a clear, testable
// specification (not a refactor or an unspecified behavior change).
//
// Usage: node scripts/x-eval/mine-candidates.mjs [--rev HEAD] [--out FILE]
//          [--max-source-files 5] [--max-source-lines 400] [--top 30]

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- git ----

const makeGit = (repo) => (args, { allowFail = false } = {}) => {
  try {
    return execFileSync('git', ['-c', 'core.quotepath=off', ...args], {
      cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (allowFail) return null; // e.g. `git grep` exits 1 on "no match", `git show` on a missing path
    throw error;
  }
};

// ---------------------------------------------------- file classification ----

const GENERATED = [
  /^electron\/(stable-)?build-meta\.json$/,
  /(^|\/)package-lock\.json$/,
  /^(dist|build|release|outputs|work|node_modules)\//,
  /^index-[\w-]+\.js$/, // bundled renderer output committed at the repo root
  /\.(png|icns|ico|jpe?g|gif|map|dmg|zip)$/i,
  /(^|\/)\.DS_Store$/,
];
const TEST = [
  /^scripts\/test-[^/]+\.(mjs|cjs|js|ts)$/,
  /\.(test|spec)\.(mjs|cjs|js|ts|tsx)$/,
  /(^|\/)__tests__\//,
];
const DOC = [/\.md$/i, /^docs\//];
const CODE = /\.(mjs|cjs|js|jsx|ts|tsx)$/;

export const classifyFile = (file) => {
  if (GENERATED.some((re) => re.test(file))) return 'generated';
  if (TEST.some((re) => re.test(file))) return 'test';
  if (DOC.some((re) => re.test(file))) return 'doc';
  if (CODE.test(file)) return 'source';
  return 'other'; // package.json, css, sql, html, mql5 ...: not counted as source
};

// Conventional-commit type, plus a looser "fix-like" reading of the subject.
export const parseSubject = (subject) => {
  const type = /^(\w+)(?:\([^)]*\))?!?:/.exec(subject)?.[1]?.toLowerCase() ?? null;
  const fixLike = type === 'fix' || /\b(fix(es|ed)?|bug|regression|hotfix|repair|correct(s|ed)?)\b/i.test(subject);
  return { type, fixLike };
};

// ------------------------------------------------------------ log parsing ----

const parseLog = (git, rev) => {
  const raw = git(['log', rev, '--format=%x1e%H%x1f%P%x1f%aI%x1f%s', '--raw', '--numstat', '--no-renames']);
  const commits = [];
  for (const chunk of raw.split('\x1e').slice(1)) {
    const lines = chunk.split('\n');
    const [commit, parents, date, subject] = lines[0].split('\x1f');
    const status = new Map();
    const stats = new Map();
    for (const line of lines.slice(1)) {
      if (line.startsWith(':')) {
        const [meta, file] = line.split('\t');
        status.set(file, meta.split(' ').pop()[0]);
        continue;
      }
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
      if (m) stats.set(m[3], { insertions: m[1] === '-' ? 0 : Number(m[1]), deletions: m[2] === '-' ? 0 : Number(m[2]) });
    }
    commits.push({
      commit, parents: parents ? parents.split(' ') : [], date, subject,
      files: [...stats.keys()].map((file) => ({ file, status: status.get(file) ?? 'M', ...stats.get(file) })),
    });
  }
  return commits;
};

const sumLines = (files) => files.reduce((acc, f) => ({
  insertions: acc.insertions + f.insertions, deletions: acc.deletions + f.deletions,
}), { insertions: 0, deletions: 0 });

// ------------------------------------------------------ validation lookup ----

const readPackageScripts = (git, rev) => {
  const text = git(['show', `${rev}:package.json`], { allowFail: true });
  try { return text ? (JSON.parse(text).scripts ?? {}) : {}; } catch { return {}; }
};

// Commands are *candidates*: nothing here has been run, and a test that passes
// at the commit may not fail at its parent. Both are checked in a later phase.
const describeTest = (git, rev, testFile, scripts) => {
  const content = git(['show', `${rev}:${testFile}`], { allowFail: true });
  if (content === null) return null; // test file was deleted by this commit
  const usesNodeTest = /from\s+['"]node:test['"]|require\(['"]node:test['"]\)/.test(content);
  return {
    file: testFile,
    command: usesNodeTest ? `node --test ${testFile}` : `node ${testFile}`,
    npm_scripts: Object.entries(scripts).filter(([, value]) => value.includes(testFile)).map(([name]) => `npm run ${name}`),
  };
};

// Existing tests at the PARENT that reference a changed source file. Imports
// are relative, so match on the last two path segments (`x/local-executor.mjs`).
const findRelatedTests = (git, parent, sourceFiles) => {
  const found = new Set();
  for (const file of sourceFiles) {
    const needle = file.split('/').slice(-2).join('/');
    const out = git(['grep', '-l', '-F', '-e', needle, parent, '--', 'scripts'], { allowFail: true });
    for (const line of (out ?? '').split('\n')) {
      const testFile = line.slice(parent.length + 1);
      if (line.startsWith(`${parent}:`) && classifyFile(testFile) === 'test') found.add(testFile);
    }
  }
  return [...found].sort();
};

// ---------------------------------------------------------------- analysis ----

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const scoreCandidate = (c) => {
  let score = 0;
  if (c.fix_like) score += 3;
  if (c.type === 'feat') score -= 1; // features rarely have a tight specification
  score += c.validation.strength === 'in_commit' ? 3 : 1;
  if (c.validation.tests.some((t) => t.npm_scripts?.length)) score += 1;
  score += c.source_files.length <= 2 ? 2 : c.source_files.length <= 4 ? 1 : 0;
  score += c.insertions + c.deletions <= 100 ? 2 : c.insertions + c.deletions <= 250 ? 1 : 0;
  if (c.touches_electron_main) score -= 2; // very large file, hard for a small local model
  return score;
};

export const analyze = (git, commits, { maxSourceFiles, maxSourceLines }) => {
  const candidates = [];
  const rejected = [];
  let sourceAndTest = 0;

  for (const c of commits) {
    const { type, fixLike } = parseSubject(c.subject);
    const byKind = { source: [], test: [], doc: [], other: [], generated: [] };
    for (const f of c.files) byKind[classifyFile(f.file)].push(f);
    const reasons = [];

    if (c.parents.length > 1) reasons.push('merge_commit');
    if (c.parents.length === 0) reasons.push('root_commit');
    if (/^chore\(release\)/i.test(c.subject)) reasons.push('release_metadata');
    if (!byKind.source.length && !reasons.length) {
      const only = c.files.length ? Object.entries(byKind).filter(([, v]) => v.length).map(([k]) => k).join('+') : 'empty';
      reasons.push(`no_source_change:${only}_only`);
    }
    if (!reasons.length) {
      if (byKind.test.length) sourceAndTest += 1;
      const sourceStat = sumLines(byKind.source);
      if (byKind.source.length > maxSourceFiles) reasons.push('too_many_source_files');
      if (sourceStat.insertions + sourceStat.deletions > maxSourceLines) reasons.push('too_large_diff');
    }

    let validation = null;
    if (!reasons.length) {
      const parent = c.parents[0];
      const scripts = readPackageScripts(git, c.commit);
      const inCommit = byKind.test.map((t) => describeTest(git, c.commit, t.file, scripts)).filter(Boolean);
      if (inCommit.length) {
        validation = { strength: 'in_commit', tests: inCommit };
      } else {
        const related = findRelatedTests(git, parent, byKind.source.map((f) => f.file))
          .map((t) => describeTest(git, parent, t, readPackageScripts(git, parent))).filter(Boolean);
        if (related.length) validation = { strength: 'existing_related', tests: related.slice(0, 6) };
      }
      if (!validation) reasons.push('no_validation');
    }

    if (reasons.length) {
      rejected.push({ commit: c.commit.slice(0, 10), subject: c.subject, reasons });
      continue;
    }

    const sourceStat = sumLines(byKind.source);
    const testStat = sumLines(byKind.test);
    const candidate = {
      commit: c.commit,
      parent: c.parents[0],
      date: c.date,
      subject: c.subject,
      type,
      fix_like: fixLike,
      changed_files: c.files.map((f) => f.file),
      source_files: byKind.source.map((f) => f.file),
      test_files: byKind.test.map((f) => f.file),
      other_files: [...byKind.doc, ...byKind.other].map((f) => f.file),
      generated_files_ignored: byKind.generated.map((f) => f.file),
      new_source_files: byKind.source.filter((f) => f.status === 'A').map((f) => f.file),
      insertions: sourceStat.insertions,
      deletions: sourceStat.deletions,
      test_insertions: testStat.insertions,
      test_deletions: testStat.deletions,
      touches_electron_main: byKind.source.some((f) => f.file === 'electron/main.cjs'),
      touches_x_core: byKind.source.some((f) => f.file.startsWith('mcp/x/')),
      touches_ui: byKind.source.some((f) => f.file.startsWith('src/')),
      validation,
    };
    candidate.score = scoreCandidate(candidate);
    candidates.push(candidate);
  }

  candidates.sort((a, b) => b.score - a.score || b.date.localeCompare(a.date));
  return { candidates, rejected, sourceAndTest };
};

// ----------------------------------------------------------------- report ----

const countBy = (items, keyFn) => {
  const counts = new Map();
  for (const item of items) for (const key of [].concat(keyFn(item))) counts.set(key, (counts.get(key) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
};

export const buildSummary = ({ commits, candidates, rejected, sourceAndTest, top }) => {
  const size = (c) => c.insertions + c.deletions;
  const fixCandidates = candidates.filter((c) => c.fix_like);
  return {
    commits_scanned: commits.length,
    candidate_count: candidates.length,
    source_and_test_commits: sourceAndTest,
    fix_like_commits_scanned: commits.filter((c) => c.parents.length === 1 && parseSubject(c.subject).fixLike).length,
    fix_like_candidates: fixCandidates.length,
    in_commit_validation: candidates.filter((c) => c.validation.strength === 'in_commit').length,
    existing_related_validation: candidates.filter((c) => c.validation.strength === 'existing_related').length,
    median_source_lines_changed: median(candidates.map(size)),
    median_source_files: median(candidates.map((c) => c.source_files.length)),
    candidates_by_type: Object.fromEntries(countBy(candidates, (c) => c.type ?? 'untyped')),
    // A commit can have several reasons; primary = the first one listed.
    rejection_primary_reason: Object.fromEntries(countBy(rejected, (r) => r.reasons[0])),
    rejection_any_reason: Object.fromEntries(countBy(rejected, (r) => r.reasons)),
    top_candidates: candidates.slice(0, top).map((c) => ({
      commit: c.commit.slice(0, 10), score: c.score, type: c.type, fix_like: c.fix_like,
      subject: c.subject, source_files: c.source_files.length, source_lines: size(c),
      validation: c.validation.strength, flags: [
        c.touches_electron_main && 'electron/main.cjs', c.touches_x_core && 'mcp/x', c.touches_ui && 'ui',
        c.new_source_files.length && `new_files=${c.new_source_files.length}`,
      ].filter(Boolean),
    })),
  };
};

const renderMarkdown = (summary, config) => {
  const table = (obj) => Object.entries(obj).map(([k, v]) => `| ${k} | ${v} |`).join('\n');
  return [
    '# X-Eval v1 -- candidate mining summary',
    '',
    `Generated by \`scripts/x-eval/mine-candidates.mjs\` at \`${config.head.slice(0, 10)}\`. Read-only; nothing here has been run.`,
    `Filters: <= ${config.maxSourceFiles} source files, <= ${config.maxSourceLines} changed source lines.`,
    '',
    '| metric | value |', '|---|---|',
    ...['commits_scanned', 'candidate_count', 'source_and_test_commits', 'fix_like_commits_scanned', 'fix_like_candidates',
      'in_commit_validation', 'existing_related_validation', 'median_source_lines_changed', 'median_source_files']
      .map((k) => `| ${k} | ${summary[k]} |`),
    '',
    '## Candidates by conventional-commit type', '', '| type | count |', '|---|---|', table(summary.candidates_by_type), '',
    '## Rejection reasons', '', '| primary reason | commits |', '|---|---|', table(summary.rejection_primary_reason), '',
    '| any reason | commits |', '|---|---|', table(summary.rejection_any_reason), '',
    `## Top ${summary.top_candidates.length} candidates (score is only a sorting aid)`, '',
    '| # | commit | score | type | src files | src lines | validation | flags | subject |', '|---|---|---|---|---|---|---|---|---|',
    ...summary.top_candidates.map((c, i) => `| ${i + 1} | ${c.commit} | ${c.score} | ${c.type ?? '-'}${c.fix_like ? ' (fix-like)' : ''} | ${c.source_files} | ${c.source_lines} | ${c.validation} | ${c.flags.join(', ') || '-'} | ${c.subject.replace(/\|/g, '\\|')} |`),
    '',
    '## Caveats', '',
    '- `in_commit` means a test file changed in the same commit; `existing_related` means an existing test at the parent references a changed source file. Neither proves the test fails at the parent and passes at the commit -- that is checked in a later phase.',
    '- Candidate commands are unverified and may depend on `node_modules` or the Electron runtime.',
    '- Human review must confirm each patch is a fix with a clear specification, not a refactor or an unspecified behavior change.',
    '',
  ].join('\n');
};

// -------------------------------------------------------------------- main ----

const main = () => {
  const { values } = parseArgs({
    options: {
      rev: { type: 'string', default: 'HEAD' },
      repo: { type: 'string' },
      out: { type: 'string', default: path.join(HERE, 'candidates.json') },
      'max-source-files': { type: 'string', default: '5' },
      'max-source-lines': { type: 'string', default: '400' },
      top: { type: 'string', default: '30' },
    },
  });
  const repo = values.repo ?? path.resolve(HERE, '..', '..');
  const git = makeGit(repo);
  const config = {
    maxSourceFiles: Number(values['max-source-files']),
    maxSourceLines: Number(values['max-source-lines']),
    rev: values.rev,
    head: git(['rev-parse', values.rev]).trim(),
  };
  const commits = parseLog(git, values.rev);
  const { candidates, rejected, sourceAndTest } = analyze(git, commits, config);
  const summary = buildSummary({ commits, candidates, rejected, sourceAndTest, top: Number(values.top) });

  fs.writeFileSync(values.out, `${JSON.stringify({ meta: { ...config, note: 'Mining output only. Human review required before any commit becomes a benchmark task.' }, summary, candidates, rejected }, null, 2)}\n`);
  const mdPath = values.out.replace(/\.json$/, '') + '-summary.md';
  fs.writeFileSync(mdPath, renderMarkdown(summary, config));
  process.stdout.write(renderMarkdown(summary, config));
  process.stdout.write(`\nWrote ${path.relative(process.cwd(), values.out)} and ${path.relative(process.cwd(), mdPath)}\n`);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
