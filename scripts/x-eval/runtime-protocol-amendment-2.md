# X-Eval runtime protocol amendment 2 (baseline-relative memory pressure)

**Status: in force for real-model runs from Step 6E.** Supersedes only the **pressure rule** of `runtime-protocol-amendment-1.md`. Gold v1.1 is untouched: fingerprint `a472f193ea1e788af8cc16d1cad1facaf9018acf18c6f491f7afc7a7f22f1d12` was checked before and after this change and is asserted by `baseline.mjs` at start. No scorer, net, outcome rule, lane, `lanes.mjs`, `host-sampler.mjs`, `run-task.mjs` or `mcp/x/*` was edited. New files only: `runner/runtime-protocol-2.mjs`, `runner/telemetry.mjs`, plus changes to `baseline.mjs` (not a fingerprint input).

## Why

Amendment 1 could not complete a sequence on this machine: with the model resident it settles at pressure level 2 (Step 6D: 31 consecutive samples at level 2, swap +21 MB, free never below 16%, latency unchanged). Level 2 is the machine's steady state with the model loaded, so an absolute level is a poor discriminator. Amendment 2 measures that steady state and reacts to a rise above it.

## Rules

| | rule |
|---|---|
| **Baseline** | after warm-up (model resident), take **5 samples** 2 s apart; baseline pressure = their **median** |
| **Start gate** | baseline pressure **>= 3** -> **do not start any task** (`NOT STARTED`, results file written) |
| **WARN** | pressure **> baseline** for **3** consecutive samples: recorded in `warnings`, never stops anything |
| **HALT** (after the current task; no next task, no rerun, no config change) | pressure **>= baseline + 1** for **15** consecutive samples (~30 s), **or** swap growth **>= 512 MB**, **or** free memory **< 10%** for **3** consecutive samples |
| **ABORT** (immediately, `STOPPED_BY_GUARD`) | **unchanged**: pressure level >= 4, swap growth >= 2,048 MB, free < 5% |

Swap growth is measured from the start of each task. Other stop rules (`finish_reason=length`, model call failed, harness error, outcome `REVIEW`) and `num_predict` 4,096 / `longResponse` true / 300 s timeout are unchanged.

## Interpretations I had to choose (please veto)

1. **Baseline statistic = median** of the 5 samples (the instruction did not name one).
2. **Extra start refusal:** if any baseline sample already meets an ABORT threshold, the start is also refused (a run that would abort on its first sample is not started). This is not in the instruction.
3. **What "pressure >= 3" means.** macOS reports the level as 1 (normal), 2 (warn) or 4 (critical); on this machine I have only observed 1 and 2 (the 4 is my understanding of macOS, not verified here). Consequence, stated plainly: **if the baseline is 2, "pressure >= baseline+1" means >= 3, i.e. in practice level 4, which ABORTs on the first sample anyway.** So with a level-2 baseline the pressure rule is effectively inert; protection then comes from swap growth, free memory and the ABORT thresholds. That is the intended relaxation, but it is worth knowing.
4. HALT keeps the amendment-1 semantics (stop after the current task); ABORT keeps the immediate abort.

## Telemetry: EXPLANATION_ACTION_CONFLICT (never used for outcome)

`runner/telemetry.mjs` records, per model call, when the free-text `explanation` says no edit is needed while the same response contains one or more actions. `actions.length > 0` is deterministic; the "says no edit" part is a phrase match (heuristic). It is computed **after** the run by `baseline.mjs`, written to `telemetry.json` and the results file, and is **not** passed to the outcome, the scorer or the stop rules (a self-test asserts `used_for_outcome = false`). Validated offline on the two stored real runs: it flags exactly `c1d6770715` call 3 and `8d08bc3621` calls 1 and 3, and nothing else.

## Verified before use (no model, no Ollama)

24 self-tests passed before every run, including: baseline median; a steady level-2 machine gets baseline 2 and may start; baseline 4 refuses to start; one ABORT-level baseline sample refuses; baseline 1: WARN at 3, no HALT at 14, HALT at 15; **baseline 2: 40 samples at level 2 produce no warn and no halt**; level 4 aborts; swap +400 MB no halt, +512 MB HALT; free <10% x2 no halt, x3 HALT; the ABORT thresholds; WARN alone does not stop the sequence; telemetry semantics. A full dry run with the oracle stub passed.
