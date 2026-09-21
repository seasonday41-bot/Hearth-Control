# X-Eval v1 - Step 6A: Gold Set v1 Lock

**Status: LOCKED.** Lock fingerprint (sha256 of task definitions, lane config, validator variants and all hidden scorers): `9c2bf47f2b6662a7dcac5d4e85a1a0df26b153a5736e9531b8a76bc3831d9f30`. Every baseline run records this value; any edit to those files changes it and invalidates the comparison.

## Membership

| task | class | tier | validator provenance | interpretation | counts toward model quality | target file | Step-5 oracle result |
|---|---|---|---|---|---|---|---|
| c1d6770715 | **MEASURABLE** | A | historical | contract_explicit | yes | mcp/x/result-gate.mjs (13.6 KB) | SUCCESS (X gate agrees) |
| 4f261b2f4b | **STRUCTURAL_PROBE** | B | historical_derived | behavioral / structural_probe | **no** | electron/main.cjs (148 KB) | FAILURE: main.cjs truncated, patch refused |
| 8d08bc3621 | **MEASURABLE** | A | historical | behavioral | yes | electron/remote-update-stager.cjs (12.2 KB) | SUCCESS (X gate agrees) |
| 070e9850b1 | **MEASURABLE** | A | historical | contract_explicit | yes | electron/updater.cjs (12.3 KB) | SUCCESS (X gate agrees) |
| 79664a00cc | **STRUCTURAL_PROBE** | B | historical_derived | behavioral / structural_probe | **no** | electron/main.cjs (75 KB) | FAILURE: main.cjs truncated, patch refused |

- **MEASURABLE (3):** `c1d6770715`, `8d08bc3621`, `070e9850b1`.
- **STRUCTURAL_PROBE (2):** `4f261b2f4b`, `79664a00cc`. A perfect (oracle) model still fails: `electron/main.cjs` exceeds X's 20,000-byte per-file cap, so X cannot patch it. They are kept as deterministic "X v0.1 cannot" probes and are **excluded from model-quality scoring**. They are evidence about X's scaffolding, not about Qwen. Candidates for the first X v0.2 work: **large-file edit capability** and **`PRECONDITION_FAILED` classification** (X spends 3 rounds on a permanent failure and reports it as `transient`).
- **HOLD, not runnable:** `c7cbaa326f`, `9aa1446303` (`c7cbaa326f` bundled + executor model-facing path; `9aa1446303` no historical validator, eval-authored tests would be synthetic).
- **Interpretation labels.** `contract_explicit` (`c1d6770715`, `070e9850b1`): the task states the constant/API, so it measures whether X **implements a clear contract**, not whether it can invent one. `behavioral`: the task states a behavior only.
- Task text: eval-authored drafts, **read and accepted** by the project owner for Step 6. Validators: Step 4 variants (visible = historical or historical-derived; hidden scorer outside the workspace).

## Lanes (locked)

| lane | purpose | as written in the lock | what actually reaches X / Ollama |
|---|---|---|---|
| **production_capability** | measure frozen X v0.1 as it really behaves (defined; **not run in 6B**) | `maxBytesPerFile=8000`, `num_ctx=8192`, `num_predict=1024` | `maxBytesPerFile=8000`, `num_ctx=8192`, **`num_predict=4096`** |
| **model_quality** (run in 6B) | separate Qwen quality from the small ceilings | `maxBytesPerFile=20000`, `num_ctx=16384`, `num_predict=1024` | `maxBytesPerFile=20000`, `num_ctx=16384`, **`num_predict=4096`** |

Eval overrides recorded on every run: production_capability: `temperature` = 0 (production: unset (provider/model default); determinism control)<br>`seed` = 42 (production: unset; determinism control). model_quality: `maxBytesPerFile` = 20000 (production: 8000; **eval override**)<br>`num_ctx` = 16384 (production: 8192; **eval override**)<br>`temperature` = 0 (production: unset (provider/model default); determinism control)<br>`seed` = 42 (production: unset; determinism control).

### Discrepancy found while locking: `num_predict`

The lock says 1024. In the production path the executor's own request carries `num_predict: 4096, longResponse: true`, and the provider then forces `num_predict = max(value, 4096)` (and a 300 s timeout instead of 90 s). Passing `modelOptions.num_predict = 1024` therefore has **no effect**; the effective output cap is **4,096** in both lanes. I kept the production-faithful behavior (no `longResponse` override), which does not *increase* output relative to production, and records `effective_num_predict` per model call. Getting a literal 1,024 would need an extra eval override (`longResponse: false`) that also shortens the timeout, and it would make `finish_reason=length` more likely for the 46-line updater patch. **That is a decision for the project owner; nothing was changed to chase it.**

Also not overridden: model `qwen3.5:9b-hermes`, profile `normal`, `think=false` (all production defaults).

## Run protocol (Step 6B)

- Lane `model_quality`, MEASURABLE tasks only, **1 run per task**, order `c1d6770715` -> `8d08bc3621` -> `070e9850b1`, `temperature=0`, `seed=42`.
- Executor = current frozen X v0.1 from the main checkout (identity recorded); target = snapshot; hidden scorer outside; preflight must fail at baseline.
- One unscored warm-up call loads the model with the lane's `num_ctx`; `/api/ps` `context_length` is recorded to confirm the window Ollama actually loaded.
- Ollama runs on this machine; the runner never pulls a model.

## Stop rules (fixed before the run)

After **any** task the baseline **HALTS**: no next task, no rerun, no config change. Analysis first. A clean wrong answer (`FAILURE`, `FALSE_SUCCESS`) is a **result**, not a stop.

| stop reason | condition |
|---|---|
| output cap | any model call with `finish_reason = length` |
| model unavailable | any model call with `ok = false` (e.g. `TIMEOUT`, `UNAVAILABLE`), or outcome `MODEL_UNAVAILABLE` |
| harness | outcome `HARNESS_ERROR` (incl. failed preflight, X threw) or `STOPPED_BY_GUARD` |
| memory (abort now) | `kern.memorystatus_vm_pressure_level >= 4`, or swap growth >= 2048 MB from the start of the task, or free memory < 5% |
| memory (flag, halt after the task) | pressure level >= 2 for 3 consecutive samples, or swap growth >= 512 MB, or free memory < 15% |

Sampled every 2 s; swap is judged by **growth**, because ~3.8 GB was already in use before any run. Guard logic and stop rules are self-tested before every real run (12 checks), and the abort path is exercised end to end in the runner smoke (check B11).

## Verified before the lock

- Runner smoke with stubs: 43/43 (17 runs); the earlier 42-check version was run twice with identical results.
- Dry run of the baseline script with the oracle stub (no Ollama): 3/3 SUCCESS, memory sampler and results file working.
- Production path facts re-checked in source: no `contextOptions` passed (default 8,000 B/file); default adapter profile `normal` (`num_ctx` 8,192); `longResponse` behavior above.

## Not locked / open

Rounds beyond 1 run per task; repetition and the production_capability lane; the oracle-context control run (only when a context failure is suspected); cause tagging beyond outcome layer A.
