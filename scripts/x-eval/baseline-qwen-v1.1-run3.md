# X-Eval v1.1 - Step 6E: Qwen baseline, `070e9850b1` (completed, no stop condition)

**Status: the approved run completed; no stop rule fired; stopped here as instructed.** One run on one task: an observation, not a rate. `c1d6770715` and `8d08bc3621` were **not rerun**. Gold v1.1 fingerprint `a472f193ea1e788a...` (asserted at start and confirmed after). `mcp/x` untouched, nothing committed. Runtime protocol: `runtime-protocol-amendment-2.md`.

Files: `baseline-qwen-v1.1-run3-results.json`, `baseline-artifacts/070e9850b1-qwen-s0/` (`run-record.json` with every prompt and response, `final.patch`, `telemetry.json`), `analysis/probe-net-message-sensitivity.mjs`.

## What ran

`qwen3.5:9b-hermes`, lane `model_quality`: `maxBytesPerFile=20000`, `num_ctx=16384` (Ollama reported `context_length=16384`), effective `num_predict=4096`, `longResponse` true, 300 s timeout, `temperature=0`, `seed=42`. Warm-up 3.6 s. Before the run another client again held the same model at `context_length` 8192; the warm-up reloaded it at 16,384 as the lane requires (that client's instance was displaced).

## Result

| | |
|---|---|
| outcome (Gold v1.1) | **`FAILURE`**; X gate `NEEDS_REVIEW / repair_budget_exhausted_transient` |
| rounds / calls | 3 / 3, `finish_reason` stop x3 |
| prompt bytes | 21,945 / 24,299 / 24,896; response chars **3,002 / 4,121 / 13,363** |
| wall time per call | 47 s / 68 s / **278 s**; X total 394 s (against a 300 s per-call timeout) |
| final diff | +19 / -8 in `electron/updater.cjs` (reference +46 / -5) |
| hidden scorer v1.1 | **11/13**; failing: "development mode never reports update_ready" and "installUpdate still installs a genuinely newer build" |
| X's visible validation | failed in all 3 rounds |
| `EXPLANATION_ACTION_CONFLICT` telemetry | **none** (3 calls examined) |

## Memory under amendment 2

Post-warm-up baseline: 5 samples, all pressure 2, median **2**, free 18%, start allowed. During the task: pressure at level 2 for **141 consecutive samples** (the whole run, 194 samples), but **never above the baseline**, so no WARN and no HALT; free memory minimum 15%, **swap growth 0 MB**, Ollama peak 7.0 GB, no abort. The protocol did what it was written to do: the run that would have halted under amendment 1 completed. (As amendment 2 notes, with a level-2 baseline the pressure rule is effectively inert; protection came from swap, free memory and the ABORT lines.)

## What the model did (record)

1. **Round 1:** rewrote `inspectUpdate` to compare `builtAt`, but dropped `currentBuildId`, did not add the stated `isPackaged` handling (no development-mode guard), and removed `buildId` from `publicManifest`. Compared timestamps as strings; no fail-closed handling of a missing or invalid timestamp.
2. **Round 2:** added `isManifestNewer` using an ES `export` statement in a CommonJS file: a **syntax error**, so the test module failed to load (X's evidence contained no test names, only the load error).
3. **Round 3:** a **whole-file `replace`** (13,363 characters, 278 s) that removed the `export`. The syntax error was fixed, which shows the repair loop can work on an unambiguous error.
4. **Final logic bug:** `installUpdate` was not given the stated `currentVersion` / `currentBuiltAt` / `isPackaged` parameters. It sets `currentBuiltAt = manifest.builtAt` and `currentVersion = manifest.version`, i.e. it **compares the manifest with itself**, so no build is ever "newer" and it **refuses every install**. That breaks 7 documented install/rollback behaviors in the visible test and the hidden control "a genuinely newer build still installs".
5. This is a `contract_explicit` task: the text stated the API, and the model did not implement it as stated. Classification: **`MODEL_FAILURE` by exclusion** (heuristic); deterministic facts: context ok (13,311 bytes, `status: ok`), no `length`, all patches applied, hidden and visible agree.

## Two instrument findings (Gold v1.1 cannot be edited; both are proposals)

**A. The regression net gave 7 false "regressions" (a real defect).** The run reports `checks.regressions = 7` and `integrity_ok = false`. All 7 have the **same test names** as the tests the reference fix intentionally changed; only the error text differs (the model's "The update is not newer than the running version." versus the reference's "The selected build is not newer than the currently running version."), because for plain-script tests the net's key includes the message. Offline probe on the fixed tree with a **behaviorally equivalent fix that only changes the error message**: visible passes, hidden 13/13, net **7 regressions**. Consequences:
- This run's label `FAILURE` is **unaffected** (hidden 11/13 and X's gate fail independently); with name-only keys the regression count would be 0 and integrity ok.
- But a **correct** alternative fix for `070e9850b1` with different message text would be scored `FALSE_SUCCESS` (X gate completed, integrity false) or `REVIEW`-adjacent. The other nets are not affected (`c1d6770715` uses the spec reporter, no message in the key; `8d08bc3621` passes at both ends). Fix proposal: key plain-script failures by test name only. That is a Gold **v1.2**, needing approval; it is not applied.

**B. The hidden scorer does not cover `available.buildId` (a gap).** Removing `buildId` from `publicManifest` (what the model did): visible fails, **hidden 13/13 passes**, net 0. Only the visible test catches it. Proposal for v1.2: one control that `inspectUpdate(...).available` still carries `buildId`.

## Where the three real runs stand (all one run each, `model_quality` lane, Gold v1.1 scoring)

| task | interpretation | outcome | rounds | what happened |
|---|---|---|---|---|
| `c1d6770715` (Step 6B, re-scored) | contract_explicit | FAILURE | 3 | correct core change, over-generalized to top-level blockers, repair misread the evidence |
| `8d08bc3621` (Step 6D) | behavioral | FAILURE | 3 | never found `original-fs`; dead-code branch; same error 3x |
| `070e9850b1` (Step 6E) | contract_explicit | FAILURE | 3 | stated API not implemented; syntax error, then a self-comparison logic bug |

Observations across the three (n = 1 each, temperature 0, one seed): none succeeded within the 3-round budget; every run used all 3 rounds; `finish_reason` was never `length`; the largest response (13,363 chars) and slowest call (278 s) sit close to the 4,096-token / 300 s ceilings, which is evidence for keeping the effective 4,096 and 300 s. `EXPLANATION_ACTION_CONFLICT` occurred in 2 of the 3 runs (3 calls of 9 in total), not in this one.

## Decisions needed (nothing changed)

1. **Gold v1.2:** fix the net key (finding A) and add the `available.buildId` control (finding B). Both are additive/corrective and would change the fingerprint; A matters for any future correct `070e9850b1` patch.
2. What next: repetition to see run-to-run variation, the `production_capability` lane (8,000 B/file, 8,192 window, where every one of these files is over the per-file cap), or starting on the X scaffolding issues these runs point at. Nothing further was run.
