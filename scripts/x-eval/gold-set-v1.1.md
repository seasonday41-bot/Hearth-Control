# X-Eval v1 - Gold Set v1.1 (lock amendment, offline)

**Status: LOCKED as v1.1.** Amends `gold-set-v1.md`; everything not listed below is unchanged.

| | fingerprint (sha256) |
|---|---|
| **Gold v1.1 (current)** | `a472f193ea1e788af8cc16d1cad1facaf9018acf18c6f491f7afc7a7f22f1d12` |
| Gold v1 (Step 6A, narrower input set) | `9c2bf47f2b6662a7dcac5d4e85a1a0df26b153a5736e9531b8a76bc3831d9f30` |

The v1.1 fingerprint covers 18 files: task definitions, the regression-net data, validator variants and mutants (`candidates.mjs`), **all 7 scorers**, lanes and memory guard, and the scoring / stop logic (`score.mjs`, `regression-net.mjs`, `stop-rules.mjs`, `host-sampler.mjs`, `run-task.mjs`, `lib.mjs`). v1 hashed only tasks, lanes, candidates and scorers, so a change to the outcome rule would not have been detected. Any edit to any of them changes the hash.

## What changed, and why

| component | Gold v1 | Gold v1.1 | evidence |
|---|---|---|---|
| hidden scorer `c1d6770715` | 25 checks | **28** (+3 top-level blocker controls) | Qwen patch passed v1 while breaking 2 documented behaviors |
| hidden scorer `070e9850b1` | 9 | **13** (+4) | audit: 3 wrong mutants slipped through, 1 past every layer |
| hidden scorer `8d08bc3621` | 3 | **7** (+4) | audit: 5 wrong mutants slipped through, 1 past every layer |
| regression net | none | **new**: parent tests, name-level, allowed failures precomputed | catches the Qwen patch on its own (2 regressions); no false positive on the 3 oracle replays |
| outcome rule | `SUCCESS` = hidden passes and integrity ok | **`SUCCESS` only if X's gate also completed; otherwise `REVIEW`**; regressions count as an integrity failure | `gate_agrees=false` was a footnote and hid the false positive |
| stop rules | Step 6A list | **+ outcome `REVIEW` halts** for analysis | instrument and X disagree: a human must look before the next task |
| fingerprint | 4 groups | 18 files (above) | see above |

Original scorers are preserved in `qualification/scorers-v1-archive/`. Audit, mutant matrix and re-score: `scorer-audit-v1.1.md`.

## Result of the re-score (no model rerun)

The Step-6B run of `c1d6770715` is **`FAILURE` under Gold v1.1** (was `SUCCESS` with `gate_agrees=false`): hidden v1.1 fails 2/28 and the regression net reports 2 regressions. The Step-6B result file itself is kept as recorded (fingerprint v1); it is not edited.

## Explicitly NOT changed (still open, still as in `gold-set-v1.md`)

- **Memory guard thresholds.** Unchanged. The Step-6B halt (pressure level 2 for 3+ samples) can recur on this machine with the model resident; that decision is still open.
- **`num_predict`.** Unchanged: the executor forces an effective 4,096; the literal 1,024 in the lock is not reachable without a `longResponse: false` override.
- **Lanes, task definitions and text, MEASURABLE / STRUCTURAL_PROBE / HOLD classification, production_capability lane (still not run).**
- `8d08bc3621` and `070e9850b1` have **not** been run with a real model. Only the Step-6B `c1d6770715` run exists.

## Verification (all offline)

| check | result |
|---|---|
| runner smoke with stubs (incl. 4 new v1.1 checks G1-G4) | **47/47** (18 runs) |
| every scorer: parent fails / fixed passes, 2 runs, stable | yes (7 scorers) |
| scorer audit: wrong mutants caught by hidden | 16/16; correct-but-different accepted 3/3 |
| oracle replays under v1.1 (net on) | 3/3 `SUCCESS` with the X gate agreeing |
| baseline pipeline dry run with the oracle stub (no Ollama) | 3/3 `SUCCESS`, not halted, 13 guard self-tests pass |
| `mcp/x` / repo | clean; nothing committed |

## Needed before the two remaining real-model runs

1. **Approve Gold v1.1** as above (scorer amendments, regression net, `REVIEW` rule and halt).
2. **Memory guard:** keep and free memory first, or relax the flag (this changes the fingerprint).
3. **`num_predict`:** keep the effective 4,096 or override.
4. Then run `8d08bc3621` and `070e9850b1` (1 run each, same protocol). Nothing was started.
