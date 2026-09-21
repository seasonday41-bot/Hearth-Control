# X v0.2 candidate — frozen (uncommitted), before any real-model baseline

Manifest: `scripts/x-eval/x-v02-candidate.json` (content hashes of the X code closure and the X tests; `committed: false`,
base HEAD `11ef37b6fe`). Check at any time: `node scripts/x-eval/runner/x-candidate.mjs --verify`.
`baseline.mjs` now REFUSES to run unless the worktree equals this manifest (and Gold equals `f6ac8bfa…`), and records the
candidate hash in its result. Any intentional change to X or its tests requires `--freeze` again (= a new candidate).

## What the candidate contains
| Slice | Change | Files |
|---|---|---|
| 1 | Large-file excerpt patch (`path:START-END`, gated patch-from-excerpt) | context-loader, local-executor, edit-writer |
| 2 | Deterministic retrieval: terms, evidence refs, budget-bounded 2nd pass (bindings, bridges, prose stems); explicit read-only `scope.reference_paths` (default deny) | context-retrieval (new), context-loader, task-contract, repair-loop |
| 3 | Structured repair evidence digest (fallback: old raw tail) | repair-digest (new), repair-loop |
| 4 | `PRECONDITION_FAILED` subtypes; permanent context failures escalate after 1 round → `FAILED/structural_execution_failure`; `read_only_target` is repairable/model_edit | failure-kinds (new), edit-writer, local-executor, repair-loop, result-gate |

Per-slice details: `docs/X-V02-SLICE{1,2,3,4}-*.md`. Unchanged by design: per-file caps (8,000 / 20,000 B), repair budget
(3 rounds), validation authority (exit code), write boundary, secret guard, Gold v1.2 (fingerprint `f6ac8bfa…`, no input touched).

## Final deterministic state
- X suite `node --test scripts/test-x-*.mjs`: 715 tests, 714 pass; 1 fail = `EVT12`, pre-existing and unrelated (Electron relay source-text test; was 617/616/1 before any v0.2 change).
- Related goal/queue/router/specialist suites: 77/77.
- Runner smoke (updated for v0.2): 49/49. Structural probes are now solved by retrieval; the old truncated-context behavior is a
  retrieval-off CONTROL that ends after ONE round as a structural context limitation. F4 checks the frozen manifest.
- Stub-oracle probes: `4f261b2f4b`, `79664a00cc` SUCCESS (both lanes, from file-level hints); `8d08bc3621` strict scope SUCCESS in both
  lanes; cross-file `reference_paths` probe SUCCESS with the `original-fs` clue; small-file prompts identical on/off.
- Baseline dry run (`--adapter stub:oracle`): 3/3 SUCCESS, freeze guard active.
- No Qwen/Ollama run, no network, nothing committed.

## Known limits (unchanged since the slice reports)
- Retrieval success on `8d08bc3621` (production lane) is not held-out evidence; pass 2 makes prompts larger (e.g. `4f261b2f4b` 11.3 → 16.7 KB); effect on a real model is unmeasured.
- Digest parses only the Node spec reporter; other formats fall back to the raw tail. Its effect on repair success is unmeasured.
- Upstream task producers (job contract, router, goals runner) do not emit `reference_paths` yet.
- Working tree is uncommitted: the freeze identifies content, not a git commit. Commit only after the final state is accepted.

## Next (not done)
Real-model baseline for the X v0.2 candidate — awaiting approval.
