import path from 'node:path';
import crypto from 'node:crypto';
import { readdir, stat as fsStat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { ReadOnlyToolGateway, isProtectedPath } from '../skills/gateway.mjs';
import { redactSecretContent } from './secret-guard.mjs';
import { extractTerms, extractProseStems, planRanges, locateRanges, extractRelativeImports, extractEvidenceRefs, RETRIEVAL } from './context-retrieval.mjs';

/**
 * Bounded, read-only repository context loader for x-task-v1 tasks.
 *
 * x-task-v1 -> loadTaskContext() -> small deterministic context packet -> ModelAdapter (later phase)
 *
 * This module has no write, rename, delete, chmod, process-kill, or model-
 * invocation capability. It only reads: `readdir`/`stat` (imported
 * directly, nothing else from `node:fs`), a fixed read-only `git` argv
 * (status/diff/branch/head; never a mutating subcommand, never a shell
 * string), and the existing read-only `ReadOnlyToolGateway` for file
 * read/resolve. It never mutates the task object it is given.
 *
 * Scope is authoritative and never inferred: `task.workspace.root` is the
 * only filesystem root ever used, and every candidate -- file or directory,
 * including the *resolved* (post-symlink) real path -- must fall under
 * `scope.allowed_paths` and outside `scope.forbidden_paths`/protected-path
 * rules, checked BEFORE it is read or recursed into, or it is rejected. A
 * missing/invalid scope throws rather than silently expanding to the whole
 * repository.
 *
 * The one addition to that read scope is the task's OWN explicit, optional
 * `scope.reference_paths` (X v0.2 Slice 2): read-only reference authority.
 * A file may be shown as `status: 'reference'` (never editable, never an
 * anchor) only if it lies in `allowed_paths` or in `reference_paths`, is not
 * in `forbidden_paths` or a protected path, and its RESOLVED (post-symlink)
 * path passes the same check. Nothing is inferred: an import neighbour that
 * is in neither is never opened. `reference_paths` grants reading only; the
 * scope/write checks (`scopeCheck`, `isAuthorized`, the write boundary) do
 * not consult it.
 *
 * Invariant: unauthorized content is never read, not merely filtered out of
 * the result. There is no whole-repository search or git step -- search
 * only walks files already resolved and scope-checked, directory listing
 * never descends into a forbidden/protected subdirectory, and Git
 * status/diff are restricted with *literal* (non-glob) pathspecs scoped to
 * `allowed_paths`, with `forbidden_paths` literally excluded -- task-
 * supplied paths can never be interpreted as Git pathspec magic. Every
 * input list and every output list is hard-capped in count, and the final
 * serialized packet is hard-capped in bytes, so no input size or record
 * count can produce an unbounded packet.
 */

export const DEFAULT_CONTEXT_LIMITS = Object.freeze({
  maxFiles: 12,
  maxBytesPerFile: 8000,
  maxTotalBytes: 40000,
  maxSearchResults: 20,
  maxExcerptLength: 240,
  maxSearchScanFiles: 60,
});

// Absolute ceilings a caller's `options.limits` can never exceed, regardless
// of what is requested (including Infinity/huge values).
const HARD_LIMITS = Object.freeze({
  maxFiles: 50,
  maxBytesPerFile: 20000,
  maxTotalBytes: 150000,
  maxSearchResults: 100,
  maxExcerptLength: 500,
  maxSearchScanFiles: 400,
  // Final serialized-packet ceiling: comfortably covers the worst case of
  // maxTotalBytes content plus MAX_RECORD_ENTRIES omitted/blocker records
  // at maximum path+detail size, plus JSON/metadata overhead.
  maxPacketBytes: 300000,
});

// Not caller-configurable at all: fixed hard bookkeeping caps so a
// pathological input (e.g. thousands of preferred_files) cannot inflate the
// output packet regardless of byte-budget accounting.
const MAX_INPUT_CANDIDATES = 200; // per raw input list (preferred_files/suspected_area/known_evidence/requiredPaths/searchQueries)
const MAX_RECORD_ENTRIES = 100; // per output list (omitted, blockers) before a single truncation sentinel replaces the rest
const MAX_PATH_BYTES = 300;

// X v0.2 Slice 1 -- targeted EXCERPTS of files too large to load whole. Not caller-configurable, and they never
// raise any cap: an excerpt is charged against the SAME per-file (`maxBytesPerFile`) and total (`maxTotalBytes`)
// budgets as any other file.
const MAX_EXCERPT_RANGES_PER_FILE = 4;
const MAX_EXCERPT_RANGE_LINES = 400;
const RANGE_SPEC = /^(.*\S):(\d+)(?:-(\d+))?$/;
export const excerptOmissionMarker = (from, to) => `... (lines ${from}-${to} not shown) ...`;
export const EXCERPT_MARKER_PATTERN = /^\.\.\. \(lines (\d+)-(\d+) not shown\) \.\.\.$/;

/**
 * `suspected_area` entries may carry a 1-based inclusive line range: `path:START-END` or `path:LINE`. Anything else
 * (including an entry whose "range" is invalid) is returned untouched as a plain path, so every existing entry
 * behaves exactly as before.
 */
export const parseRangeSpec = (raw) => {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const m = text.match(RANGE_SPEC);
  if (!m) return { path: raw, ranges: null };
  const start = Number(m[2]);
  const end = m[3] === undefined ? start : Number(m[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) return { path: raw, ranges: null };
  return { path: m[1], ranges: [{ start, end }] };
};

/** Plain (unnumbered) lines of gateway-numbered content, or null if any line lacks its exact expected prefix. */
const plainLinesOfNumbered = (numberedRaw) => {
  const lines = numberedRaw.split('\n');
  const plain = [];
  for (const [index, line] of lines.entries()) {
    const prefix = `${index + 1}: `;
    if (!line.startsWith(prefix)) return null;
    plain.push(line.slice(prefix.length));
  }
  return plain;
};

const sha256Text = (text) => crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

const mergeRanges = (ranges, lineCount, maxRanges = MAX_EXCERPT_RANGES_PER_FILE) => {
  const clamped = ranges
    .map(({ start, end }) => ({ start: Math.max(1, start), end: Math.min(lineCount, end, start + MAX_EXCERPT_RANGE_LINES - 1) }))
    .filter((r) => r.start <= lineCount && r.end >= r.start)
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const r of clamped) {
    const last = merged.at(-1);
    if (last && r.start <= last.end + 1) last.end = Math.min(lineCount, Math.max(last.end, r.end), last.start + MAX_EXCERPT_RANGE_LINES - 1);
    else merged.push({ ...r });
  }
  return merged.slice(0, maxRanges);
};

/**
 * Builds an `excerpt` record for a file that does not fit the per-file cap, or returns null (= caller keeps the existing
 * `truncated` behavior). Fail-closed on anything unusual: an unexpected line prefix, a redaction that changed the line
 * count, or ANY redaction inside a shown line. The record carries the hash/size/line count of the WHOLE file, computed
 * here from the trusted read, so the executor can bind a write to that exact full-file state.
 */
const buildExcerptRecord = (relativePath, numberedRaw, numberedGuarded, requested, capBytes, maxRanges = MAX_EXCERPT_RANGES_PER_FILE) => {
  const rawLines = numberedRaw.split('\n');
  const guardedLines = numberedGuarded.split('\n');
  if (rawLines.length !== guardedLines.length) return null;
  const plain = [];
  for (const [index, line] of rawLines.entries()) {
    const prefix = `${index + 1}: `;
    if (!line.startsWith(prefix)) return null;
    plain.push(line.slice(prefix.length));
  }
  const fullText = plain.join('\n');
  const lineCount = rawLines.length;
  const ranges = mergeRanges(requested, lineCount, maxRanges);
  if (ranges.length === 0) return null;

  const out = [];
  const shown = [];
  let used = 0;
  const push = (text) => { const bytes = Buffer.byteLength(text, 'utf8') + 1; if (used + bytes > capBytes) return false; out.push(text); used += bytes; return true; };
  let previousEnd = 0;
  for (const range of ranges) {
    if (range.start > previousEnd + 1 && !push(excerptOmissionMarker(previousEnd + 1, range.start - 1))) break;
    let lastShown = 0;
    for (let n = range.start; n <= range.end; n += 1) {
      if (guardedLines[n - 1] !== rawLines[n - 1]) return null;
      if (!push(guardedLines[n - 1])) break;
      lastShown = n;
    }
    if (lastShown === 0) break;
    shown.push({ start_line: range.start, end_line: lastShown });
    previousEnd = lastShown;
    if (lastShown < range.end) break; // hit the per-file byte cap mid-range: nothing beyond this point is shown
  }
  if (shown.length === 0) return null;
  if (previousEnd < lineCount) push(excerptOmissionMarker(previousEnd + 1, lineCount));
  const content = out.join('\n');
  return {
    path: relativePath, status: 'excerpt', truncated: true, bytes: Buffer.byteLength(content, 'utf8'), content, excerpts: shown,
    full_file: { bytes: Buffer.byteLength(fullText, 'utf8'), lines: lineCount, sha256: sha256Text(fullText) },
  };
};

const LIST_MAX_DEPTH = 3;
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.cache', '.vite', 'release']);
const MAX_DETAIL_BYTES = 200;
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_OUTPUT_BYTES = 64 * 1024;

export class XContextScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'XContextScopeError';
    this.code = 'INVALID_SCOPE';
  }
}

const clampPositiveInt = (value, fallback, hardMax) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), hardMax);
};

/** Merges caller-supplied limits into the defaults, then clamps every field to its hard ceiling so no caller value can bypass bounded context. */
const resolveLimits = (overrides) => {
  const merged = { ...DEFAULT_CONTEXT_LIMITS, ...(overrides || {}) };
  const clamped = {};
  for (const key of Object.keys(DEFAULT_CONTEXT_LIMITS)) {
    clamped[key] = clampPositiveInt(merged[key], DEFAULT_CONTEXT_LIMITS[key], HARD_LIMITS[key]);
  }
  return Object.freeze(clamped);
};

/** Caps a raw (possibly attacker-sized) input array to a fixed count before it is ever iterated. */
const capInputList = (list, cap = MAX_INPUT_CANDIDATES) => {
  if (!Array.isArray(list)) return { items: [], truncated: false };
  return list.length <= cap ? { items: list, truncated: false } : { items: list.slice(0, cap), truncated: true };
};

/** Truncates `text` to at most `maxBytes` UTF-8 bytes without splitting a multi-byte character. */
const truncateToByteLimit = (text, maxBytes) => {
  if (maxBytes <= 0) return { text: '', truncated: text.length > 0 };
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.byteLength <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  let decoded = buffer.subarray(0, end).toString('utf8');
  while (decoded.endsWith('�') && end > 0) {
    end -= 1;
    decoded = buffer.subarray(0, end).toString('utf8');
  }
  return { text: decoded, truncated: true };
};

const boundDetail = (detail) => (typeof detail === 'string' ? truncateToByteLimit(detail, MAX_DETAIL_BYTES).text : detail);
const boundPath = (value) => (typeof value === 'string' ? truncateToByteLimit(value, MAX_PATH_BYTES).text : value);

// normalizePathString/isTraversal/scopeCheck/isAuthorized are exported so
// mcp/x/edit-writer.mjs (the Phase 5B write boundary) enforces the exact
// same scope semantics as this read boundary, rather than a second,
// possibly-diverging reimplementation.
export const normalizePathString = (raw) => {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  return path.posix.normalize(trimmed.replaceAll('\\', '/'));
};

export const isTraversal = (normalized) =>
  !normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') ||
  path.posix.isAbsolute(normalized) || normalized.includes('\0');

const isWithinAnyPrefix = (relativePath, prefixes) =>
  Array.isArray(prefixes) && prefixes.some((prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`));

export const scopeCheck = (relativePath, scope) => {
  if (!isWithinAnyPrefix(relativePath, scope.allowed_paths)) return { ok: false, reason: 'scope_violation' };
  if (isWithinAnyPrefix(relativePath, scope.forbidden_paths || [])) return { ok: false, reason: 'forbidden_path' };
  return { ok: true, reason: null };
};

/** The single authoritative "may this path appear anywhere in output" check: in scope AND not a protected/secret path. Used for files, directory recursion, AND git output filtering alike. */
export const isAuthorized = (relativePath, scope) => Boolean(relativePath) && scopeCheck(relativePath, scope).ok && !isProtectedPath(relativePath);

const looksLikeRepoPath = (value) => {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed) || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return false;
  return trimmed.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(trimmed);
};

export const assertValidatedTaskShape = (task) => {
  if (!task || typeof task !== 'object') throw new XContextScopeError('task is required');
  if (!task.workspace || typeof task.workspace.root !== 'string' || !task.workspace.root.trim()) {
    throw new XContextScopeError('task.workspace.root is required');
  }
  const scope = task.scope;
  if (!scope || typeof scope !== 'object' || !Array.isArray(scope.allowed_paths) || scope.allowed_paths.length === 0) {
    throw new XContextScopeError('task.scope.allowed_paths must be a non-empty array; a missing/invalid scope must not silently expand to the whole repository');
  }
  if (scope.forbidden_paths !== undefined && !Array.isArray(scope.forbidden_paths)) {
    throw new XContextScopeError('task.scope.forbidden_paths must be an array when present');
  }
  if (scope.reference_paths !== undefined && (!Array.isArray(scope.reference_paths) || scope.reference_paths.some((entry) => typeof entry !== 'string'))) {
    throw new XContextScopeError('task.scope.reference_paths must be an array of strings when present');
  }
};

/**
 * Resolves `rawPath` (file or directory) against the workspace with full
 * realpath verification, then re-checks scope/secret status against the
 * *resolved* relative path -- not just the nominal one -- so a symlink
 * cannot present an out-of-scope or secret target under an authorized-
 * looking name. Returns `null` for anything unauthorized or unresolvable;
 * never throws.
 */
async function resolveAuthorized(gateway, rawPath, scope) {
  const normalized = normalizePathString(rawPath);
  if (isTraversal(normalized)) return null;
  if (!isAuthorized(normalized, scope)) return null;

  let resolved;
  try {
    resolved = await gateway.resolve(normalized, { allowDirectory: true });
  } catch {
    return null;
  }

  if (!isAuthorized(resolved.relative, scope)) return null;

  return { absolute: resolved.absolute, relative: resolved.relative, isDirectory: resolved.stat.isDirectory() };
}

/** Loads exactly one candidate file, fully re-resolving and re-checking scope/secret status itself -- safe to call directly. */
async function loadOneFile(gateway, scope, rawPath, limits, maxBytesForThisFile, ranges = null, retrieval = null) {
  const resolved = await resolveAuthorized(gateway, rawPath, scope);
  if (!resolved) {
    const normalized = normalizePathString(rawPath);
    if (isTraversal(normalized)) return { status: 'scope_violation', detail: 'path traversal or absolute path rejected' };
    if (isProtectedPath(normalized)) return { status: 'blocked_secret_path' };
    const check = scopeCheck(normalized, scope);
    if (!check.ok) return { status: check.reason, detail: `'${normalized}' is outside the authorized scope` };
    return { status: 'unreadable', detail: 'workspace or symlink escape rejected' };
  }
  if (resolved.isDirectory) return { status: 'unreadable', detail: 'path is a directory' };

  const raw = await gateway.repoReadFile({ path: resolved.relative });
  if (raw.protected) return { status: 'blocked_secret_path' };
  if (raw.skipped) return { status: 'unreadable', detail: 'binary file was not read' };

  // Redact BEFORE truncating: truncating first could cut a multi-line
  // secret (e.g. a PEM block) before its closing marker, defeating the
  // pattern match and leaking the fragment that survived.
  const guarded = redactSecretContent(raw.content);
  const capBytes = Math.max(0, Math.min(limits.maxBytesPerFile, maxBytesForThisFile));
  const { text: content, truncated: byteTruncated } = truncateToByteLimit(guarded, capBytes);
  const truncated = Boolean(raw.partial) || byteTruncated;

  // X v0.2: only when the whole file does NOT fit the unchanged per-file cap AND the task asked for specific lines AND the
  // gateway read the entire file (so its hash is a real full-file hash). Every other case is exactly the pre-existing path.
  // X v0.2 Slice 2: deterministic retrieval. Only for whole-file reads (<= 1 MB). `onText` lets the caller learn an anchor's
  // imports; a file that does not fit and has no explicit range is located from the task's own terms (see context-retrieval.mjs).
  let effectiveRanges = ranges;
  let auto = null;
  if (retrieval && !raw.partial) {
    const wantsLocate = truncated && !(Array.isArray(ranges) && ranges.length > 0) && Array.isArray(retrieval.terms) && retrieval.terms.length > 0;
    const plainLines = retrieval.onText || wantsLocate ? plainLinesOfNumbered(raw.content) : null;
    if (plainLines && retrieval.onText) retrieval.onText(resolved.relative, plainLines);
    if (plainLines && wantsLocate) {
      // Pass 1 (strict term windows) + pass 2 (bindings, bridged gaps, prose-stem windows), all inside THIS file's cap `capBytes`.
      const located = planRanges(plainLines, retrieval.terms, retrieval.stems, capBytes);
      if (located.ranges.length > 0) { effectiveRanges = located.ranges.map(({ start, end }) => ({ start, end })); auto = { matched: located.matched.slice(0, 12), windows: located.ranges }; }
    }
  }
  if (truncated && !raw.partial && Array.isArray(effectiveRanges) && effectiveRanges.length > 0) {
    const excerpt = buildExcerptRecord(resolved.relative, raw.content, guarded, effectiveRanges, capBytes, auto ? RETRIEVAL.PLAN.maxRuns : MAX_EXCERPT_RANGES_PER_FILE);
    if (excerpt) return auto ? { ...excerpt, retrieval: { kind: 'auto_excerpt', matched_terms: auto.matched, windows: auto.windows } } : excerpt;
  }

  return {
    path: resolved.relative,
    status: truncated ? 'truncated' : (guarded !== raw.content ? 'redacted' : 'ok'),
    truncated,
    bytes: Buffer.byteLength(content, 'utf8'),
    content,
  };
}

/**
 * Bounded directory walk starting from an *already-resolved, already-
 * authorized* absolute directory. Scope/forbidden/protected status is
 * checked on every subdirectory BEFORE descending into it -- a forbidden or
 * protected directory is never traversed, not merely excluded from the
 * results afterward. Never follows a symlink at any depth.
 */
async function listAuthorizedFiles(rootAbsolute, startAbsolute, scope, maxEntries, fsApi) {
  const results = [];
  if (maxEntries <= 0) return results;
  const walk = async (directoryAbsolute, depth) => {
    if (results.length >= maxEntries || depth > LIST_MAX_DEPTH) return;
    let entries;
    try { entries = await fsApi.readdir(directoryAbsolute, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (results.length >= maxEntries) return;
      if (entry.isSymbolicLink()) continue; // never traverse into or list a symlink
      const absolute = path.join(directoryAbsolute, entry.name);
      const relative = path.relative(rootAbsolute, absolute).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        if (!isAuthorized(relative, scope)) continue; // checked BEFORE recursing
        await walk(absolute, depth + 1);
        continue;
      }
      if (!isAuthorized(relative, scope)) continue;
      results.push(relative);
    }
  };
  const stat = await fsApi.stat(startAbsolute).catch(() => null);
  if (stat?.isDirectory()) await walk(startAbsolute, 0);
  return results;
}

/**
 * Enumerates a bounded set of already-authorized candidate files across
 * every `scope.allowed_paths` root, for search to scan. Every root is
 * resolved and re-checked (see `resolveAuthorized`) before its directory is
 * ever read, so search can never walk through a symlink escape, and never
 * descends into a forbidden/protected subdirectory either.
 */
async function enumerateSearchCandidates(gateway, rootAbsolute, scope, maxFiles, fsApi) {
  const candidates = [];
  const seen = new Set();
  for (const allowedRoot of scope.allowed_paths || []) {
    if (candidates.length >= maxFiles) break;
    const resolved = await resolveAuthorized(gateway, allowedRoot, scope);
    if (!resolved) continue;
    if (resolved.isDirectory) {
      const found = await listAuthorizedFiles(rootAbsolute, resolved.absolute, scope, maxFiles - candidates.length, fsApi);
      for (const entry of found) {
        if (candidates.length >= maxFiles) break;
        if (seen.has(entry)) continue;
        seen.add(entry);
        candidates.push(entry);
      }
    } else if (!seen.has(resolved.relative)) {
      seen.add(resolved.relative);
      candidates.push(resolved.relative);
    }
  }
  return candidates;
}

/**
 * Bounded search over already-authorized candidate files only. Every
 * candidate is read through `loadOneFile`, the same safe path used for
 * ordinary file inclusion, so Secret Guard is applied to content before any
 * line is considered for an excerpt -- a match inside a redacted span never
 * surfaces, and no file outside `scope` is ever opened. There is no
 * whole-repository search step of any kind.
 */
async function runScopedSearch(gateway, rootAbsolute, scope, limits, queries, fsApi) {
  const results = [];
  const omitted = [];
  if (!Array.isArray(queries) || queries.length === 0) return { results, omitted };
  const candidates = await enumerateSearchCandidates(gateway, rootAbsolute, scope, limits.maxSearchScanFiles, fsApi);
  outer:
  for (const query of queries) {
    if (typeof query !== 'string' || !query.trim()) continue;
    for (const candidatePath of candidates) {
      if (results.length >= limits.maxSearchResults) { omitted.push({ path: candidatePath, reason: 'context_limit' }); break outer; }
      const outcome = await loadOneFile(gateway, scope, candidatePath, limits, limits.maxBytesPerFile);
      if (!['ok', 'redacted', 'truncated'].includes(outcome.status)) continue;
      const lines = outcome.content.split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        if (results.length >= limits.maxSearchResults) break;
        const clean = lines[index].replace(/^\d+:\s?/, '');
        if (clean.toLowerCase().includes(query.toLowerCase())) {
          results.push({ path: outcome.path, line: index + 1, excerpt: clean.trim().slice(0, limits.maxExcerptLength) });
        }
      }
    }
  }
  return { results, omitted };
}

const defaultGitRunner = (rootAbsolute) => (args) => new Promise((resolve) => {
  let settled = false;
  const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
  let child;
  try {
    child = spawn('git', args, { cwd: rootAbsolute, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    finish(null);
    return;
  }
  let stdout = '';
  const timer = setTimeout(() => { child.kill('SIGTERM'); finish(null); }, GIT_TIMEOUT_MS);
  child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(0, GIT_MAX_OUTPUT_BYTES); });
  child.on('error', () => { clearTimeout(timer); finish(null); });
  child.on('close', (code) => { clearTimeout(timer); finish(code === 0 ? stdout.trim() : null); });
});

/**
 * Git pathspec restricting a read-only git invocation to `allowed_paths`.
 * Every entry uses the `:(literal)` magic signature so a task-supplied path
 * is always matched as an exact literal string -- glob characters (`*`,
 * `?`, `[...]`) or a leading `:` in task content can never be interpreted
 * as Git pathspec magic to expand matching beyond the intended path.
 * `forbidden_paths` combine `exclude` with `literal` the same way.
 */
const gitPathspecArgs = (scope) => [
  ...(scope.allowed_paths || []).map((p) => `:(literal)${p}`),
  ...(scope.forbidden_paths || []).map((p) => `:(exclude,literal)${p}`),
];

/** Returns [path] for a plain status line, or [source, dest] for a rename/copy line -- every endpoint must be authorized for the line to survive. */
const parseStatusPaths = (line) => {
  const body = line.slice(3);
  const arrowIndex = body.indexOf(' -> ');
  if (arrowIndex === -1) return [body.trim().replace(/^"|"$/g, '')];
  return [body.slice(0, arrowIndex), body.slice(arrowIndex + 4)].map((p) => p.trim().replace(/^"|"$/g, ''));
};

/** JS-level backstop behind the literal git pathspec: drops any status line (including a rename) with an unauthorized/protected endpoint on either side. */
const filterStatusLines = (output, scope) => {
  if (!output) return output;
  return output.split('\n').filter((line) => {
    if (!line.trim() || line.startsWith('##')) return true;
    return parseStatusPaths(line).every((p) => isAuthorized(p, scope));
  }).join('\n');
};

/** Extracts the rename endpoints from a `diff --stat` path column: either `old => new` or the abbreviated `prefix/{old => new}/suffix` form. Returns [] when the shape is not confidently parseable, so the caller can fail safe and drop the line. */
const extractRenameCandidates = (pathPortion) => {
  const curly = pathPortion.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (curly) {
    const [, prefix, oldPart, newPart, suffix] = curly;
    return [`${prefix}${oldPart}${suffix}`, `${prefix}${newPart}${suffix}`].map((p) => p.replace(/\/{2,}/g, '/'));
  }
  const plain = pathPortion.split(' => ');
  return plain.length === 2 ? plain.map((p) => p.trim()) : [];
};

/** JS-level backstop behind the literal git pathspec for `diff --stat` output. */
const filterDiffStatLines = (output, scope) => {
  if (!output) return output;
  return output.split('\n').filter((line) => {
    const pipeIndex = line.indexOf('|');
    if (pipeIndex === -1) return true; // summary line, no path
    const pathPortion = line.slice(0, pipeIndex).trim();
    if (pathPortion.includes('=>')) {
      const candidates = extractRenameCandidates(pathPortion);
      return candidates.length > 0 && candidates.every((p) => isAuthorized(p, scope));
    }
    return isAuthorized(pathPortion, scope);
  }).join('\n');
};

/**
 * Branch/head are global ref metadata (no file content) and are exposed
 * unscoped. Status/diff carry file paths and are literal-pathspec-scoped to
 * `allowed_paths` (with `forbidden_paths` literally excluded), then
 * re-filtered in JS with `isAuthorized` (scope AND not-protected, both
 * rename endpoints checked) as a backstop. Every outbound field passes
 * through Secret Guard.
 *
 * `clean` reflects a *proven* scoped status only: it is `true`/`false` only
 * when the scoped `git status` invocation actually succeeded, and `null`
 * ("unknown") whenever it failed, timed out, or git was unavailable --
 * never defaulted to `true` on failure.
 */
async function loadGitContext(gateway, rootAbsolute, scope, gitRunner) {
  const globalBranch = await gateway.gitInspect({ operation: 'branch' }).then((r) => r.output).catch(() => null);
  const globalHead = await gateway.gitInspect({ operation: 'head' }).then((r) => r.output).catch(() => null);
  const pathspec = gitPathspecArgs(scope);
  const rawStatus = await gitRunner(['status', '--short', '--branch', '--', ...pathspec]);
  const rawDiff = await gitRunner(['diff', '--stat', '--no-ext-diff', '--', ...pathspec]);

  const statusAvailable = rawStatus !== null;
  const filteredStatus = statusAvailable ? (filterStatusLines(rawStatus, scope) || '') : null;
  const statusLineCount = statusAvailable ? filteredStatus.split('\n').filter(Boolean).length : 0;

  return {
    branch: redactSecretContent(globalBranch || ''),
    head: redactSecretContent(globalHead || ''),
    status: statusAvailable ? redactSecretContent(filteredStatus) : null,
    diff_summary: rawDiff !== null ? redactSecretContent(filterDiffStatLines(rawDiff, scope) || '') : null,
    // Only a successful scoped status proves cleanliness; anything else is unknown, never a false "true".
    clean: statusAvailable ? statusLineCount <= 1 : null,
  };
}

const serializedBytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/**
 * Final hard backstop: whatever byte accounting happened upstream, the
 * *actual serialized packet* (including omitted[]/blockers[]/metadata/JSON
 * overhead) must never exceed `maxPacketBytes`. Trims least-essential
 * sections first (omitted, then blockers, then search results) and only
 * touches file content as an absolute last resort.
 */
function enforcePacketCeiling(packet, maxPacketBytes) {
  if (serializedBytes(packet) <= maxPacketBytes) return packet;
  while (packet.omitted.length > 0 && serializedBytes(packet) > maxPacketBytes) packet.omitted.pop();
  while (packet.blockers.length > 0 && serializedBytes(packet) > maxPacketBytes) packet.blockers.pop();
  while (packet.search_results.length > 0 && serializedBytes(packet) > maxPacketBytes) packet.search_results.pop();
  while (packet.evidence.known_evidence.length > 0 && serializedBytes(packet) > maxPacketBytes) packet.evidence.known_evidence.pop();
  if (serializedBytes(packet) > maxPacketBytes) {
    packet.git.status = null;
    packet.git.diff_summary = null;
    packet.git.truncated = true;
  }
  while (packet.files.length > 0 && serializedBytes(packet) > maxPacketBytes) packet.files.pop();
  if (serializedBytes(packet) > maxPacketBytes) {
    // Should be unreachable given the above, but never emit an over-ceiling packet.
    packet.omitted = [{ path: null, reason: 'context_limit', detail: 'packet ceiling enforced' }];
    packet.blockers = [];
  }
  return packet;
}

/**
 * @param {object} task validated x-task-v1 (never mutated)
 * @param {{ gateway?: ReadOnlyToolGateway, limits?: object, maxPacketBytes?: number, searchQueries?: string[], requiredPaths?: string[], gitRunner?: Function, fsApi?: { readdir, stat } }} [options]
 */
const isForbiddenPath = (relativePath, scope) => isWithinAnyPrefix(relativePath, scope.forbidden_paths || []);

/**
 * Why a file may be SHOWN as read-only reference context, or null when it may not. There are exactly two sources of authority
 * and nothing is inferred: `allowed_paths` (the task's own scope; showing one of its files read-only is no expansion) and the
 * explicit `reference_paths` the task author listed. An import neighbour outside both is NEVER read, however relevant it looks.
 * Protected paths and `forbidden_paths` always win, and this only ever grants reading: `scopeCheck`/`isAuthorized` (which the
 * editable-file path and the write boundary use) do not look at `reference_paths` at all.
 */
const referenceAuthority = (relativePath, scope) => {
  if (!relativePath || isProtectedPath(relativePath) || isForbiddenPath(relativePath, scope)) return null;
  if (isWithinAnyPrefix(relativePath, scope.allowed_paths)) return 'allowed_paths';
  if (isWithinAnyPrefix(relativePath, scope.reference_paths || [])) return 'reference_paths';
  return null;
};

/** Resolves a relative import specifier from `fromRelative` to a real workspace-relative file, or null. Bounded: a handful of candidate names. */
async function resolveImportSpecifier(gateway, fromRelative, specifier) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRelative), specifier));
  if (isTraversal(base)) return null;
  const candidates = [base, `${base}.mjs`, `${base}.cjs`, `${base}.js`, `${base}.ts`, `${base}.tsx`, `${base}/index.mjs`, `${base}/index.cjs`, `${base}/index.js`];
  for (const candidate of candidates) {
    try {
      const resolved = await gateway.resolve(candidate, { allowDirectory: false });
      return resolved.relative;
    } catch { /* try the next candidate name */ }
  }
  return null;
}

/**
 * READ-ONLY reference context for one file (an import neighbour of a loaded anchor, or an explicit `reference_paths` file),
 * shown only where the task's own terms match. It is `status: 'reference'`: never `ok`, never `excerpt`, so it can never be
 * patched or replaced, and the write boundary refuses it independently. Authority is decided on the RESOLVED path (so a symlink
 * cannot present a forbidden or unlisted target under a listed name). Workspace containment (gateway), protected paths, secret
 * redaction (fail-closed if any shown line is touched) and the per-file / total byte budgets all apply. Null when nothing qualifies.
 */
async function loadReferenceFile(gateway, scope, rawRelative, terms, provenance, capBytes) {
  if (capBytes <= 0) return null;
  let resolved;
  try { resolved = await gateway.resolve(rawRelative, { allowDirectory: false }); } catch { return null; }
  const authority = referenceAuthority(resolved.relative, scope);
  if (!authority) return null;
  let raw;
  try { raw = await gateway.repoReadFile({ path: resolved.relative }); } catch { return null; }
  if (raw.protected || raw.skipped || raw.partial || typeof raw.content !== 'string') return null;
  const plain = plainLinesOfNumbered(raw.content);
  if (!plain) return null;
  const located = locateRanges(plain, terms, RETRIEVAL.RELATED);
  if (located.ranges.length === 0) return null;
  const record = buildExcerptRecord(resolved.relative, raw.content, redactSecretContent(raw.content), located.ranges.map(({ start, end }) => ({ start, end })), capBytes);
  if (!record) return null;
  return { ...record, status: 'reference', read_only: true, retrieval: { kind: 'related', authority, ...provenance, matched_terms: located.matched.slice(0, 12), windows: located.ranges } };
}

export async function loadTaskContext(task, options = {}) {
  assertValidatedTaskShape(task);
  const limits = resolveLimits(options.limits);
  const maxPacketBytes = clampPositiveInt(options.maxPacketBytes, HARD_LIMITS.maxPacketBytes, HARD_LIMITS.maxPacketBytes);
  const gateway = options.gateway || new ReadOnlyToolGateway({ workspace: task.workspace.root });
  const fsApi = options.fsApi || { readdir, stat: fsStat };
  const scope = task.scope;

  const files = [];
  const omitted = [];
  const blockers = [];
  const seen = new Set();
  let totalBytes = 0;
  let omittedCapped = false;
  let blockersCapped = false;

  const hasCapacity = () => files.length < limits.maxFiles && totalBytes < limits.maxTotalBytes;
  const remainingBudget = () => Math.max(0, limits.maxTotalBytes - totalBytes);
  const chargeBudget = (bytes) => { totalBytes += bytes; };

  /** Hard-caps omitted/blockers list length independent of the byte budget: past MAX_RECORD_ENTRIES, a single sentinel replaces every further entry. */
  const pushRecord = (list, kind, entry) => {
    if (list.length >= MAX_RECORD_ENTRIES) {
      const capped = kind === 'omitted' ? omittedCapped : blockersCapped;
      if (capped) return;
      if (kind === 'omitted') omittedCapped = true; else blockersCapped = true;
      list.push({ path: null, reason: 'context_limit', detail: `${kind} list truncated at hard limit` });
      return;
    }
    list.push({ path: boundPath(entry.path), reason: entry.reason, detail: boundDetail(entry.detail) });
  };

  // Line-range hints from `suspected_area` (`path:START-END`). Keyed by normalized path so a range wins no matter which
  // list first loads the file (e.g. a repair round adds the file to preferred_files before suspected_area is visited).
  // Slice 2 (deterministic retrieval). `options.retrieval === false` switches it all off.
  const retrievalOn = options.retrieval !== false;
  const terms = retrievalOn ? extractTerms(task) : [];
  const anchorTexts = [];
  const retrievalCtx = retrievalOn ? { terms, stems: extractProseStems(task), onText: (relative, lines) => { anchorTexts.push({ path: relative, lines }); } } : null;

  const rangeMap = new Map();
  for (const area of capInputList(task.suspected_area).items) {
    const spec = parseRangeSpec(area);
    if (!spec.ranges) continue;
    const key = normalizePathString(spec.path);
    if (key) rangeMap.set(key, [...(rangeMap.get(key) ?? []), ...spec.ranges]);
  }

  // `path:line` references in the task's evidence (e.g. a stack trace) that point at an AUTHORIZED file become anchors with a
  // window around that line. References to anything outside scope (tests under forbidden paths, node internals, other
  // repositories) are ignored silently.
  const evidenceAnchors = [];
  if (retrievalOn) {
    const rootForRefs = await gateway.root().catch(() => null);
    for (const ref of extractEvidenceRefs(task)) {
      let candidate = ref.path.startsWith('file://') ? ref.path.slice(7) : ref.path;
      for (const rootPath of [task.workspace.root, rootForRefs]) {
        if (rootPath && candidate.startsWith(`${rootPath}/`)) { candidate = candidate.slice(rootPath.length + 1); break; }
      }
      const key = normalizePathString(candidate);
      if (!key || isTraversal(key) || path.isAbsolute(key) || !isAuthorized(key, scope)) continue;
      rangeMap.set(key, [...(rangeMap.get(key) ?? []), { start: Math.max(1, ref.line - RETRIEVAL.ANCHOR.padBefore), end: ref.line + RETRIEVAL.ANCHOR.padAfter }]);
      if (!evidenceAnchors.includes(key)) evidenceAnchors.push(key);
    }
  }

  const tryLoad = async (rawPath, { required = false } = {}) => {
    const key = normalizePathString(rawPath);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    if (!hasCapacity()) { pushRecord(omitted, 'omitted', { path: key, reason: 'context_limit' }); return false; }
    const outcome = await loadOneFile(gateway, scope, key, limits, remainingBudget(), rangeMap.get(key) ?? null, retrievalCtx);
    if (outcome.status === 'ok' || outcome.status === 'redacted' || outcome.status === 'truncated' || outcome.status === 'excerpt') {
      files.push(outcome);
      chargeBudget(outcome.bytes);
      return true;
    }
    pushRecord(required ? blockers : omitted, required ? 'blockers' : 'omitted', { path: outcome.path || key, reason: outcome.status, detail: outcome.detail });
    return false;
  };

  // Every raw input list is hard-capped in count BEFORE it is iterated, so
  // an adversarial task (or caller options) with thousands of entries
  // cannot inflate processing time or the output packet -- only the first
  // MAX_INPUT_CANDIDATES of each are ever considered.
  const { items: preferredFiles, truncated: preferredTruncated } = capInputList(scope.preferred_files);
  const { items: suspectedAreas, truncated: suspectedTruncated } = capInputList(task.suspected_area);
  const { items: knownEvidenceInput, truncated: evidenceInputTruncated } = capInputList(task.known_evidence);
  const { items: requiredPaths, truncated: requiredTruncated } = capInputList(options.requiredPaths);
  const { items: searchQueries, truncated: queriesTruncated } = capInputList(options.searchQueries);
  for (const [truncated, label] of [
    [preferredTruncated, 'preferred_files'], [suspectedTruncated, 'suspected_area'],
    [evidenceInputTruncated, 'known_evidence'], [requiredTruncated, 'requiredPaths'], [queriesTruncated, 'searchQueries'],
  ]) {
    if (truncated) pushRecord(omitted, 'omitted', { path: null, reason: 'context_limit', detail: `${label} input truncated to ${MAX_INPUT_CANDIDATES} candidates` });
  }

  // 1. preferred_files are hints, not authorization and not automatically
  // required -- a missing/unreadable one is reported in `omitted`, never
  // escalated to `blockers` on its own.
  for (const candidate of preferredFiles) {
    if (!hasCapacity()) { pushRecord(omitted, 'omitted', { path: normalizePathString(candidate), reason: 'context_limit' }); continue; }
    await tryLoad(candidate, { required: false });
  }

  // 2. suspected_area -- resolved+authorized first, then treated cleanly as
  // either a single file or a bounded directory listing (never both, and
  // never traversing a forbidden/protected subdirectory).
  const rootAbsolute = await gateway.root();
  for (const rawArea of suspectedAreas) {
    const area = parseRangeSpec(rawArea).path; // a `path:START-END` entry resolves by its path part; plain entries are unchanged
    if (!hasCapacity()) { pushRecord(omitted, 'omitted', { path: area, reason: 'context_limit' }); continue; }
    const resolved = await resolveAuthorized(gateway, area, scope);
    if (!resolved) { pushRecord(omitted, 'omitted', { path: normalizePathString(area), reason: 'scope_violation' }); continue; }
    if (resolved.isDirectory) {
      const remainingSlots = limits.maxFiles - files.length;
      const listing = await listAuthorizedFiles(rootAbsolute, resolved.absolute, scope, remainingSlots, fsApi);
      for (const entry of listing) {
        if (!hasCapacity()) { pushRecord(omitted, 'omitted', { path: entry, reason: 'context_limit' }); continue; }
        await tryLoad(entry, { required: false });
      }
    } else {
      if (!rangeMap.has(resolved.relative) && rangeMap.has(normalizePathString(area))) rangeMap.set(resolved.relative, rangeMap.get(normalizePathString(area)));
      await tryLoad(resolved.relative, { required: false });
    }
  }

  for (const anchor of evidenceAnchors) {
    if (!hasCapacity()) break;
    await tryLoad(anchor, { required: false });
  }

  // 3. explicitly required evidence, if the caller designated any (the
  // x-task-v1 contract itself has no "required" marker yet).
  for (const requiredPath of requiredPaths) {
    if (!hasCapacity()) { pushRecord(blockers, 'blockers', { path: normalizePathString(requiredPath), reason: 'context_limit' }); continue; }
    await tryLoad(requiredPath, { required: true });
  }

  // 4. known_evidence -- entries that look like repo paths also become
  // files; ALL entries are redacted and bounded before inclusion as raw
  // evidence text, since they are outbound context text like everything
  // else here. Count is already hard-capped above; once the byte budget is
  // exhausted the loop stops outright rather than appending empty strings.
  const resolvedEvidenceFiles = [];
  const evidenceEntries = [];
  let evidenceTruncated = false;
  for (const raw of knownEvidenceInput) {
    if (remainingBudget() <= 0) { evidenceTruncated = true; break; }
    if (looksLikeRepoPath(raw) && hasCapacity()) {
      if (await tryLoad(raw, { required: false })) resolvedEvidenceFiles.push(normalizePathString(raw));
    }
    const redacted = redactSecretContent(String(raw));
    const { text, truncated } = truncateToByteLimit(redacted, remainingBudget());
    evidenceEntries.push(text);
    chargeBudget(Buffer.byteLength(text, 'utf8'));
    if (truncated) { evidenceTruncated = true; break; }
  }
  if (evidenceTruncated) pushRecord(omitted, 'omitted', { path: null, reason: 'context_limit', detail: 'known_evidence truncated by total context budget' });

  // 4b. Slice 2: READ-ONLY reference files -- (a) what the loaded anchor files import (one hop) and (b) the exact files listed in
  // `scope.reference_paths`, shown only where the task's own terms match. A file is a candidate ONLY if `referenceAuthority`
  // grants it (allowed_paths or an explicit reference_paths entry); import neighbours outside both are never read. Bounded to
  // RETRIEVAL.RELATED.maxFiles files and maxBytesPerFile bytes each, charged to the same budgets.
  const relatedTried = new Set();
  let relatedAdded = 0;
  const addReference = async (relative, provenance) => {
    if (!relative || seen.has(relative) || relatedTried.has(relative)) return;
    relatedTried.add(relative);
    if (!referenceAuthority(relative, scope)) return; // nominal path first: an unauthorized neighbour is not even opened
    const cap = Math.min(RETRIEVAL.RELATED.maxBytesPerFile, limits.maxBytesPerFile, remainingBudget());
    const reference = await loadReferenceFile(gateway, scope, relative, terms, provenance, cap);
    if (!reference || seen.has(reference.path)) return;
    seen.add(reference.path);
    files.push(reference);
    chargeBudget(reference.bytes);
    relatedAdded += 1;
  };
  if (retrievalOn && terms.length > 0) {
    outer: for (const anchor of anchorTexts) {
      for (const specifier of extractRelativeImports(anchor.lines.join('\n'))) {
        if (relatedAdded >= RETRIEVAL.RELATED.maxFiles || !hasCapacity()) break outer;
        await addReference(await resolveImportSpecifier(gateway, anchor.path, specifier), { via: anchor.path });
      }
    }
    for (const entry of capInputList(scope.reference_paths).items) {
      if (relatedAdded >= RETRIEVAL.RELATED.maxFiles || !hasCapacity()) break;
      const relative = normalizePathString(entry);
      if (!relative || isTraversal(relative)) continue;
      await addReference(relative, { via: null });
    }
  }

  // 5. bounded search -- only ever runs against caller-supplied, explicit
  // queries, and only ever reads files already proven authorized. This
  // phase does not have the model choose what to read, and it does not
  // invent search terms from task prose. Results are then trimmed to fit
  // the remaining total-context budget.
  const { results: rawSearchResults, omitted: searchOmitted } =
    await runScopedSearch(gateway, rootAbsolute, scope, limits, searchQueries, fsApi);
  for (const entry of searchOmitted) pushRecord(omitted, 'omitted', entry);
  const searchResults = [];
  for (const result of rawSearchResults) {
    const approxBytes = Buffer.byteLength(`${result.path}:${result.line}:${result.excerpt}`, 'utf8');
    if (remainingBudget() < approxBytes) { pushRecord(omitted, 'omitted', { path: result.path, reason: 'context_limit' }); continue; }
    chargeBudget(approxBytes);
    searchResults.push(result);
  }

  // 6. git -- literal-pathspec-scoped status/diff, global branch/head,
  // secret-redacted, `clean` only ever true/false on a proven successful
  // scoped status (never defaulted to true on failure/timeout), and text
  // fields trimmed to fit the remaining total-context budget.
  const gitRunner = options.gitRunner || defaultGitRunner(rootAbsolute);
  const rawGit = await loadGitContext(gateway, rootAbsolute, scope, gitRunner);
  const git = { clean: rawGit.clean };
  let gitTruncated = false;
  for (const field of ['branch', 'head', 'status', 'diff_summary']) {
    const value = rawGit[field];
    if (value == null) { git[field] = null; continue; }
    if (remainingBudget() <= 0) { git[field] = null; if (value) gitTruncated = true; continue; }
    const { text, truncated } = truncateToByteLimit(value, remainingBudget());
    git[field] = text;
    chargeBudget(Buffer.byteLength(text, 'utf8'));
    if (truncated) gitTruncated = true;
  }
  git.truncated = gitTruncated;
  if (gitTruncated) pushRecord(omitted, 'omitted', { path: null, reason: 'context_limit', detail: 'git status/diff truncated by total context budget' });

  const retrievalSummary = retrievalOn && (evidenceAnchors.length > 0 || files.some((f) => f.retrieval))
    ? { terms_considered: terms.length, evidence_anchors: evidenceAnchors, auto_excerpts: files.filter((f) => f.retrieval?.kind === 'auto_excerpt').map((f) => ({ path: f.path, ranges: f.excerpts, matched_terms: f.retrieval.matched_terms })),
      related: files.filter((f) => f.retrieval?.kind === 'related').map((f) => ({ path: f.path, via: f.retrieval.via, authority: f.retrieval.authority, ranges: f.excerpts, matched_terms: f.retrieval.matched_terms })) }
    : null;
  const packet = {
    workspace: { repo: task.workspace.repo, root: task.workspace.root },
    files,
    search_results: searchResults,
    git,
    evidence: { known_evidence: evidenceEntries, resolved_evidence_files: resolvedEvidenceFiles },
    omitted,
    blockers,
    limits,
    ...(retrievalSummary ? { retrieval: retrievalSummary } : {}),
  };
  enforcePacketCeiling(packet, maxPacketBytes);

  return Object.freeze({
    ...packet,
    workspace: Object.freeze(packet.workspace),
    files: Object.freeze(packet.files.map((file) => Object.freeze(file))),
    search_results: Object.freeze(packet.search_results),
    git: Object.freeze(packet.git),
    evidence: Object.freeze({
      known_evidence: Object.freeze(packet.evidence.known_evidence),
      resolved_evidence_files: Object.freeze(packet.evidence.resolved_evidence_files),
    }),
    omitted: Object.freeze(packet.omitted),
    blockers: Object.freeze(packet.blockers),
  });
}
