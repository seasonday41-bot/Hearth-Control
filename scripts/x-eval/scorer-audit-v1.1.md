# X-Eval v1.1 - Scorer audit and re-score (offline)

**Status: complete, offline only.** No Ollama call, no change to `mcp/x/*`. Trigger: the Step-6B Qwen run passed the locked hidden scorer (25/25) with a patch that broke two documented behaviors. This audit asks whether the other scorers have the same hole, and closes the holes it can prove.

## Method

1. **Mutants.** 19 hand-made variants of each task's FIXED tree, aimed at behavior the fix must **not** change or must fully cover (16 `wrong` = plausible but incorrect, 3 `correct, written differently`). Anchors verified to match exactly once.
2. **Three layers recorded per mutant:** visible validator / hidden scorer / regression net (`visible / hidden / net`; `fail` = the layer caught it). The **expectation is on the hidden scorer**: it must fail every wrong mutant and pass every correct-but-different one.
3. **Audit BEFORE any amendment** (scorers v1), then amend, then audit AFTER (scorers v1.1). Amendments are additive (no check removed or loosened); the v1 originals are kept in `qualification/scorers-v1-archive/`.
4. **Re-qualify** every scorer on parent/fixed (2 runs) after amending.

## Audit result

| task | mutant | kind | BEFORE (v1) vis / hid / net | hidden | AFTER (v1.1) vis / hid / net | hidden |
|---|---|---|---|---|---|---|
| c1d6770715 | top-level-blockers-collapsed (the Qwen patch) | wrong | fail / pass / fail | **GAP** | fail / fail / fail | ok |
| c1d6770715 | unrecognized-execution-code-collapsed | wrong | fail / fail / fail | ok | fail / fail / fail | ok |
| c1d6770715 | raw-identifier-not-kept-in-evidence | wrong | fail / fail / fail | ok | fail / fail / fail | ok |
| c1d6770715 | equivalent-constant-built-differently | correct, written differently | pass / pass / pass | ok | pass / pass / pass | ok |
| 070e9850b1 | equal-builtAt-counts-as-newer | wrong | fail / pass / pass | **GAP** | fail / fail / pass | ok |
| 070e9850b1 | missing-timestamp-fails-open | wrong | fail / fail / fail | ok | fail / fail / fail | ok |
| 070e9850b1 | version-compared-as-string | wrong | pass / pass / pass | **GAP** | pass / fail / pass | ok |
| 070e9850b1 | lower-version-falls-through-to-builtAt | wrong | fail / fail / pass | ok | fail / fail / pass | ok |
| 070e9850b1 | higher-version-falls-through-to-builtAt | wrong | fail / fail / fail | ok | fail / fail / fail | ok |
| 070e9850b1 | install-refuses-everything | wrong | fail / fail / pass | ok | fail / fail / pass | ok |
| 070e9850b1 | install-no-longer-requires-user-approval (unchanged behavior) | wrong | fail / pass / fail | **GAP** | fail / fail / fail | ok |
| 070e9850b1 | equivalent-comparison-written-differently | correct, written differently | pass / pass / pass | ok | pass / pass / pass | ok |
| 8d08bc3621 | failure-cleanup-uses-patched-fs | wrong | fail / pass / pass | **GAP** | fail / fail / pass | ok |
| 8d08bc3621 | copy-merges-into-existing-destination | wrong | pass / pass / pass | **GAP** | pass / fail / pass | ok |
| 8d08bc3621 | symlinks-dereferenced | wrong | fail / fail / fail | ok | fail / fail / fail | ok |
| 8d08bc3621 | top-level-symlink-candidate-accepted (unchanged behavior) | wrong | fail / pass / fail | **GAP** | fail / fail / fail | ok |
| 8d08bc3621 | traversal-buildId-accepted (unchanged behavior) | wrong | fail / pass / fail | **GAP** | fail / fail / fail | ok |
| 8d08bc3621 | tree-checksum-not-enforced (unchanged behavior) | wrong | fail / pass / fail | **GAP** | fail / fail / fail | ok |
| 8d08bc3621 | equivalent-extra-dereference-false | correct, written differently | pass / pass / pass | ok | pass / pass / pass | ok |

- **Before:** the v1 hidden scorers wrongly passed **9 of 16 wrong mutants** (c1d6770715: 1, 070e9850b1: 3, 8d08bc3621: 5). So the hole the real model found was **not unique to `c1d6770715`**.
- **2 mutants slipped past all three layers** (visible, hidden and net): `070e9850b1/version-compared-as-string`, `8d08bc3621/copy-merges-into-existing-destination`. No historical test covers them; only a new hidden control can.
- In the other cases the visible test and/or the regression net already caught the mutant, which is why the layers are kept **together**: the hidden scorer is no longer a single point of failure, but it is also not redundant.
- **After:** the hidden scorers fail **16 of 16** wrong mutants and pass **3 of 3** correct-but-different ones (gaps left: 0).

## What was added (scorer v1 -> v1.1)

| task | v1 checks | v1.1 checks | parent | fixed |
|---|---|---|---|---|
| c1d6770715 | 25 | 28 (+3) | failed (7/28, behavioral) | passed (28/28, behavioral) |
| 8d08bc3621 | 3 | 7 (+4) | failed (4/7, behavioral) | passed (7/7, behavioral) |
| 070e9850b1 | 9 | 13 (+4) | failed (7/13, behavioral) | passed (13/13, behavioral) |

- `c1d6770715` (+3): top-level blockers `invalid_task_scope` and `invalid_validation_command` keep their own `reason_code`; an unrecognized top-level blocker stays `NEEDS_REVIEW`.
- `070e9850b1` (+4): equal `builtAt` with a different `buildId` is not newer; semantic versions compare numerically (`0.10.0` > `0.9.0`, both directions); `installUpdate` without local user approval rejects and installs nothing.
- `8d08bc3621` (+4): `copyAppBundle` refuses to merge into an existing destination; a failed staging (wrong tree checksum) is a checksum error and removes the staged directory under Electron; a top-level symlink alias is rejected; a traversal-style `buildId` is rejected before any mount.
- Every amended scorer still **fails at the parent and passes at the fixed tree, stable over 2 runs**, and the original 10-mutant probe is unchanged (8/10 as expected; the 2 mismatches are the known over-constrained *visible source-text* tests of `4f261b2f4b` / `79664a00cc`, which the hidden scorers accept correctly).

## Regression net (new scoring layer)

For each task: the parent's own versions of the visible test and of every existing test that references the changed source. A failing test **name** is a regression unless it also fails at the parent or at the reference fix. Built offline, all files stable over 2 runs, none unusable.

| task | net files (parent -> reference fix) |
|---|---|
| c1d6770715 | `scripts/test-x-result-gate.mjs` (passed->failed, allowed failures 10, 35 ms)<br>`scripts/test-x-result-builder.mjs` (passed->passed, allowed failures 0, 35 ms) |
| 8d08bc3621 | `scripts/test-remote-update-integration.mjs` (passed->passed, allowed failures 0, 101 ms)<br>`scripts/test-remote-updater.mjs` (passed->passed, allowed failures 0, 771 ms) |
| 070e9850b1 | `scripts/test-updater.mjs` (passed->failed, allowed failures 7, 126 ms) |

No false positives: all three oracle replays still score `SUCCESS` with the net on (smoke checks A1, G2). Limits: name-based matching; `8d08bc3621` has no parent version of its own test (the test is new in the fix), so its net is two loosely related tests; `070e9850b1`'s net is essentially the visible test's parent version.

## Re-score of the Qwen baseline patch (`c1d6770715`, no model call)

| | |
|---|---|
| outcome recorded in Step 6B (v1 rules) | `SUCCESS`, X gate `NEEDS_REVIEW/repair_budget_exhausted_transient` |
| archived v1 scorer on the same patch | passed 25/25 |
| **v1.1 scorer** | **failed 26/28**: `top-level blocker invalid_task_scope stays FAILED with its OWN reason_code`; `top-level blocker invalid_validation_command stays FAILED with its OWN reason_code` |
| **regression net** | **2 regressions**: `escalation_required`; `escalation_required` |
| **outcome under Gold v1.1** | **`FAILURE`** (integrity_ok = false) |

The run is **not** rerun: the stored patch is re-scored through the same code path a live run uses (`runner/rescore.mjs` -> `score.mjs`). Two independent detectors now agree the patch is wrong.

## Limits (read before trusting the audit)

- The 19 mutants are **my** imagination, and the new controls were written **after** seeing which mutants slipped through. Closing those holes shows *those* holes are closed, not that none remain. A real model is a better adversary than I am; that is what found the first one.
- Three tasks, one reference fix each. The controls encode what the reference fix leaves unchanged, plus a few adjacent guarantees; they are not a full specification.
- The audit does not test the two STRUCTURAL_PROBE tasks or the two HOLD candidates (their scorers are unchanged).
