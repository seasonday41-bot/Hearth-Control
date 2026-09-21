# X-Eval v1.1 - Step 6D: Qwen baseline, tasks 2-3 (HALTED after 1 of 2)

**Status: HALTED by the amended memory protocol after `8d08bc3621`. `070e9850b1` was NOT run.** `c1d6770715` was not rerun (its Step-6B result stands, re-scored `FAILURE` under v1.1). Gold v1.1 fingerprint on the run = `a472f193ea1e788a...` (approved value; asserted at start). `mcp/x` untouched, nothing committed, no config or threshold changed after the run started. One run on one task: an observation, not a rate.

Files: `baseline-qwen-v1.1-results.json`, `baseline-artifacts/8d08bc3621-qwen-s0/` (`run-record.json` with every prompt and response, `final.patch`), `runtime-protocol-amendment-1.md`.

## What ran

`qwen3.5:9b-hermes` (Ollama 0.33.2), lane `model_quality`: `maxBytesPerFile=20000`, `num_ctx=16384` (Ollama reported `context_length=16384` after warm-up), effective `num_predict=4096`, `longResponse` true, 300 s timeout, `temperature=0`, `seed=42`. Warm-up 3.7 s, not scored. Runtime protocol: amendment 1.

## Result of `8d08bc3621`

| | |
|---|---|
| outcome (Gold v1.1) | **`FAILURE`**, `integrity_ok = true`; X gate `NEEDS_REVIEW / repair_budget_exhausted_transient` |
| rounds / calls | 3 / 3, `finish_reason` = stop, stop, stop (no `length`) |
| prompt bytes | 22,960 / 25,557 / 26,129; response chars 1,960 / 2,621 / 2,349 |
| wall time per call | 37.5 s / 48.4 s / 51.3 s; X total 138.6 s |
| final diff | +22 / -6 in `electron/remote-update-stager.cjs` (reference fix +12 / -5) |
| hidden scorer v1.1 | **4/7**: the 3 target checks fail (copy of `.asar` archives; `stageVerifiedUpdate` under Electron; failed-staging cleanup under Electron), the 4 unchanged-behavior controls pass |
| regression net | 2 files run, **0 regressions**; no out-of-scope edit, no tampering |
| X's visible validation | failed in all 3 rounds, on the same 2 tests, with the same error (`Invalid package ... app.asar`) |

This is a **genuine failure, not an instrument artifact**: the visible test, the hidden scorer and X's own gate all agree, and the regression net is clean.

## Why it failed (what the record shows)

- **Context was adequate.** The target file was loaded whole (`status: ok`, 13,616 bytes). No output limit, every patch applied cleanly. So this is not a context, tool or output-budget failure.
- **The missing idea is `original-fs`.** The fix is to copy through Electron's `original-fs` so `.asar` stays an opaque file. The string `original-fs` appears in **no** model response in any round, and is not in the loaded file. The model never identified that Electron's patched `fs` was the cause. (Step 4 had flagged this task as needing Electron domain knowledge.)
- **The repair loop made no progress.** Round 2 tried `copyFile` when a path "ends with `.asar`", but the function is called with the app **directory**, so the branch never runs: dead code. Round 3 kept that branch. The same two tests failed with the same error three times.
- **Rounds 1 and 3 say no change is needed while the response contains a patch.** Round 1's explanation: "no actual change is needed"; its patch rewrote the docstring. Round 3: "no file modification can resolve an external ..." with a patch that re-adds the dead branch. Together with `c1d6770715` round 3, this is now **2 of 2 runs** where the free-text explanation disagrees with the emitted action. The explanation is unverified prose and should not be used as evidence. (Cause not established; 2 runs.)
- Classification: **`MODEL_FAILURE` by exclusion** (heuristic), with the deterministic facts above (context ok, no `length`, valid patches, hidden and visible agree). Interpretation label `behavioral`.

## Why it halted (memory)

Rule that fired: **HALT, pressure level >= 2 for 15 consecutive samples.** ABORT thresholds were not reached.

| | Step 6B (`c1d6770715`) | Step 6D (`8d08bc3621`) |
|---|---|---|
| model resident before the task | no (loaded by warm-up) | no (loaded by warm-up) |
| pressure level at the first sample | 2 | 2 |
| longest run at level >= 2 | 4 samples (~8 s), then level 1 | **31 samples (~62 s of 70)**, never recovered |
| min free memory | 16% | 16% |
| swap growth during the task | +28 MB | +21 MB |
| Ollama resident memory (peak) | 6.9 GB | 7.0 GB |
| end of task | level 1, free 22% | level 2, free 18% |
| per-call latency | 33-52 s | 37-51 s |

- **Before the model was loaded the machine read level 1 with 71% free.** After warm-up it read level 2 with 16-19% free, and it stayed there. When another client had the same model resident and idle (Step 6D pre-check), the machine also read level 2, free 19%. So on this 16 GB machine **model residency alone puts it at level 2**; the level is a steady state here, not a transient.
- **Nothing else indicates distress:** swap growth +21 MB against a 512 MB HALT line, free never below 16% against a 10% line, latency the same as the earlier run, no timeout, no model error. Swap was already ~7.7-8.0 GB used before the task began (3.8 GB in Step 6B).
- Consequence: with the model loaded and this set of apps open, **HALT at 15 samples will fire on essentially every run**, so the protocol as amended cannot complete a multi-task sequence on this machine. That is a property of the machine and the threshold, not an anomaly in the run. I did not treat it as one and did not change it.
- Pre-run note: another client held the same model in Ollama (`context_length` 8192, idle, 6 GB) at 11:08; I waited for its keep-alive to expire (11:15) rather than stop it. Details in `runtime-protocol-amendment-1.md`.

## Decisions needed (nothing was changed)

1. **Memory HALT rule.** Options, none applied: (a) keep it and free memory first (close other apps) so the machine sits at level 1 with the model resident; (b) make level 2 a WARN when Ollama is resident and HALT only on a **rise above the steady level measured after warm-up**, or on the swap / free-memory lines; (c) accept that sequences stop after one task and run tasks in separate sessions. Any change is a new protocol amendment, not a Gold change.
2. **`070e9850b1`** has not been run. It is unaffected by anything above.
3. Whether the explanation-versus-action mismatch (2 of 2 runs) is worth its own look before more runs.
