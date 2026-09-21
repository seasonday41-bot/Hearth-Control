# X v0.2 Slice 2 — Deterministic Context Retrieval

Status: implemented, uncommitted. No model was run (stub oracle only). Gold v1.2 untouched (fingerprint `f6ac8bfa…` verified by the probe runner).

## What it does
When a task authorizes a file that does not fit the per-file cap and gives no `path:START-END`, the loader locates the
relevant windows itself and hands them to the Slice 1 excerpt path. Deterministic: no model choice, no network, no new
commands, no scope expansion, and no per-file cap change (8,000 B production / 20,000 B model_quality stay as they were).

### Anchor windows (`planRanges`, `mcp/x/context-retrieval.mjs`)
1. **Terms** (identifiers, quoted literals, file-like names, word parts, mid-sentence proper nouns) from the task text and
   evidence; stack-frame lines contribute none. **Pass 1**: strict line scoring (frequency damping, definition bonus,
   ≤3 windows, min score 3) — unchanged.
2. **Pass 2**, only if pass 1 found something (a file with no strong signal gets nothing), spends what is LEFT of the caller's
   per-file byte budget — never more — in this order, each candidate accepted only if the whole plan (line bytes +
   omission markers) still fits:
   - `binding`: declaration (±3 lines) of every `const x = require(..)` / `import x from ..` binding that an already-shown window uses;
   - `bridge`: the gap between adjacent windows if ≤ 60 lines, cheapest first (locality: code between two relevant windows);
   - `stem`: lines whose code sub-tokens match stems of the task's prose words (`copyAppBundle` ↔ "copies the bundle");
     comments count half, a function/class declaration whose name carries a matched stem gets a bonus; pads 6/14, ≤3 windows;
   - `bridge` again with what remains.
   The window count is no longer hard-limited to 3 (auto excerpts may have ≤ 10 separate ranges; explicit
   `path:START-END` hints keep the Slice 1 limit of 4). Every window records `pass`, `via`, `score` and its evidence
   (`stems`, `binding`) in `retrieval.windows`.
3. **Evidence `path:line`** references (authorized paths only) become windows.

### Explicit read-only reference authority: `scope.reference_paths`
Decision: `allowed_paths` is the whole read AND write scope. An import neighbour outside it is **never** read automatically.
The smallest explicit grant is an optional `scope.reference_paths` array in the x-task-v1 contract (workspace-relative files
or directory prefixes, ≤64, normalized like the other scope arrays):
- absent ⇒ no reference authority at all (validated task shape unchanged): no out-of-scope file is ever read. Where every file also fits whole (the unchanged full-file path) the packet is then identical to retrieval off; a file that does not fit may still get an automatic excerpt of ITS OWN in-scope content;
- must not overlap `allowed_paths` or `forbidden_paths` (contract CONFLICT);
- grants READING only. `scopeCheck` / `isAuthorized` (editable files, evidence anchors, the write boundary, Phase 5B) never look at it;
- a reference file is `status: 'reference'`, `read_only: true` and is never patchable: not in the schema path enums, the executor
  refuses `create/replace/patch` on it, the prompt says so, and the write boundary refuses it (PATH_REJECTED) independently;
- candidates: import neighbours of a loaded anchor (one hop) and exact files listed in `reference_paths`; authority is decided on
  the RESOLVED path (a symlink into forbidden/unlisted/outside-workspace targets is refused); protected paths, forbidden_paths,
  secret redaction (fail-closed inside the shown window), ≤3 files, ≤4,000 B each and the total budget all apply;
- import neighbours inside `allowed_paths` may still be shown read-only (no expansion), tagged `authority: 'allowed_paths'`;
- repair rounds keep `reference_paths`. `options.retrieval === false` switches the whole feature off.
Upstream producers of tasks (`hearth-job-contract`, router, goals runner) do not emit `reference_paths` yet — adding it there is a separate change.

## Evidence (stub oracle; `scripts/x-eval/oracle-probes-v02-slice2-results.json`)
| task / config | retrieval off | on |
|---|---|---|
| 4f261b2f4b (both lanes) | FAILURE 3/8 | SUCCESS 8/8, excerpt 7,028 B (was 1,625 B before pass 2) |
| 79664a00cc (both lanes) | FAILURE 4/7 | SUCCESS 7/7, excerpt 4,678 B (was 1,424 B) |
| 8d08bc3621, Gold strict scope, production (8,000 B) | FAILURE (was) | **SUCCESS 7/7**, excerpt 7,228 B, no updater.cjs, no `original-fs` clue |
| 8d08bc3621, Gold strict scope, model_quality | SUCCESS | SUCCESS, prompt identical to off |
| 8d08bc3621 + explicit `reference_paths` (separate probe, not a Gold task) | — | SUCCESS in both lanes; `electron/updater.cjs` shown as `reference` (1,011 B) with the `original-fs` clue |
| c1d6770715, 070e9850b1 | — | prompt identical on/off |

Honest limits:
- The 8d08bc3621 production success came from a design (bindings + bridging + stem windows) made after seeing why the
  previous pass failed on this very task; it is not held-out evidence. Generality is only argued by the non-benchmark
  fixture tests (RT40–RT45) and the unchanged results on the other probes.
- Pass 2 fills much more of the per-file budget than pass 1 alone (4f261b2f4b prompt 11.3 KB → 16.7 KB): all inside the
  unchanged cap, but a larger, noisier prompt is a real trade-off for a small model. Not yet measured with a model.

## Tests
`scripts/test-x-context-retrieval.mjs` (31 tests, RT1–RT45). Full X suite: 677 tests, 676 pass; only pre-existing `EVT12` fails.
