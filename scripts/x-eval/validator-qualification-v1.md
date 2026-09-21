# X-Eval v1 - Step 4: Validator Qualification

**Status: complete for the 7 candidates (4 INCLUDE + 3 HOLD from Step 2).** No X run, no Ollama, no change to `mcp/x/*`, no checkout/reset of the main working tree.

## Method

- **Isolated snapshots.** Each state is `git archive <rev>` into a temp dir (`node_modules` symlinked from the main checkout: current versions, macOS arm64, Node v24.19.0). Nothing in the main tree was checked out or modified; `git status` shows only untracked `scripts/x-eval/`.
- **Three states per candidate.** `parent`; `parent + the fix commit's test files` (the fix's new/changed assertions are what must fail before the fix); `fixed`.
- **Visible validator = run through X's own frozen `runRequiredValidation`** (imported, no model): real command allowlist, `--test-isolation=none`, reduced env, 90 s timeout. So "accepted" means the frozen runner accepted it.
- **Hidden scorer = eval-authored script under `scripts/x-eval/qualification/scorers/`**, run as `node scorer.mjs --root <snapshot>`. It is outside every snapshot, is never in a `task.validation`, and would never be in a prompt. Each check is tagged `api` (missing export/function) or `behavior`, so shallow discrimination is visible.
- **Each phase run 2 times**; results identical (no flaky phase).
- **Qualification rule.** A validator discriminates only if `parent = FAIL` and `fixed = PASS`. A candidate is QUALIFIED only if both the visible validator and the hidden scorer discriminate, in a form X's runner accepts. BLOCKED would mean an environment problem; none occurred.
- Reproduce: `node scripts/x-eval/qualify-validators.mjs --work-dir <dir> --runs 2 --mutants` (raw data: `scripts/x-eval/qualification-results-v1.json`).

## Result

| candidate | verdict | visible validator to give X | parent's own test (env sanity) | visible: parent+fix tests -> fixed | hidden scorer: parent -> fixed |
|---|---|---|---|---|---|
| c1d6770715 | **QUALIFIED** | visible:test | passed | failed -> passed (behavioral) | failed -> passed (21/25 checks fail at parent; behavioral) |
| 4f261b2f4b | **QUALIFIED** | visible:behavioral (eval-derived) | passed | failed -> passed (behavioral) | failed -> passed (5/8 checks fail at parent; behavioral) |
| 8d08bc3621 | **QUALIFIED** | visible:test | n/a (new test) | failed -> passed (behavioral) | failed -> passed (2/3 checks fail at parent; behavioral) |
| 070e9850b1 | **QUALIFIED** | visible:test (`node --test scripts/test-updater.mjs`) | passed | failed -> passed (behavioral) | failed -> passed (5/9 checks fail at parent; behavioral) |
| 79664a00cc | **QUALIFIED** | visible:behavioral (eval-derived: WL-S1..S3 removed) | n/a (new test) | failed -> passed (behavioral) | failed -> passed (3/7 checks fail at parent; behavioral) |
| c7cbaa326f | **HOLD** | none as-is | passed | failed -> passed (API absent only) | failed -> passed (3/7 checks fail at parent; behavioral) |
| 9aa1446303 | **HOLD** | none (no historical visible validator) | passed | passed -> passed (NO discrimination) | failed -> passed (1/5 checks fail at parent; behavioral) |

**QUALIFIED 5 / HOLD 2 / REJECT 0 / BLOCKED 0.** Conditions per candidate:

- **c1d6770715 (QUALIFIED).** Task text must state the new constant `structural_execution_failure` (X cannot infer a name). Hidden and visible encode the same decision, so independence is moderate.
- **4f261b2f4b (QUALIFIED).** Give X the derived behavioral variant, not the original text test (it rejects a correct alternative fix). Score with the hidden scorer. **Correction (Step 5):** the validators qualify, but frozen X v0.1 cannot edit `electron/main.cjs` at all (148,260 bytes, over its 20,000-byte per-file cap), so this task is infeasible for X v0.1 regardless of model (see `runner-smoke-v1.md`). An earlier version of this line called it a retrieval difficulty.
- **8d08bc3621 (QUALIFIED).** Needs the Electron binary + `@electron/asar` (present here as Electron 44.3.0 from the main `node_modules`, not the historical "latest"). The visible test asserts Electron's own error text (`Invalid package ... app.asar`) as a precondition, so an Electron upgrade can break it at the fixed tree.
- **070e9850b1 (QUALIFIED).** Scope the task to `electron/updater.cjs`: the `main.cjs` plumbing is covered by neither validator. Task text must name the API (`isManifestNewer`, and `currentBuiltAt` / `isPackaged` on `inspectUpdate` / `installUpdate`).
- **79664a00cc (QUALIFIED).** Give X the derived variant; the original (`full`) rejects a correct alternative. Both validators extract `createWindow` / `second-instance` from `main.cjs` by string marker, so a fix that restructures those declarations would be mis-scored. **Correction (Step 5):** frozen X v0.1 also cannot edit `electron/main.cjs` (75,328 bytes, over its 20,000-byte per-file cap), so this task is infeasible for X v0.1 regardless of model.
- **c7cbaa326f (HOLD).** Bundle of 3 changes; the visible files fail at the parent only because imports are missing (API-absent). The hidden scorer proves one slice (tail truncation) is behaviorally discriminating. Promote only as a split task with a derived visible test; leakage stays HIGH (executor repair-feedback path).
- **9aa1446303 (HOLD).** The commit ships no test and the 6 existing-related tests pass at the parent, so no historical validator discriminates. The authored probe does. To promote: author a separate visible `scripts/test-*.mjs` and decide whether authored validators are allowed in Gold.

## Visible validators (every variant tried)

| candidate | variant | command | parent's own | parent + fix tests | failing tests at parent | fails by missing API only? | fixed | duration | note |
|---|---|---|---|---|---|---|---|---|---|
| c1d6770715 | test | `node --test scripts/test-x-result-gate.mjs` | passed | failed | 10 | no | passed | 30 ms |  |
| 4f261b2f4b | test | `node --test scripts/test-updater-runtime-preflight.mjs` | passed | failed | 1 | no | passed | 31 ms | test-build-metadata.mjs deliberately excluded (asserts a generated build ID); test 6 is a source-text assertion |
| 4f261b2f4b | behavioral | `node --test scripts/test-updater-runtime-preflight.mjs` | n/a | failed | 1 | no | passed | 32 ms | eval-derived: test 6 (source-text) replaced by a test that EXECUTES the helper |
| 8d08bc3621 | test | `node --test scripts/test-remote-stager-electron-asar.mjs` | n/a | failed | 2 | no | passed | 190 ms |  |
| 070e9850b1 | test | `node --test scripts/test-updater.mjs` | passed | failed | 6 | no | passed | 147 ms | plain-script test (not node:test); run under the frozen runner's --test-isolation=none |
| 79664a00cc | full | `node --test scripts/test-electron-window-lifecycle.mjs` | n/a | failed | 7 | no | passed | 30 ms |  |
| 79664a00cc | behavioral | `node --test scripts/test-electron-window-lifecycle.mjs` | n/a | failed | 4 | no | passed | 29 ms | eval-derived: WL-S1..S3 (literal-source regexes) removed |
| c7cbaa326f | test | `node --test scripts/test-x-repair-loop.mjs scripts/test-x-local-exe...` | passed | failed | 2 | yes | passed | 3185 ms |  |
| 9aa1446303 | existing-related | `node --test scripts/test-goal-autopilot.mjs scripts/test-goal-conte...` | passed | passed | 0 | no | passed | 220 ms | no test changed in the commit; these are the miner's existing_related tests |

- **Allowlist check is real.** The same runner returns `invalid_command` for `node scripts/test-updater.mjs`, `npm run test:updater`, any path outside `scripts/test-*.mjs`, and any `&&` chain, and accepts `node --test scripts/test-updater.mjs`. So the Step-3 worry about `070e9850b1` is resolved: under the frozen runner (`--test-isolation=none`) that plain-script test fails at the parent on 6 named behavioral tests and passes at the fixed tree.
- `c7cbaa326f` discriminates only because `import { truncateTailText }` / `isRepairTask` do not exist at the parent (whole modules fail to load). That is shallow: X would need the export names in the task text.
- `9aa1446303`: the existing-related tests **pass at the parent**, so they carry no signal.

## Hidden scorers

| candidate | scorer | at parent | at fixed | stable |
|---|---|---|---|---|
| c1d6770715 | `c1d6770715.mjs` | 4/25 pass, 21 fail (all behavioral) | 25/25 pass | yes |
| 4f261b2f4b | `4f261b2f4b.mjs` | 3/8 pass, 5 fail (all behavioral) | 8/8 pass | yes |
| 8d08bc3621 | `8d08bc3621.mjs` | 1/3 pass, 2 fail (all behavioral) | 3/3 pass | yes |
| 070e9850b1 | `070e9850b1.mjs` | 4/9 pass, 5 fail (all behavioral) | 9/9 pass | yes |
| 79664a00cc | `79664a00cc.mjs` | 4/7 pass, 3 fail (all behavioral) | 7/7 pass | yes |
| c7cbaa326f | `c7cbaa326f.mjs` | 4/7 pass, 3 fail (all behavioral) | 7/7 pass | yes |
| 9aa1446303 | `9aa1446303.mjs` | 4/5 pass, 1 fail (all behavioral) | 5/5 pass | yes |

Every parent failure is behavioral, every scorer also carries **control checks that pass at the parent** (behavior the fix must not break), and none crashed. Independence is by design, not by author: each scorer uses a different fixture and/or entry point from the visible test (e.g. `buildXResult` instead of only the gate; `inspectUpdate` / `installUpdate` instead of `isManifestNewer`; a different asar fixture and `copyAppBundle` directly; an executing harness instead of source regexes).

## Sensitivity probe (extra, small)

Ten hand-made variants of the fixed tree, to check the validators are neither too loose nor too strict. "Expected" is what an ideal validator would do.

| candidate | variant | kind | actual | expected | verdict |
|---|---|---|---|---|---|
| c1d6770715 | wrong-constant-name | plausible but wrong | visible:test: fail<br>hidden: fail | hidden: fail<br>visible:test: fail | as expected |
| c1d6770715 | over-broad-safety-codes | plausible but wrong | visible:test: fail<br>hidden: fail | hidden: fail<br>visible:test: fail | as expected |
| 4f261b2f4b | half-fix-call-site-left-wrong | plausible but wrong | visible:test: fail<br>visible:behavioral: fail<br>hidden: fail | hidden: fail<br>visible:test: fail<br>visible:behavioral: fail | as expected |
| 4f261b2f4b | equivalent-guard-different-text | correct, written differently | visible:test: fail<br>visible:behavioral: pass<br>hidden: pass | hidden: pass<br>visible:test: pass<br>visible:behavioral: pass | **over-constrained visible** |
| 070e9850b1 | install-guard-missing | plausible but wrong | visible:test: fail<br>hidden: fail | hidden: fail<br>visible:test: fail | as expected |
| 070e9850b1 | inspect-dev-mode-guard-missing | plausible but wrong | visible:test: fail<br>hidden: fail | hidden: fail<br>visible:test: fail | as expected |
| 79664a00cc | closed-handler-only | plausible but wrong | visible:full: fail<br>visible:behavioral: fail<br>hidden: fail | hidden: fail<br>visible:full: fail<br>visible:behavioral: fail | as expected |
| 79664a00cc | equivalent-guard-different-text | correct, written differently | visible:full: fail<br>visible:behavioral: pass<br>hidden: pass | hidden: pass<br>visible:full: pass<br>visible:behavioral: pass | **over-constrained visible** |
| 8d08bc3621 | copy-still-uses-patched-fs | plausible but wrong | visible:test: fail<br>hidden: fail | hidden: fail<br>visible:test: fail | as expected |
| c7cbaa326f | head-truncation-restored | plausible but wrong | visible:test: fail<br>hidden: fail | hidden: fail<br>visible:test: fail | as expected |

- **8 of 10 as expected**, including all 8 plausible-but-wrong patches failing both validators (e.g. the `4f261b2f4b` half-fix that leaves the wrong identifier at the call site).
- **The 2 mismatches are over-constrained *visible source-text tests*** rejecting a behaviorally correct patch (`!fn` instead of `typeof fn !== 'function'`; `isDestroyed() === true`). The hidden scorers accepted both. The eval-derived behavioral variants (`4f261b2f4b:behavioral`, `79664a00cc:behavioral`) accepted them, which is why those are the variants to give X. This is the concrete case for the two-layer design: the source-text originals would have produced false failures.

## Cross-cutting findings

1. **X's validation runs `node --test-isolation=none --test`**, not plain `node --test`. Qualification therefore used X's runner; a plain `node --test` result would not have been evidence.
2. **Source-text tests over-constrain** (`4f261b2f4b` test 6, `79664a00cc` WL-S1..S3). They are kept in the record but should not be the validator X repairs against.
3. **Hidden scorers were authored knowing the fix.** That is a real bias risk (overfitting to the reference implementation). It is partly mitigated by the parent-fails / fixed-passes / control-checks-pass structure and by the wrong-patch and alternative-correct probes, but not eliminated.
4. **Marker coupling.** The `79664a00cc` and `4f261b2f4b` harnesses slice `electron/main.cjs` by string marker. A fix that renames or restructures those declarations would be mis-scored.
5. **Environment fidelity.** Dependencies are the *current* `node_modules` (Electron 44.3.0), not each commit's historical set. Passing here does not prove the historical dependency set would behave the same.
6. **Two QUALIFIED tasks are infeasible for X v0.1.** `4f261b2f4b` and `79664a00cc` require editing `electron/main.cjs` (75-148 KB) and X cannot patch a file over its 20,000-byte cap. Validator qualification is unaffected; task feasibility is a separate question answered in Step 5.
7. **Domain concentration.** All 5 QUALIFIED are updater / Electron-window / X-gate code. The Step-2 gap (pure-logic fixes elsewhere) is unchanged.

## Files created (eval-only, under `scripts/x-eval/`)

- `validator-qualification-v1.md` (this file)
- `qualify-validators.mjs` (driver), `qualification/candidates.mjs` (configs, derived variants, mutants)
- `qualification/scorers/` (`_lib.mjs` + 7 hidden scorers)
- `qualification-results-v1.json` (raw run data)

Also edited: `evidence-audit-v1.md` header only (branch/commit metadata corrected to `main @ 11ef37b6fe`).

## Not verified

- That X can solve any of these tasks, or that a task text can be written without leaking the answer.
- Behavior with each commit's historical `node_modules` (see finding 5).
- More than 2 repeated runs per phase, and any timing/load flakiness beyond that.
- Wrong-patch coverage beyond the 10 probes; no alternative-correct probe for `c1d6770715`, `070e9850b1`, `8d08bc3621`.
- Whether hidden scorers stay hidden in Step 5: the runner must keep `scripts/x-eval/` out of X's workspace and out of any `git_inspect`-visible tree.
