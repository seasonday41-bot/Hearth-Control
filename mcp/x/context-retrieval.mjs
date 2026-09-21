/**
 * X v0.2 Slice 2 -- deterministic context RETRIEVAL (pure functions; no filesystem, no process, no network, no model).
 *
 * Given a task and the text of an already-authorized file, decide WHICH lines are worth showing. Everything here is a
 * fixed, explainable function of its inputs:
 *
 *   - `extractTerms(task)`: identifiers, quoted literals, file-like names and their word parts, and mid-sentence proper
 *     nouns, taken from the task's own text and evidence (stack-frame lines are dropped). Never invented, never looked up
 *     anywhere else, and there is no domain knowledge in it: no term or rule is specific to any benchmark, SHA or fix.
 *   - `locateRanges(lines, terms)`: scores each line by the terms it contains (a term that occurs on many lines is worth
 *     little; a definition site is worth more), then returns a few bounded, merged windows around the best lines.
 *   - `extractRelativeImports(text)`: relative `require(...)` / `import ... from` specifiers (one hop of related modules).
 *   - `extractEvidenceRefs(task)`: `path:line` references in the task's evidence (for example a stack trace).
 *
 * The model chooses nothing: its output is never an input here. Callers (the context loader) still apply the unchanged
 * scope, protected-path, secret-redaction and byte-budget rules to whatever these functions suggest.
 */

export const RETRIEVAL = Object.freeze({
  MAX_TERMS: 60,
  MAX_TEXT_CHARS: 24000,
  MAX_EVIDENCE_ENTRY_CHARS: 4000,
  MAX_EVIDENCE_REFS: 6,
  MAX_IMPORTS_PER_FILE: 40,
  ANCHOR: Object.freeze({ padBefore: 12, padAfter: 20, maxWindows: 3, minScore: 3 }),
  RELATED: Object.freeze({ padBefore: 6, padAfter: 14, maxWindows: 2, minScore: 4, maxFiles: 3, maxBytesPerFile: 4000 }),
  // Second, budget-bounded pass (see `planRanges`). The byte budget is the caller's per-file cap; nothing here can raise it.
  PLAN: Object.freeze({
    maxRuns: 10, // most separate ranges an automatic excerpt may contain (explicit `path:START-END` hints keep their own, smaller limit)
    markerBytes: 40, reserveBytes: 120, // accounting for the "... (lines a-b not shown) ..." markers and a small safety margin
    binding: Object.freeze({ padBefore: 3, padAfter: 3, maxWindows: 4 }),
    secondary: Object.freeze({ padBefore: 6, padAfter: 14, minScore: 1.5, maxWindows: 3 }),
    bridgeMaxGapLines: 60,
  }),
});

const STOP = new Set(['that', 'this', 'with', 'from', 'into', 'when', 'then', 'they', 'them', 'have', 'been', 'does', 'file', 'path', 'node', 'true', 'false', 'null', 'test', 'tests', 'error', 'value', 'name', 'type', 'code', 'data', 'string', 'object', 'array', 'number', 'return', 'import', 'export', 'const', 'module', 'exports', 'function', 'each', 'every', 'never', 'only', 'also', 'must', 'should', 'uses', 'used', 'like', 'such', 'than', 'more', 'less', 'same', 'other', 'which', 'where', 'while', 'about', 'after', 'before', 'under', 'over', 'src', 'lib', 'bin']);

const KIND_WEIGHT = Object.freeze({ literal: 4, phrase: 3, identifier: 3, filelike: 3, part: 2, word: 1.5 });

const stripStackFrames = (text) => String(text).split('\n').filter((line) => !/^\s*at\s/.test(line) && !/node:internal/.test(line)).join('\n');

/** Whether the match at `index` starts a sentence (so an initial capital there says nothing about being a proper noun). */
const startsSentence = (text, index) => {
  let i = index - 1;
  while (i >= 0 && /[ \t]/.test(text[i])) i -= 1;
  return i < 0 || /[.!?:;\n]/.test(text[i]);
};

const IDENT_PATTERNS = [
  /\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b/g, // camelCase
  /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, // snake_case
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, // SCREAMING_CASE
  /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b/g, // PascalCase
  /\b[A-Za-z_$][\w$]{1,}(?:\.[A-Za-z_$][\w$]{1,})+\b/g, // dotted.names
];
const FILELIKE = /[\w./@-]+\.(?:mjs|cjs|js|jsx|ts|tsx|json|node|plist|md)\b/g;

const parts = (token) => token.split(/[./\-_:@]+/).filter((p) => p.length >= 4 && /^[A-Za-z]+$/.test(p) && !STOP.has(p.toLowerCase()));

/** Deterministic term list, best first. `ci` = match case-insensitively. */
export const extractTerms = (task) => {
  const chunks = [];
  const push = (text, isEvidence = false) => {
    if (typeof text !== 'string' || !text.trim()) return;
    chunks.push(stripStackFrames(isEvidence ? text.slice(0, RETRIEVAL.MAX_EVIDENCE_ENTRY_CHARS) : text));
  };
  for (const field of ['objective', 'problem', 'expected_behavior', 'observed_behavior']) push(task?.[field]);
  for (const entry of Array.isArray(task?.acceptance_criteria) ? task.acceptance_criteria : []) push(entry);
  for (const entry of Array.isArray(task?.known_evidence) ? task.known_evidence : []) push(entry, true);
  const text = chunks.join('\n').slice(0, RETRIEVAL.MAX_TEXT_CHARS);

  const found = new Map(); // lowercase key -> { term, kind, weight, ci, order }
  let order = 0;
  const add = (term, kind, ci = false) => {
    if (typeof term !== 'string' || term.length < 4 || term.length > 80) return;
    const key = term.toLowerCase();
    const weight = KIND_WEIGHT[kind];
    const prior = found.get(key);
    if (prior && prior.weight >= weight) return;
    found.set(key, { term: prior ? prior.term : term, kind, weight, ci: (prior?.ci ?? false) || ci, order: prior ? prior.order : order++ });
  };

  for (const re of [/`([^`\n]{2,80})`/g, /'([^'\n]{2,80})'/g, /"([^"\n]{2,80})"/g]) {
    for (const m of text.matchAll(re)) {
      const lit = m[1].trim();
      if (/\.\.\.|[<>]/.test(lit)) continue;
      const words = lit.split(/\s+/).length;
      if (words === 1) { add(lit, 'literal'); for (const p of parts(lit)) add(p, 'part', true); }
      else if (words <= 6 && lit.length <= 60) add(lit, 'phrase');
    }
  }
  for (const re of IDENT_PATTERNS) for (const m of text.matchAll(re)) { add(m[0], 'identifier'); for (const p of parts(m[0])) add(p, 'part', true); }
  for (const m of text.matchAll(FILELIKE)) { add(m[0], 'filelike'); const base = m[0].split('/').at(-1); if (base !== m[0]) add(base, 'filelike'); for (const p of parts(m[0])) add(p, 'part', true); }
  for (const m of text.matchAll(/\b[A-Z][a-z]{5,}\b/g)) if (!startsSentence(text, m.index) && !STOP.has(m[0].toLowerCase())) add(m[0], 'word', true);

  return [...found.values()].sort((a, b) => b.weight - a.weight || a.order - b.order).slice(0, RETRIEVAL.MAX_TERMS).map(({ term, kind, weight, ci }) => ({ term, kind, weight, ci }));
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const DEF_KINDS = new Set(['identifier', 'literal', 'filelike']);
const definitionRe = (term) => {
  const t = escapeRe(term);
  return new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?(?:function\\*?\\s+|class\\s+|const\\s+|let\\s+|var\\s+)${t}\\b|\\b${t}\\s*[:=]\\s*(?:async\\s*)?(?:\\(|function\\b|[A-Za-z_$][\\w$]*\\s*=>)|^\\s*(?:async\\s+)?${t}\\s*\\([^)]*\\)\\s*\\{`);
};

/** Per-line term scores (see `locateRanges`). `perLine[i]` lists the indexes of the terms that occur on line i. */
const scoreLines = (lines, terms) => {
  const lower = lines.map((l) => l.toLowerCase());
  const perLine = lines.map(() => []);
  const freq = new Array(terms.length).fill(0);
  terms.forEach((t, ti) => {
    const needle = t.ci ? t.term.toLowerCase() : t.term;
    const hay = t.ci ? lower : lines;
    for (let i = 0; i < hay.length; i += 1) if (hay[i].includes(needle)) { perLine[i].push(ti); freq[ti] += 1; }
  });
  const defs = terms.map((t) => (DEF_KINDS.has(t.kind) ? definitionRe(t.term) : null));
  const score = perLine.map((hits, i) => hits.reduce((sum, ti) => sum + terms[ti].weight / (1 + Math.log(freq[ti])) + (defs[ti] && defs[ti].test(lines[i]) ? 3 : 0), 0));
  return { score, perLine };
};

/**
 * Windows worth showing for `lines` (plain text, 0-based array). Returns `{ ranges: [{start, end, score}], matched: [terms] }`
 * with 1-based inclusive line numbers, sorted by start; `ranges` is empty when nothing scores at least `minScore`.
 */
export const locateRanges = (lines, terms, { padBefore, padAfter, maxWindows, minScore }) => {
  if (!Array.isArray(lines) || lines.length === 0 || !Array.isArray(terms) || terms.length === 0) return { ranges: [], matched: [] };
  const { score, perLine } = scoreLines(lines, terms);
  const covered = new Array(lines.length).fill(false);
  const ranges = []; const matched = new Set();
  while (ranges.length < maxWindows) {
    let best = -1;
    for (let i = 0; i < lines.length; i += 1) if (!covered[i] && score[i] >= minScore && (best < 0 || score[i] > score[best])) best = i;
    if (best < 0) break;
    const start = Math.max(1, best + 1 - padBefore); const end = Math.min(lines.length, best + 1 + padAfter);
    let total = 0;
    for (let n = start; n <= end; n += 1) { covered[n - 1] = true; total += score[n - 1]; for (const ti of perLine[n - 1]) matched.add(terms[ti].term); }
    ranges.push({ start, end, score: Math.round(total * 100) / 100 });
  }
  return { ranges: ranges.sort((a, b) => a.start - b.start), matched: [...matched] };
};

// ---- second pass: prose stems, import bindings, gap bridging, all inside the caller's byte budget ----

const PROSE_STOP = new Set(['make', 'makes', 'work', 'works', 'seen', 'real', 'without', 'existing', 'unchanged', 'required', 'require', 'command', 'level', 'successful', 'style', 'still', 'because', 'being', 'their', 'there', 'these', 'those', 'would', 'could', 'reports', 'report']);
const stemOf = (word) => {
  let w = word.toLowerCase();
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith('es')) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
};

/** Stems of the plain prose words in the task's own text (same sources as `extractTerms`), for matching code sub-tokens. */
export const extractProseStems = (task) => {
  const sources = [];
  for (const field of ['objective', 'problem', 'expected_behavior', 'observed_behavior']) if (typeof task?.[field] === 'string') sources.push(task[field]);
  for (const entry of Array.isArray(task?.acceptance_criteria) ? task.acceptance_criteria : []) if (typeof entry === 'string') sources.push(entry);
  for (const entry of Array.isArray(task?.known_evidence) ? task.known_evidence : []) if (typeof entry === 'string') sources.push(entry.slice(0, RETRIEVAL.MAX_EVIDENCE_ENTRY_CHARS));
  const text = stripStackFrames(sources.join('\n')).slice(0, RETRIEVAL.MAX_TEXT_CHARS);
  const stems = new Set();
  for (const m of text.matchAll(/[A-Za-z]{4,}/g)) {
    const lower = m[0].toLowerCase();
    if (STOP.has(lower) || PROSE_STOP.has(lower)) continue;
    const stem = stemOf(lower);
    if (stem.length >= 4) stems.add(stem);
  }
  return [...stems].sort().slice(0, RETRIEVAL.MAX_TERMS * 2);
};

const codeStems = (line) => new Set((line.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z]{3,}/g) || []).map(stemOf));

const BINDING_LINE = /^\s*(?:(?:const|let|var)\s+(?:([A-Za-z_$][\w$]*)|\{([^}]*)\})\s*=\s*(?:await\s+)?(?:[\w$.]+\(\s*)?require\(|import\s+(?:([A-Za-z_$][\w$]*)|\*\s+as\s+([A-Za-z_$][\w$]*)|\{([^}]*)\})[^'"]*from\s+['"])/;
const bindingNames = (line) => {
  const m = line.match(BINDING_LINE);
  if (!m) return [];
  const names = [];
  for (const single of [m[1], m[3], m[4]]) if (single) names.push(single);
  for (const group of [m[2], m[5]]) if (group) for (const part of group.split(',')) { const alias = part.split(/\s+as\s+|:/).at(-1).trim(); if (/^[A-Za-z_$][\w$]*$/.test(alias)) names.push(alias); }
  return names;
};

/**
 * Deterministic, budget-bounded window plan for one file that does not fit the per-file cap.
 *
 * Pass 1 is `locateRanges` with the strict anchor thresholds (unchanged). Only when pass 1 found something -- a file with no
 * strong signal gets nothing, however much prose the task has -- pass 2 spends what is LEFT of `budgetBytes` (never more) on:
 *   1. `binding`:   the declaration (a few lines around it) of every module binding (`const x = require(..)`, `import x from ..`)
 *                   that a window already shown uses -- the place an edit to how that module is used has to reach;
 *   2. `bridge`:    the gap between two adjacent windows when it is at most `bridgeMaxGapLines` lines, cheapest gap first;
 *   3. `stem`:      the best remaining lines by task-prose word stems matched against code sub-tokens (`copyAppBundle` <-> "copies
 *                   the bundle"), with smaller pads, then `bridge` again with whatever is left.
 * A candidate is accepted only if the whole plan (line bytes + omission markers) still fits, so the result can be rendered
 * without truncation. Every window carries its provenance (`pass`, `via`, `score`, and the evidence for it).
 * Returns `{ ranges: [{start, end, score, pass, via, ...}], matched, plan_bytes }`.
 */
export const planRanges = (lines, terms, stems, budgetBytes) => {
  const empty = { ranges: [], matched: [], plan_bytes: 0 };
  if (!Array.isArray(lines) || lines.length === 0 || !Array.isArray(terms) || terms.length === 0) return empty;
  const first = locateRanges(lines, terms, RETRIEVAL.ANCHOR);
  if (first.ranges.length === 0) return empty;

  const P = RETRIEVAL.PLAN;
  const limit = Math.max(0, budgetBytes - P.reserveBytes);
  const lineCost = lines.map((l, i) => Buffer.byteLength(l, 'utf8') + String(i + 1).length + 3);
  const covered = new Array(lines.length).fill(false);
  const chosen = [];
  const measure = (mask) => {
    let bytes = 0; let runs = 0; let prev = false;
    for (let i = 0; i < mask.length; i += 1) { if (mask[i]) { bytes += lineCost[i]; if (!prev) runs += 1; } prev = mask[i]; }
    return { bytes: bytes + P.markerBytes * (runs + 1), runs };
  };
  const tryAdd = (start, end, provenance) => {
    const s = Math.max(1, start); const e = Math.min(lines.length, end);
    if (e < s) return false;
    let fresh = false;
    const mask = covered.slice();
    for (let n = s; n <= e; n += 1) { if (!mask[n - 1]) fresh = true; mask[n - 1] = true; }
    if (!fresh) return false;
    const { bytes, runs } = measure(mask);
    if (bytes > limit || runs > P.maxRuns) return false;
    for (let n = s; n <= e; n += 1) covered[n - 1] = true;
    chosen.push({ start: s, end: e, ...provenance });
    return true;
  };

  for (const range of [...first.ranges].sort((a, b) => b.score - a.score)) tryAdd(range.start, range.end, { score: range.score, pass: 1, via: 'term' });

  // 1. bindings used by what is already shown
  const declared = [];
  lines.forEach((line, i) => { for (const name of bindingNames(line)) if (!declared.some((d) => d.name === name)) declared.push({ name, line: i + 1 }); });
  let bindingWindows = 0;
  for (const { name, line } of declared) {
    if (bindingWindows >= P.binding.maxWindows) break;
    if (covered[line - 1]) continue;
    const use = new RegExp(`(?<![\\w$.])${name.replace(/[.*+?^${}()|[\]\\$]/g, '\\$&')}(?![\\w$])`);
    const used = lines.some((l, i) => covered[i] && i !== line - 1 && use.test(l));
    if (used && tryAdd(line - P.binding.padBefore, line + P.binding.padAfter, { score: 0, pass: 2, via: 'binding', binding: name })) bindingWindows += 1;
  }

  // 2. contiguity: fill the gap between adjacent windows, cheapest first (repeated after step 3 with what is then left)
  const bridge = () => {
    for (;;) {
      const gaps = [];
      let i = 0;
      while (i < lines.length) {
        if (!covered[i]) { i += 1; continue; }
        let j = i; while (j < lines.length && covered[j]) j += 1;
        let k = j; while (k < lines.length && !covered[k]) k += 1;
        if (j < lines.length && k < lines.length && k - j <= P.bridgeMaxGapLines) gaps.push({ start: j + 1, end: k });
        i = j;
      }
      gaps.sort((a, b) => (a.end - a.start) - (b.end - b.start) || a.start - b.start);
      if (!gaps.some((g) => tryAdd(g.start, g.end, { score: 0, pass: 2, via: 'bridge' }))) return;
    }
  };
  bridge();

  // 3. prose-stem windows: task-prose word stems matched against code sub-tokens. Comment lines count half (they describe
  // code, they are rarely what changes); a function/class declaration whose NAME carries a matched stem gets a bonus.
  if (Array.isArray(stems) && stems.length > 0) {
    const stemSet = new Set(stems);
    const perLine = lines.map((l) => [...codeStems(l)].filter((st) => stemSet.has(st)));
    const freq = new Map();
    for (const hits of perLine) for (const st of hits) freq.set(st, (freq.get(st) || 0) + 1);
    const scoreOf = (line, hits) => {
      if (hits.length === 0) return 0;
      let value = hits.reduce((sum, st) => sum + 1.5 / (1 + Math.log(freq.get(st))), 0);
      if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return value * 0.5;
      const declared = line.match(/^\s*(?:export\s+)?(?:async\s+)?(?:function\*?\s+|class\s+)([A-Za-z_$][\w$]*)/);
      if (declared && [...codeStems(declared[1])].some((st) => stemSet.has(st))) value += 2;
      return value;
    };
    const order = lines.map((l, i) => [i, scoreOf(l, perLine[i])]).filter(([, v]) => v >= P.secondary.minScore).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    let added = 0;
    for (const [i, v] of order) {
      if (added >= P.secondary.maxWindows) break;
      if (covered[i]) continue;
      if (tryAdd(i + 1 - P.secondary.padBefore, i + 1 + P.secondary.padAfter, { score: Math.round(v * 100) / 100, pass: 2, via: 'stem', stems: perLine[i].slice(0, 6) })) added += 1;
    }
    bridge();
  }

  const finalMask = covered;
  return { ranges: chosen.sort((a, b) => a.start - b.start), matched: first.matched, plan_bytes: measure(finalMask).bytes };
};

/** Relative module specifiers (`./x`, `../y`) imported by `text`, in order of first appearance, deduplicated. */
export const extractRelativeImports = (text) => {
  const out = [];
  const patterns = [/\brequire\(\s*(['"])(\.{1,2}\/[^'"\n]+)\1\s*\)/g, /\bfrom\s+(['"])(\.{1,2}\/[^'"\n]+)\1/g, /\bimport\(\s*(['"])(\.{1,2}\/[^'"\n]+)\1\s*\)/g, /^\s*import\s+(['"])(\.{1,2}\/[^'"\n]+)\1/gm];
  const all = [];
  for (const re of patterns) for (const m of String(text).matchAll(re)) all.push({ at: m.index, spec: m[2] });
  for (const { spec } of all.sort((a, b) => a.at - b.at)) if (!out.includes(spec)) out.push(spec);
  return out.slice(0, RETRIEVAL.MAX_IMPORTS_PER_FILE);
};

/** `path:line[:col]` references in the task's evidence (stack frames included: they are exactly such references). */
export const extractEvidenceRefs = (task) => {
  const refs = [];
  const re = /(?:file:\/\/)?((?:\/|\.{1,2}\/)?[\w@.\-/]+\.(?:mjs|cjs|js|jsx|ts|tsx|json)):(\d{1,6})(?::\d+)?/g;
  for (const entry of Array.isArray(task?.known_evidence) ? task.known_evidence : []) {
    for (const m of String(entry).slice(0, RETRIEVAL.MAX_EVIDENCE_ENTRY_CHARS).matchAll(re)) {
      const line = Number(m[2]);
      if (line >= 1 && !refs.some((r) => r.path === m[1] && r.line === line) && refs.length < RETRIEVAL.MAX_EVIDENCE_REFS) refs.push({ path: m[1], line });
    }
  }
  return refs;
};
