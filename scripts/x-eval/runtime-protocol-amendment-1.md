# X-Eval runtime protocol amendment 1 (memory handling)

**Status: in force for real-model runs from Step 6D.** Separate from Gold v1.1: the Gold fingerprint is **unchanged** (`a472f193ea1e788af8cc16d1cad1facaf9018acf18c6f491f7afc7a7f22f1d12`, checked before and after this change, and asserted by `baseline.mjs` at start). Nothing in `gold-set-v1.1.md`, the scorers, the nets, the outcome rule, `lanes.mjs` or `host-sampler.mjs` was edited. `mcp/x/*` untouched.

## Why it is separate

`MEMORY_GUARD` lives in `lanes.mjs` and the sampler in `host-sampler.mjs`, both inputs of the Gold fingerprint. To leave the approved fingerprint intact, the amendment is a new module, `runner/runtime-protocol.mjs`, that `baseline.mjs` uses instead of the Gold sampler. It reuses `host-sampler.sampleOnce` unchanged and reports through the summary field names the frozen `stop-rules.mjs` already understands (`flags` = HALT conditions, `aborted` = ABORT). Every run record carries `runtime_protocol` (this amendment) and `gold_v1_1_memory_guard_superseded` (the old values).

## Thresholds (sampled every 2 s; swap growth is measured from the start of each task)

| level | Gold v1.1 (superseded) | **Amendment 1** | effect |
|---|---|---|---|
| **WARN** | (none) | pressure level >= 2 for **3** consecutive samples | recorded only; never stops anything |
| **HALT** | flag: pressure >= 2 x3, or swap growth >= 512 MB, or free < 15% | pressure level >= 2 for **15** consecutive samples (~30 s), **or** swap growth >= **512 MB**, **or** free memory < **10%** for **3** consecutive samples | the current task finishes, then the sequence stops: no next task, no rerun, no config change |
| **ABORT** | pressure level >= 4, or swap growth >= 2,048 MB, or free < 5% | **unchanged** | the current run is aborted immediately (`STOPPED_BY_GUARD`) |

Interpretation stated explicitly: HALT keeps the old "flag" semantics (stop after the current task); ABORT keeps the old immediate-abort semantics. The other stop rules (`finish_reason=length`, model call failed / unavailable, harness error, outcome `REVIEW`) are unchanged. `num_predict` 4,096, `longResponse` true and the 300 s timeout are unchanged.

## Verified before use (no model, no Ollama)

19 guard and stop-rule self-tests run before every real run and passed, including the boundaries: pressure >= 2 x3 = WARN only; x14 then recovery = no halt; x15 = HALT; swap +400 MB = no halt, +512 MB = HALT; free < 10% x2 = no halt, x3 = HALT; the three ABORT thresholds; WARN alone does not stop the sequence. A dry run of the whole baseline pipeline with the oracle stub passed for both tasks.

## Pre-run environment note (Step 6D)

Before the run another client held `qwen3.5:9b-hermes` in Ollama (`context_length` 8192, 6 GB resident, idle, started ~20 min earlier, not by this harness, which uses 16,384). The machine was at pressure level 2 with 19% free. I did not stop it or change any threshold; I waited for its keep-alive to expire (11:15), after which the machine read pressure level 1 and 70% free. Swap was already ~7.7 GB used of 8 GB before the run (it had been 3.8 GB in Step 6B), which is why swap is judged by **growth**, not level.
