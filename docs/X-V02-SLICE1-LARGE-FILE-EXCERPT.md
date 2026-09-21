# X v0.2 Slice 1 - large-file targeted (excerpt) patch

Status: implemented, uncommitted. Changes `mcp/x/context-loader.mjs`, `mcp/x/local-executor.mjs`, `mcp/x/edit-writer.mjs`. Tests: `scripts/test-x-excerpt-patch.mjs` (29).

## Problem

X v0.1 may `patch` or `replace` only a file it was shown **completely** (`status: ok`). A file over the per-file cap (8,000 B default, 20,000 B hard) is loaded as a `truncated` head and every edit is refused, so a 75-148 KB file such as `electron/main.cjs` could never be edited, regardless of the model.

## What it adds (and what it does not)

- **No cap is raised.** `maxBytesPerFile`, `maxTotalBytes`, the hard ceilings and the packet ceiling are untouched; an excerpt is charged to the same budgets.
- **Whole-file replace from partial context stays impossible.** `replace` and `replace_all` are refused for an excerpt file, and the response schema does not offer `replace` for it.
- **Every path without an excerpt is unchanged.** Prompts and schema for a context with no excerpt are byte-identical to v0.1 (frozen hashes in test `XP40`); a range hint on a file that fits the cap is ignored (loaded whole); no hint = same `truncated` behavior and the same refusal wording.

## Task syntax

`suspected_area` entries may carry a 1-based inclusive range: `electron/main.cjs:694-706` or `electron/main.cjs:527`. Up to 4 ranges per file (merged when they touch), 400 lines each. The supervisor names the lines; X does not search for them. An invalid range is treated as an ordinary path (and is then simply not found). A range wins even if a repair round later adds the same file to `preferred_files`.

## Excerpt record

Only when the file does **not** fit the per-file cap, a range was requested, and the gateway read the whole file (<= 1 MB): `status: 'excerpt'`, `content` with the shown lines (original `N: ` numbers) and `... (lines A-B not shown) ...` markers, `excerpts: [{start_line, end_line}]`, and `full_file: {bytes, lines, sha256}` computed from the trusted read of the **whole** file. Fail-closed to the old `truncated` behavior if a shown line was touched by secret redaction, the line count changed, or any line prefix is unexpected.

## Patch gates (trusted side, before the atomic write)

1. no `replace_all`; 2. excerpt provenance is self-consistent (ranges match the content); 3. every `old_string` lies **entirely inside one shown range** (so text copied with the `N: ` prefix, spanning a marker, or outside the excerpt is refused); 4. every `old_string` occurs **exactly once in the whole ORIGINAL file** (judged before any edit, so an earlier edit cannot make a later ambiguous string look unique); 5. the live file still hashes to the recorded **full-file** hash (drift anywhere, shown or not, aborts and the drifted file is not overwritten); 6. Phase 5B scope / symlink / protected-path checks and the atomic publish. The model supplies none of these.

## Known limits

- The supervisor must supply line ranges; there is no automatic localization.
- After an edit that adds or removes lines, a repair round shows the same numbers over shifted text; give a margin.
- A refused patch still returns `PRECONDITION_FAILED`, which X classifies as *repairable*, so it can spend all 3 rounds and report `repair_budget_exhausted_transient` (unchanged; a separate item).
- Not applied to `create`, to search results, or to files over 1 MB.
