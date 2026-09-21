# X-Eval v1 - Step 6B: Qwen baseline (HALTED after 1 of 3 tasks)

**Status: HALTED by a locked stop rule after `c1d6770715`.** Tasks `8d08bc3621` and `070e9850b1` were **not run**. Nothing was rerun, no config was changed, frozen X v0.1 untouched (`mcp/x` clean, verified), nothing committed. Lock fingerprint on the run = `9c2bf47f2b6662a7...` (matches `gold-set-v1.md`).

This is one run on one task. Treat every statement below as an observation, not a rate.

## What ran (recorded on the run)

| | |
|---|---|
| model | `qwen3.5:9b-hermes` (9.7B, Q4_K_M), digest `1af3a80989f1`, Ollama 0.33.2 |
| host | Apple M5, 16 GB, macOS 26.6.2, Node v24.19.0 |
| lane | `model_quality`; eval overrides: `maxBytesPerFile=20000`, `num_ctx=16384` (+ determinism controls `temperature=0`, `seed=42`) |
| context actually loaded by Ollama | `context_length = 16384` (from `/api/ps`, after warm-up and after the run) |
| output cap | `effective_num_predict = 4096` on all 3 calls (see the `num_predict` discrepancy in `gold-set-v1.md`) |
| warm-up | 3815 ms, not scored |

## Result of `c1d6770715`

| | |
|---|---|
| outcome under the LOCKED rules | `SUCCESS`, but `gate_agrees = false` (X's own gate: `NEEDS_REVIEW / repair_budget_exhausted_transient`) |
| rounds / model calls | 3 / 3; `finish_reason` = stop, stop, stop (no `length`) |
| prompt bytes per call | 24316, 27096, 27091 |
| response chars per call | 3116, 1190, 1659 |
| wall time per call | 52 s, 33 s, 41 s; X total 126 s |
| final diff vs baseline | +16/-2 in `mcp/x/result-gate.mjs` (reference fix: +7/-4) |
| hidden scorer (locked v1) | 25/25; no tampering, no out-of-scope edit |
| X's visible validation at the end | **failed in all 3 rounds** |

## Finding 1 (most important): the "SUCCESS" is an instrument false positive

The model did the intended change in round 1: the ten listed identifiers now collapse to `structural_execution_failure` with the raw identifier kept in evidence. It also **over-generalized**: it changed the *top-level blocker* path (`invalid_task_scope`, `invalid_validation_command`) to return the same constant, which the reference fix deliberately leaves alone. The task text did not mention top-level blockers.

Offline re-scoring of the stored patch (no model call, lock untouched; `analysis/rescore-c1d6770715.mjs`):

| check | result on the model patch |
|---|---|
| historical fixed test (the visible validator) | **fails 2 tests**: "escalation_required: invalid_task_scope -> FAILED", "escalation_required: invalid_validation_command -> FAILED" |
| regression net = the **parent's own** test file, minus the 10 tests the reference fix intentionally changed | **2 regressions**: the same two tests |
| locked hidden scorer v1 (25 checks) | passes on the **fix and on the model patch** (25/25 both): it has no control for top-level blockers |
| proposed scorer v2 (28 checks, +3 controls; NOT in the lock) | parent 7/28 fail, fix 28/28 pass, **model patch 26/28 fail** |

So the correct reading is **the model did not produce a correct fix**: it breaks two documented behaviors. The Step-4 sensitivity probe covered "over-broad safety codes" but not "over-broad top-level blockers"; a real model found the hole in one run. The outcome rule "hidden passes, so SUCCESS" is too weak when X's own validation disagrees: `gate_agrees=false` should be a **review flag**, not a footnote. Files: `qualification/scorers-proposed/c1d6770715.v2.mjs` (proposal only; the lock fingerprint did not change).

The regression net (run the parent's tests against the final tree, excluding tests that also fail on the reference fix) is general and needs no per-task authoring. Limit: it needs a parent version of the test; `8d08bc3621`'s test file is new in the fix, so its net would be empty.

## Finding 2: how the repair loop went (X scaffolding and model, not separable from one run)

- Round 1 validation failed with two assertion failures. The evidence X fed back is the **last 1,800 bytes of test-runner output**, and most of it is Node async stack frames (`at Test.runInAsyncScope ...`). The useful lines (`+ actual 'structural_execution_failure' / - expected 'invalid_task_scope'`) are present but diluted.
- Round 2: the model read the failure in the **wrong direction**: its explanation says it will make `invalid_task_scope` and `invalid_validation_command` "also return structural_execution_failure", which is what the test says is wrong. Round 3: the explanation says "no edit is required" while the same response contains a 356 -> 863 character patch. The explanation field is unverified prose and disagreed with the action.
- Nothing here shows the evidence format *caused* the misreading; it is a hypothesis worth testing, and it lines up with the earlier concern about X's evidence quality.

## Finding 3: cost and window

Prompts were 24-27 KB (about 7K tokens by estimate) inside a 16,384 window: no truncation risk here. Responses were 1.2-3.1K characters; the round-1 response (3,116 chars, roughly 0.9K tokens by estimate) would have sat close to a literal 1,024-token cap, which is evidence for the open `num_predict` decision. 33-52 s per call, ~2 minutes per task.

## Finding 4: why it halted (memory)

| | |
|---|---|
| rule that fired | flag: pressure level >= 2 for 3-4 consecutive samples (~8 s) |
| first sample of the task | level 2, free memory 16% (it was 76% before the model loaded, 26% right after warm-up) |
| end of task | level 1, free 22% |
| max pressure level / min free | 2 / 16% |
| swap growth | +28 MB (abort threshold 2,048 MB; ~3.8 GB was already in use before the run) |
| Ollama resident memory (peak) | 6900 MB |
| abort rules | **not triggered**; no timeout, no model error |

The flag fired at the start of the task (prompt evaluation on a 6.9 GB resident model, with the desktop apps open) and cleared on its own. It is **warn-level pressure with no swap thrash**, but the locked rule says stop, so it stopped. I did not judge it abnormal-enough-to-ignore.

## Decisions needed (nothing was changed to work around any of them)

1. **Memory flag.** Keep the rule and free memory before resuming (close other apps), or relax the flag (for example, require the warn level to persist much longer than ~8 s). Changing it changes `lanes.mjs` and therefore the lock fingerprint (a v1.1). It does not affect results.
2. **Hidden scorer for `c1d6770715`.** Adopt the v2 controls and the regression-net rule as a **Gold v1.1**, and re-score the stored patch under it (no model rerun). Also audit the other two scorers for the same hole before running them.
3. **Outcome rule.** Treat `hidden passes AND X validation fails` as `REVIEW`, not `SUCCESS`.
4. **`num_predict`.** Still open (literal 1,024 vs the effective 4,096).
5. Then resume tasks 2 and 3.

## Evidence kept in the repo

`baseline-qwen-v1-results.json` (summary), `baseline-artifacts/c1d6770715-qwen-s0/` (`run-record.json` with every prompt and response, `final.patch`), `analysis/rescore-c1d6770715.mjs` and its results, `qualification/scorers-proposed/c1d6770715.v2.mjs`.
