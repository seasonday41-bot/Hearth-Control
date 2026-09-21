/**
 * X v0.2 Slice 3 -- Structured Repair Evidence Digest (pure functions; no filesystem, process, network or model).
 *
 * Turns the raw output of a failed `node --test` validation into a small, bounded, deterministic digest so the next repair
 * round sees WHICH tests failed, what was expected vs. actual, the first relevant error and where it happened
 * (`path:line:col`), instead of only the last ~1.8 KB of noise. It is a plain text parse of the Node test runner's own
 * "failing tests" section (spec reporter): no model, no heuristics about meaning, no I/O. It only reformats text the
 * validation command already produced.
 *
 * It never decides pass/fail (Phase 7's exit-code authority is untouched) and it never invents anything: every field is
 * copied (and bounded) from the output. When the output cannot be parsed the digest is empty and the caller keeps the
 * previous raw-tail behavior. Absolute paths inside the workspace are rewritten to workspace-relative; any other absolute
 * path is reduced to `<external>/<basename>` so evidence never carries host layout.
 */

export const DIGEST = Object.freeze({
  MAX_BYTES: 1350, // whole digest text
  MAX_FAILURES: 4, // failures shown in full; the rest are listed by name
  MAX_INPUT_CHARS: 400_000, // input is bounded before it is scanned
  MAX_NAME: 90,
  MAX_MESSAGE: 220,
  MAX_VALUE: 110,
  MAX_DIFF_LINES: 8,
  MAX_DIFF_LINE: 90,
  MAX_OTHER_NAMES: 8,
});

const ANSI = /\[[0-9;]*[A-Za-z]/g;
const FAILING_HEADER = /^✖ failing tests:\s*$/;
const TEST_AT = /^test at (.+?):(\d+):(\d+)\s*$/;
const FAIL_LINE = /^(\s*)✖ (.+?) \((?:[\d.]+)ms\)(?: # .*)?\s*$/;
const COUNT_LINE = /^(?:#|ℹ)\s+(tests|pass|fail)\s+(\d+)$/;
const FRAME = /^\s+at (.*)$/;
const PROPERTY = /^\s{2,}(actual|expected|operator|code):\s*(.*?),?\s*$/;
const ERROR_HEAD = /^([A-Za-z_$][\w$.]*(?:Error|Exception)?(?: \[[A-Z0-9_]+\])?):\s?(.*)$/;
const ERROR_LINE = /^\s*(?:Uncaught\s+)?([A-Za-z_$][\w$]*(?:Error|Exception)(?: \[[A-Z0-9_]+\])?):\s*(.+)$/;
const COMPLEX_VALUE = /^(?:\[Object\]|\[Array\]|\[Function[^\]]*\]|<ref \*\d+>|\[|\{|\[Circular)/;

const byteLength = (text) => Buffer.byteLength(text, 'utf8');
const cutBytes = (text, maxBytes) => {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString('utf8');
};
const cutTailBytes = (text, maxBytes) => {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= maxBytes) return text;
  let start = buf.byteLength - maxBytes;
  while (start < buf.byteLength && (buf[start] & 0xc0) === 0x80) start += 1;
  return buf.subarray(start).toString('utf8');
};
/** Same policy as the raw evidence tail: an over-long message keeps its END (where the runner's diagnostic usually is). */
const tailOnly = (text, maxBytes) => {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return byteLength(flat) <= maxBytes ? flat : `... ${cutTailBytes(flat, Math.max(8, maxBytes - 4))}`;
};
/** Keeps BOTH ends of a long text (a long message usually ends with the part that matters). */
const headTail = (text, maxBytes) => {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  if (byteLength(flat) <= maxBytes) return flat;
  const side = Math.max(8, Math.floor((maxBytes - 5) / 2));
  return `${cutBytes(flat, side)} ... ${cutTailBytes(flat, side)}`;
};

const rootVariants = (roots) => {
  const out = new Set();
  for (const raw of Array.isArray(roots) ? roots : []) {
    if (typeof raw !== 'string' || !raw.startsWith('/')) continue;
    const root = raw.replace(/\/+$/, '');
    if (!root) continue;
    out.add(root);
    if (root.startsWith('/private/')) out.add(root.slice('/private'.length));
    else if (/^\/(?:tmp|var|etc)\//.test(root)) out.add(`/private${root}`);
  }
  return [...out].sort((a, b) => b.length - a.length);
};

/** Rewrites host paths: inside the workspace -> relative; any other absolute path -> `<external>/basename`. */
const makeScrubber = (roots) => {
  const variants = rootVariants(roots);
  return (text) => {
    let out = String(text).replace(/file:\/\//g, '');
    for (const root of variants) out = out.split(`${root}/`).join('');
    return out.replace(/(?<![\w:.\-])\/(?:[\w.@+-]+\/)+([\w.@+-]+)/g, '<external>/$1');
  };
};

/** Same path rewriting the digest applies, for the short raw tail printed next to it. */
export const scrubHostPaths = (text, roots = []) => makeScrubber(roots)(text);

const isTestFile = (rel) => /(?:^|\/)(?:test-[^/]*|[^/]*\.(?:test|spec)\.[^/]*)$/.test(rel) || /(?:^|\/)(?:tests?|__tests__)\//.test(rel);

/** `at fn (loc)` / `at loc` -> { path, line, col } for a workspace-relative source location, else null. */
const parseFrame = (rest, scrub) => {
  const inner = rest.match(/\(([^()]+)\)\s*\{?$/)?.[1] ?? rest.replace(/\s*\{$/, '');
  if (/^(?:node:|<anonymous>|native)/.test(inner) || inner.includes('node:internal') || inner.includes('node_modules')) return null;
  const loc = scrub(inner).match(/^(.+?):(\d+):(\d+)$/);
  if (!loc || loc[1].startsWith('/') || loc[1].startsWith('<external>') || loc[1].startsWith('..')) return null;
  return { path: loc[1], line: Number(loc[2]), col: Number(loc[3]) };
};

const parseCounts = (lines) => {
  const counts = {};
  for (const line of lines) { const m = line.match(COUNT_LINE); if (m) counts[m[1]] = Number(m[2]); }
  return counts;
};

/** One `test at ...` block of the "failing tests" section -> a failure record, or null when it carries no error body. */
const parseBlock = (blockLines, testAt, scrub) => {
  const nameIndex = blockLines.findIndex((l) => FAIL_LINE.test(l));
  if (nameIndex < 0) return null;
  const name = blockLines[nameIndex].match(FAIL_LINE)[2];
  const body = blockLines.slice(nameIndex + 1).map((l) => (l.startsWith('  ') ? l.slice(2) : l));
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body.at(-1).trim()) body.pop();
  if (body.length === 0) return null;

  const frameStart = body.findIndex((l) => FRAME.test(l));
  const messageLines = (frameStart < 0 ? body : body.slice(0, frameStart)).filter((l, i, arr) => !(i === arr.length - 1 && !l.trim()));
  const head = (messageLines[0] ?? '').match(ERROR_HEAD);
  const errorName = head ? head[1] : null;
  const firstMessage = head ? head[2] : (messageLines[0] ?? '');
  const detailLines = messageLines.slice(1).filter((l) => l.trim());

  const props = {};
  for (const line of body) { const m = line.match(PROPERTY); if (m && !(m[1] in props)) props[m[1]] = m[2]; }
  const simple = (v) => typeof v === 'string' && v !== '' && !COMPLEX_VALUE.test(v);
  const hasValues = simple(props.expected) && simple(props.actual);

  const frames = body.filter((l) => FRAME.test(l)).map((l) => parseFrame(l.match(FRAME)[1], scrub)).filter(Boolean);
  const sourceFrame = frames.find((f) => !isTestFile(f.path)) ?? null;
  const firstFrame = frames.find((f) => isTestFile(f.path)) ?? frames[0] ?? null; // the test-side location (the call/assertion site)

  return {
    name, test_at: testAt, error: errorName, message: firstMessage,
    expected: hasValues ? props.expected : null, actual: hasValues ? props.actual : null, operator: props.operator ?? null,
    detail: hasValues ? [] : detailLines, source_frame: sourceFrame, first_frame: firstFrame,
  };
};

const fmtLoc = (f) => `${f.path}:${f.line}:${f.col}`;
const failureText = (f, index, scrub) => {
  const S = (t) => scrub(t);
  const out = [`${index}. ${headTail(S(f.name), DIGEST.MAX_NAME)}${f.test_at ? ` [${f.test_at}]` : ''}`];
  const first = [f.error, f.message ? tailOnly(S(f.message), DIGEST.MAX_MESSAGE) : ''].filter(Boolean).join(': ');
  if (first) out.push(`   ${first}`);
  if (f.expected !== null) { out.push(`   expected: ${headTail(S(f.expected), DIGEST.MAX_VALUE)}`); out.push(`   actual: ${headTail(S(f.actual), DIGEST.MAX_VALUE)}`); }
  else for (const line of f.detail.slice(0, DIGEST.MAX_DIFF_LINES)) out.push(`   | ${cutBytes(S(line).trimEnd(), DIGEST.MAX_DIFF_LINE)}`);
  const where = f.source_frame ?? f.first_frame;
  if (where) {
    const caller = f.source_frame && f.first_frame && f.first_frame !== f.source_frame ? ` (called from ${fmtLoc(f.first_frame)})` : '';
    out.push(`   at ${fmtLoc(where)}${caller}`);
  }
  return out.join('\n');
};

/**
 * @param {string} output combined stdout/stderr of the validation command
 * @param {{ roots?: string[] }} [options] absolute workspace root(s) used to relativize paths
 * @returns {{ parsed: boolean, kind: 'failing_tests'|'names_only'|'error_only'|null, counts: object, failures: object[], text: string }}
 */
export const buildValidationDigest = (output, { roots = [], maxBytes = DIGEST.MAX_BYTES } = {}) => {
  const none = { parsed: false, kind: null, counts: {}, failures: [], text: '' };
  if (typeof output !== 'string' || !output.trim()) return none;
  const lines = output.slice(0, DIGEST.MAX_INPUT_CHARS).replace(ANSI, '').replace(/\r\n?/g, '\n').split('\n');
  const scrub = makeScrubber(roots);
  const counts = parseCounts(lines);

  // 1. the runner's own "failing tests" section
  const failures = [];
  const header = lines.findIndex((l) => FAILING_HEADER.test(l));
  if (header >= 0) {
    let current = null;
    const flush = () => { if (current) { const f = parseBlock(current.lines, current.at, scrub); if (f) failures.push(f); } };
    for (const line of lines.slice(header + 1)) {
      const at = line.match(TEST_AT);
      if (at) { flush(); current = { at: scrub(`${at[1]}:${at[2]}`), lines: [] }; } else if (current) current.lines.push(line);
    }
    flush();
  }

  const summary = Number.isInteger(counts.fail) && Number.isInteger(counts.tests)
    ? `Test results: ${counts.fail} failed, ${Number.isInteger(counts.pass) ? `${counts.pass} passed, ` : ''}${counts.tests} total.`
    : '';
  const assemble = (kind, parts) => {
    const text = cutBytes(parts.filter(Boolean).join('\n'), maxBytes).trimEnd();
    return text ? { parsed: true, kind, counts, failures, text } : none;
  };

  if (failures.length > 0) {
    const shown = []; let used = byteLength(summary) + 60;
    for (const [i, f] of failures.slice(0, DIGEST.MAX_FAILURES).entries()) {
      const text = failureText(f, i + 1, scrub);
      if (shown.length > 0 && used + byteLength(text) > maxBytes - 120) break;
      shown.push(text); used += byteLength(text) + 1;
    }
    const rest = failures.slice(shown.length);
    const more = rest.length ? `... and ${rest.length} more failing: ${rest.slice(0, DIGEST.MAX_OTHER_NAMES).map((f) => headTail(scrub(f.name), 40)).join('; ')}` : '';
    return assemble('failing_tests', [summary, 'Failures (from the test runner output):', ...shown, more]);
  }

  // 2. no usable failing section (missing, or cut off by the output cap): names of the tests marked failed while running,
  // plus the first error-looking line and the first workspace location that follows it.
  const names = [];
  for (const line of lines) { const m = line.match(FAIL_LINE); if (m && !names.includes(m[2])) names.push(m[2]); }
  let firstError = null;
  for (let i = 0; i < lines.length && !firstError; i += 1) {
    const m = lines[i].match(ERROR_LINE);
    if (!m || FRAME.test(lines[i])) continue;
    let frame = null;
    for (let j = i + 1; j < Math.min(lines.length, i + 40) && !frame; j += 1) { const f = lines[j].match(FRAME); if (f) frame = parseFrame(f[1], scrub); }
    firstError = { text: `${m[1]}: ${tailOnly(scrub(m[2]), DIGEST.MAX_MESSAGE)}`, frame };
  }
  if (names.length === 0 && !firstError) return none;
  return assemble(names.length ? 'names_only' : 'error_only', [
    summary,
    names.length ? `Failed tests (names only; the detailed failure section is missing or was cut off): ${names.slice(0, DIGEST.MAX_OTHER_NAMES + 2).map((n) => headTail(scrub(n), DIGEST.MAX_NAME)).join('; ')}${names.length > DIGEST.MAX_OTHER_NAMES + 2 ? ' ...' : ''}` : '',
    firstError ? `First error: ${firstError.text}${firstError.frame ? `\n   at ${fmtLoc(firstError.frame)}` : ''}` : '',
  ]);
};
