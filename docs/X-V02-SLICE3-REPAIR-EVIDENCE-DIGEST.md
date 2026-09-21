# X v0.2 Slice 3 — Structured Repair Evidence Digest

Status: implemented, uncommitted. No model was run. Gold v1.2 untouched (fingerprint `f6ac8bfa…` re-verified).

## Before / after
Before: the repair evidence for a failed required validation was `Validation '<cmd>': failed; exit N` + the last 1,800 B of raw output.
On a multi-test failure that tail is mostly the last test's stack frames.

After (`mcp/x/repair-digest.mjs`, used by `buildRepairEvidence` in `mcp/x/repair-loop.mjs`): a deterministic text parse of the
Node test runner's own "failing tests" section (spec reporter):

```
Repair context from round 1:
Validation 'node --test scripts/test-calc.mjs': failed; exit 1
  digest:
    Test results: 2 failed, 0 passed, 2 total.
    Failures (from the test runner output):
    1. total adds two numbers [scripts/test-calc.mjs:4]
       AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
       expected: 4
       actual: 5
       at scripts/test-calc.mjs:4:37
    2. explode is safe [scripts/test-calc.mjs:5]
       RangeError: out of range in explode
       at src/calc.js:2:32 (called from scripts/test-calc.mjs:5:...)
  tail: <last ≤600 B of output, host paths rewritten>
```

## Rules
- Fields: failed test name, first error line, expected/actual (simple values) or a bounded diff (≤8 lines) for complex values,
  first workspace `file:line:col` (source frame preferred, test-side call site shown as "called from"), counts, short tail.
- Bounds: digest ≤1,350 B (≤4 failures in full, the rest listed by name), messages ≤220 B keeping their END (same policy as
  the raw tail), values ≤110 B, whole evidence still ≤2,500 B; multi-byte safe; multiple required commands share the budget.
- Paths: workspace paths (incl. `/private` aliases) → relative; other absolute paths → `<external>/basename`; `node:` internals
  and `node_modules` frames are skipped. The short tail gets the same rewriting.
- Fallbacks: no failing section (missing, or cut by the 200 KB stdout cap) → names of tests marked failed and/or the first
  error line with its location; nothing parseable → EXACTLY the previous evidence (raw tail 1,800 B). The header
  `Repair context from round N:` is unchanged (it is what `isRepairTask` keys on).
- Not changed: pass/fail authority (exit code), repair-round count/budget, execution-kind evidence, model calls (none),
  network (none), secret redaction of `known_evidence` (still done by the context loader).
- Retrieval synergy: the digest's `path:line` lines are picked up by Slice 2's evidence-anchor logic, so the failing source
  line of an over-cap file becomes a shown excerpt window in the next round.

## Limits
- Only the Node ≥ 20 spec reporter format (what `node --test` prints in this environment, Node 24) is parsed; TAP or custom
  reporters fall back to the raw tail. The validation runner only runs `node --test`, so this covers current usage.
- `expected`/`actual` come from the AssertionError properties, which Node prints as `[Object]` for nested values; those fall
  back to the diff text. Values are not re-derived.
- Not measured with a real model: whether the digest improves repair success is untested (no Qwen run by instruction).

## Tests
`scripts/test-x-repair-digest.mjs` (17 tests: canned runner output, real `node --test` runs, real repair loop with a fake
adapter). Full X suite: 694 tests, 693 pass; only the pre-existing `EVT12` fails.
