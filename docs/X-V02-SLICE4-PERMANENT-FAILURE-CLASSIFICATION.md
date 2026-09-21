# X v0.2 Slice 4 — Deterministic Permanent Failure Classification

Status: implemented, uncommitted. No model was run. Gold v1.2 untouched (fingerprint `f6ac8bfa…` re-verified).

## Problem
`PRECONDITION_FAILED` covered both "retry can fix it" and "nothing a retry can change". The repair loop had to call it
repairable, so a permanent context failure (e.g. an edit in an unshown region, or no usable snapshot of the target) used the
whole repair budget and was reported by Result Gate as `repair_budget_exhausted_transient`.

## Design
`PRECONDITION_FAILED` stays the `code` (compatibility). The code that DETECTS the condition adds a structured `subtype`
(`mcp/x/failure-kinds.mjs`), from what it actually verified about trusted state. The repair loop and Result Gate read the
subtype; nothing parses `detail` (test FC3 checks this by behavior and by source scan).

| subtype | set by | classification | failure_class |
|---|---|---|---|
| `stale_live_state` | hash/content mismatch; changed before publish; target created/changed earlier in the same run | repairable | live_state |
| `edit_mismatch` | old_string not in the file (or mis-copied outside a shown range) | repairable | model_edit |
| `edit_ambiguous` | old_string not unique | repairable | model_edit |
| `edit_form_invalid` | replace_all with an excerpt; whole-file replace of a partial view | repairable | model_edit |
| `create_target_exists` | create on an existing path that IS in the shown context | repairable | model_edit |
| `read_only_target` | patch/replace of a `status: reference` file | repairable | model_edit |
| `unseen_context` | old_string exists in the file but lies outside every shown range | **escalate** | context_limitation |
| `no_usable_context` | target has no complete/excerpt snapshot (unloaded, truncated) and did not change this run; also create on an existing never-shown file | **escalate** | context_limitation |
| `excerpt_provenance_invalid`, `precondition_missing` | internal contract defects | **escalate** | structural |

- A `PRECONDITION_FAILED` blocker without a known subtype keeps its old classification (repairable); an unknown subtype
  never changes behavior; a subtype is ignored unless `code === 'PRECONDITION_FAILED'`.
- The "old_string entirely inside a shown excerpt" gate moved from the executor into `applyEdits` (option `shown`), after the
  hash check, so it can tell real-but-unshown text (`unseen_context`) from a mis-copied string (`edit_mismatch`). Message text is
  unchanged; a drifted file now reports `stale_live_state` first.
- Result Gate: a permanent subtype → `FAILED` / `structural_execution_failure` with `evidence.failure_class` and
  `evidence.blocker.subtype` (reason_code taxonomy unchanged, per the module's own rule that underlying identifiers live in
  evidence). Repairable subtypes that exhaust the budget stay `NEEDS_REVIEW` / `repair_budget_exhausted_transient` (now with
  `failure_class`). Without a subtype the evidence shape is exactly as before.
- Unchanged: validation-failure repair (always repairable, same budget and evidence), `max_total_rounds`, all other codes.

## Results
- Slice 1 negative probe D (`79664a00cc`, edit outside the shown excerpt): before 3 rounds, `NEEDS_REVIEW/repair_budget_exhausted_transient`;
  now 1 round, `FAILED/structural_execution_failure`, file untouched.
- Truncated/no-usable-context fixture: 1 round, 1 model call. Stale-hash drift, non-unique and mis-copied `old_string`
  fixtures still repair and succeed in round 2; a mis-copied string inside an excerpt still uses the full 3 rounds.
- Tests: `scripts/test-x-failure-classification.mjs` (16). Mutation checks (ignore subtype / always `unseen_context` / drop
  same-run rule / drop gate branch) each fail the new tests. Full X suite 710 tests, 709 pass (only pre-existing `EVT12`).

## Decisions / limits
- FAILED vs NEEDS_REVIEW (decided): permanent `no_usable_context`, `unseen_context` and the structural provenance failures are `FAILED` / `structural_execution_failure`
  (same bucket as PATH_REJECTED/UNREADABLE_TARGET).
- `read_only_target` (decided after review): repairable / `model_edit`. The model can pick an authorized editable target in the next round; the write boundary refuses any reference-file write regardless (tests FC9/FC9b: file untouched, budget unchanged, a stubborn model ends as `repair_budget_exhausted_transient` with `failure_class: model_edit`).
- One existing test changed on purpose: `RL3` asserted that an unseen-file `replace` is repairable — exactly the case this slice
  makes permanent. It now uses a genuinely repairable case (`edit_mismatch` on a shown file); `RL3b` asserts the new behavior.
- `scripts/x-eval/runner/smoke.mjs` (not part of the Gold fingerprint) still contains expectations from before this slice
  (e.g. "spends its whole repair budget"); it was already flagged obsolete and was not touched.
