# X-Eval v1 - Gold Set v1.2 (lock amendment, offline)

**Status: LOCKED as v1.2. Offline only: no Ollama call, no change to `mcp/x/*`.** Amends `gold-set-v1.1.md` (approved) exactly as approved: (1) regression-net key = test name only, message kept as metadata; (2) hidden control `available.buildId`. Everything else is unchanged.

| version | fingerprint (sha256) |
|---|---|
| **Gold v1.2 (current)** | `f6ac8bfae42af5c5417e2da485f1b61f94c3e3ed6bb72cf5f3f8b142a9bdc03f` |
| Gold v1.1 | `a472f193ea1e788af8cc16d1cad1facaf9018acf18c6f491f7afc7a7f22f1d12` |
| Gold v1 (Step 6A, narrower input set) | `9c2bf47f2b6662a7dcac5d4e85a1a0df26b153a5736e9531b8a76bc3831d9f30` |

Stable across calls; unchanged by editing `baseline.mjs` (not a fingerprint input). 18 inputs (same set as v1.1 with the net file renamed to `regression-nets-v1.2.json`).

## What changed

| component | v1.1 | v1.2 | why |
|---|---|---|---|
| regression-net key | test name **plus** error message for plain-script tests | **test name only**; message kept as metadata (`allowed_failure_messages`, `regression_details`), never compared | a correct fix worded its error differently and got 7 false regressions (Step 6E) |
| net data | `regression-nets-v1.1.json` | `regression-nets-v1.2.json`, rebuilt offline; allowed names **identical** to v1.1 once messages are stripped (all 5 files) | (v1.1 file archived in `tasks/archive-v1.1/`) |
| name extraction | regex on the failure line | splits "name: message" using the names **declared in the test source**, falling back to the first ": " | a test name may itself contain ": " |
| hidden scorer `070e9850b1` | 13 checks | **14** (+1: an offered update still reports `version`, `buildId`, `builtAt` in `available`) | the Qwen patch dropped `buildId`; only the visible test caught it |
| audit mutants | 19 | **21** (+2: `buildId` dropped; equivalent fix with a different error message) | prove both fixes |
| scorers `c1d6770715`, `8d08bc3621`; tasks; lanes; scoring, outcome and stop logic | | unchanged | |

## Evidence (all offline)

| check | result |
|---|---|
| every scorer: parent fails / fixed passes, 2 runs, stable | yes (7 scorers). Measurable: c1d6770715 parent failed 7/28 / fixed passed 28/28; 8d08bc3621 failed 4/7 / passed 7/7; 070e9850b1 failed 8/14 / passed 14/14 |
| audit mutants (v1.2 set) | hidden fails **17/17** wrong mutants; hidden **and** net pass **4/4** correct-but-different ones; gaps: 0 |
| the two new mutants | `public-manifest-drops-buildId`: hidden **fail** (v1.1 passed it). `equivalent-fix-with-different-error-message`: visible pass, hidden 14/14, net **pass** (v1.1: 7 false regressions) |
| original 10-mutant probe | 8/10 as expected; the 2 mismatches are the known over-constrained *visible source-text* tests (`4f261b2f4b`, `79664a00cc`), unchanged |
| runner smoke with stubs (2 new checks: G5 key extraction, G6 scorer sizes) | **49/49**, 18 runs; oracle replays 3/3 `SUCCESS` at hidden 28/28, 7/7, 14/14 |
| baseline pipeline dry run, stub oracle, protocol 2, no Ollama | 3/3 `SUCCESS`, not halted; 24 guard/stop self-tests pass |
| `mcp/x`, repo | untouched, clean; nothing committed |

## Re-score of the three real-model artifacts (same code path as a live run; no model call)

| task | outcome as recorded | archived v1 scorer | v1.2 hidden | net regressions (recorded -> v1.2) | **outcome under Gold v1.2** |
|---|---|---|---|---|---|
| c1d6770715 | SUCCESS (gate_agrees=false), integrity_ok=n/a | passed 25/25 | failed 26/28 | n/a (Gold v1 run) -> **2** | **FAILURE**, integrity_ok=false |
| 8d08bc3621 | FAILURE, integrity_ok=true | failed 1/3 | failed 4/7 | 0 -> **0** | **FAILURE**, integrity_ok=true |
| 070e9850b1 | FAILURE, integrity_ok=false | failed 7/9 | failed 11/14 | 7 -> **0** | **FAILURE**, integrity_ok=true |

- **Labels do not change for any of the three: all remain `FAILURE`.** The only change is a corrected integrity flag: `070e9850b1` goes from 7 false regressions to 0 (`integrity_ok` false -> true) and its hidden result goes from 11/13 to 11/14: one more check, which the model patch also fails (it dropped `buildId`), so 3 checks fail instead of 2. `c1d6770715` keeps its 2 genuine regressions; `8d08bc3621` is unchanged.
- The Step-6B / 6D / 6E result files and artifacts are kept exactly as recorded (they carry the fingerprint of the version they ran under).

## Not changed (still as before)

Lanes and the effective `num_predict` 4,096 / `longResponse` / 300 s; task definitions and text; MEASURABLE / STRUCTURAL_PROBE / HOLD classification; runtime protocol amendments 1 and 2 (memory); the outcome rule and stop rules; `production_capability` lane (never run). No new real-model run was made.

## Limits

- Name-only matching still has two soft spots: if a declared name is not found the key falls back to the text before the first ": ", and two tests sharing a name would collide. Neither occurs in the three nets.
- The `available.buildId` control and the two mutants were added **after** seeing the failure, so they show that hole is closed, not that none remain. A real model found this one; more may exist.
- The nets remain weak for `8d08bc3621` (two loosely related tests) and `070e9850b1` (essentially the visible test's parent version).

## Next

Stopped here as instructed, before X v0.2. Nothing else was started.
