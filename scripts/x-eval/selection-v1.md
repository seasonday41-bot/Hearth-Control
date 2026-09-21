# X-Eval v1 - Step 2: Provisional Selection

**Status: PROVISIONAL. Nothing here has been run.** Not a Gold Set until a human locks it and the validators are proven (Step 4+).

- Source of truth: `scripts/x-eval/candidates.json` (mined at `11ef37b6fe`). Facts in the table (commit, parent, files, lines, validator commands, flags) come from it; the judgment columns come from reading each commit's source diff and test source.
- Scope: the 15 fix-like candidates only. The 35 other candidates (mostly `feat`) are not evaluated here.
- Method: `git show` / `git cat-file` only. No checkout, worktree, test run, X run, or edit to `mcp/x/*`.
- "source lines changed" = insertions + deletions on source files only (tests excluded).

## Rubric

| column | HIGH | MEDIUM | LOW |
|---|---|---|---|
| spec clarity | one observable before/after that a task can state without prescribing the code | needs an API/name/constant stated in the task text | design choice, or several behaviors bundled |
| validator credibility | asserts the fixed behavior directly | partly behavioral, or partly source-text | mostly source-text/regex that dictates the implementation |
| historical leakage | `mcp/x` on the executor's own model-facing path (prompt, repair feedback, edits) | `mcp/x`, not model-facing (result/queue/runtime) | does not touch `mcp/x` |

For `mcp/x` commits the risk is real only if the runner mixes executor and target (see requirement 1 below). `UNKNOWN` validator = no test in the commit.
Credibility is judged from what the test asserts. **No validator has been shown to fail at the parent and pass at the fix.** That is the Step-5/6 gate.

## Requirements this review surfaced for the runner (not implemented)

1. **Executor and target must not share a code path.** Executor = current frozen X v0.1. Target = historical parent tree. `mcp/x` commits are only safe if the target tree's `mcp/x` is never imported by the executor.
2. **Future commits must be unreachable from the target.** A `git worktree` shares the object store, so later commits are reachable via branches, `git log --all`, reflog, or `git show <sha>`, by any tool that can run arbitrary git. X's `git_inspect` is *not* such a tool: it is an enum of five fixed commands (`mcp/skills/gateway.mjs:127-133`, `log` is fixed to `-n 8 --oneline --no-decorate`), so it cannot open a future SHA today. Isolate anyway: `git archive <parent>` into a temp dir, then `git init` + one baseline commit, so the executor still has a working `git status` / `git diff` but no future history.
3. **Generated files are invisible to the miner but can gate tests.** `test-build-metadata.mjs` asserts a hard-coded build ID from `electron/stable-build-meta.json`. Exclude such tests from validators (done above for `4f261b2f4b`, `11ef37b6fe`).
4. **Many validators read `main.cjs` as text** (regex, `indexOf`, `new Function` extraction). They can over-constrain the implementation or break on layout changes. Flag per test; score behavioral assertions where separable.
5. **Environment.** `8d08bc3621` needs the Electron binary and `@electron/asar` (`package.json` at that commit has `"electron": "latest"` and no direct `@electron/asar`). Historical `node_modules` must be checked per task.
6. **`electron/main.cjs` is 75-148 KB at these parents, over X's 20,000-byte hard per-file cap.** Frozen X v0.1 loads it as `truncated` and refuses to patch a file it did not see in full, so no model can make X edit it (measured in Step 5, `runner-smoke-v1.md`). This is a structural limit, not a retrieval difficulty (an earlier version of this line understated it).

## Selection table

Order: INCLUDE (easiest / clearest ground truth first), HOLD, EXCLUDE (by miner score).

| commit | subject | parent | source files | source lines changed | validation strength | candidate validator / test | new source file? | touches `mcp/x`? | touches `electron/main.cjs`? | spec clarity | validator credibility | historical leakage risk | recommended | short reason |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| c1d6770715 | fix: normalize X structural result gate reason | 470da93ca7 | `mcp/x/result-gate.mjs` | 11 | in_commit | `node --test scripts/test-x-result-gate.mjs` | no | yes | no | MEDIUM | HIGH | MEDIUM | **INCLUDE** | Behavior before/after is exact: 10 known execution-failure codes now yield `reason_code = structural_execution_failure`, raw code kept in `evidence.blocker`. Parametrized test asserts both directly. Task text must state the constant (X cannot infer a name). |
| 4f261b2f4b | fix(updater): use initialized X runtime preflight | 24a813f1f8 | `electron/main.cjs` | 4 | in_commit | `node --test scripts/test-updater-runtime-preflight.mjs`<br>(NOT `test-build-metadata.mjs`: asserts a generated build ID) | no | no | yes | MEDIUM | MEDIUM | LOW | **INCLUDE** | Undefined identifier `xGetNextXWakeupDeadline` (real one is `xGetNextWakeupDeadline`, defined ~640 lines above in a 3,066-line file) makes preflight always report runtime unavailable. Single correct fix. Validator is a source-text assertion (positive + negative), hence MEDIUM. Score ONLY `test-updater-runtime-preflight`; `test-build-metadata` is coupled to a generated file. |
| 8d08bc3621 | fix(updater): use physical filesystem for app staging | b3186b8506 | `electron/remote-update-stager.cjs` | 17 | in_commit | `node --test scripts/test-remote-stager-electron-asar.mjs` | no | no | no | HIGH | HIGH | LOW | **INCLUDE** | Real bug: under Electron, patched `fs` treats `app.asar` as an archive and staging a real `.app` fails. Test reproduces that precondition in Electron, then asserts asar stays an opaque file, symlinks and tree hash preserved. Needs domain knowledge (`original-fs`); runnability needs the Electron binary + `@electron/asar`. |
| 070e9850b1 | fix: prevent stale updater downgrades | c41a557a0d | `electron/main.cjs`<br>`electron/updater.cjs` | 59 | in_commit | `node scripts/test-updater.mjs` | no | no | yes | MEDIUM | HIGH | LOW | **INCLUDE** | Stale same-version build must not count as an update. 10 behavioral tests on `updater.cjs` (dev mode, semver order, `builtAt` fail-closed, `installUpdate` guard). But the tests fix the API (`isManifestNewer`, `currentBuiltAt`, `isPackaged`), so the task text must specify it; the `main.cjs` plumbing is not behaviorally tested. |
| 79664a00cc | fix: reopen Hearth after window close | aa50d93162 | `electron/main.cjs` | 19 | in_commit | `node --test scripts/test-electron-window-lifecycle.mjs`<br>(score WL1-WL7, S4, S5 only) | no | no | yes | HIGH | MEDIUM | LOW | **HOLD** | Clear crash (`Object has been destroyed` on second-instance after window close). WL1-WL7 are real behavioral tests, but WL-S1..S3 are regexes requiring the literal text `const window = mainWindow;` etc., and the harness slices `main.cjs` by string markers. Promote to INCLUDE if scoring is limited to WL1-WL7 + S4/S5. |
| c7cbaa326f | Hearth X: improve repair evidence and guidance | e322e75d1b | `mcp/x/local-executor.mjs`<br>`mcp/x/repair-loop.mjs` | 63 | in_commit | `node --test scripts/test-x-local-executor.mjs`<br>`node --test scripts/test-x-repair-loop.mjs` | no | yes | no | LOW | MEDIUM | HIGH | **HOLD** | "Improve" bundles 3 changes (prompt fields, repair directive, tail truncation). Tests assert exact prompt strings. Only the tail-truncation part (RL17) is a crisp behavior. Executor-path code (prompt + repair feedback), so leakage is the worst kind. Would need to be split by hand. |
| 9aa1446303 | fix: preserve specialist recovery lineage | b374a39903 | `mcp/goals/model.mjs`<br>`mcp/goals/runner.mjs` | 17 | existing_related | 6 loosely related existing tests, e.g. `node scripts/test-goal-autopilot.mjs`; none proven | no | no | no | MEDIUM | UNKNOWN | LOW | **HOLD** | Clear intent: a retry after an interrupted/failed specialist execution must get a fresh generation-suffixed id, not collide (`deriveSpecialistExecutionId` already accepts a generation). No test in the commit; 6 loosely related goal tests. HOLD until a fail-at-parent regression test is authored or proven. |
| 474292fb78 | fix: recover X runs after lease expiry | af9dc24d6b | `electron/main.cjs`<br>`mcp/tools.mjs`<br>`mcp/x/production-runtime.mjs`<br>`mcp/x/queue-coordinator.mjs`<br>`mcp/x/run-store.mjs` | 168 | in_commit | `node --test scripts/test-electron-x-wakeup.mjs`<br>`node --test scripts/test-x-mcp-tools.mjs`<br>`node --test scripts/test-x-queue-coordinator.mjs`<br>`node --test scripts/test-x-run-store.mjs`<br>`node --test scripts/test-x-startup-reconciliation.mjs`<br>`node --test scripts/test-x-terminal-event.mjs` | no | yes | yes | LOW | MEDIUM | MEDIUM | **EXCLUDE** | X runtime recovery after lease expiry: 5 source files (incl. `production-runtime`, `queue-coordinator`, `run-store`), 6 test files, new hooks/API. Large state-machine change (source + test bodies only partly read). |
| 11ef37b6fe | fix(invest): stabilize v2 coordinator status for 0.4.13 | 8079ddb647 | `scripts/restore-stable-build-meta.cjs`<br>`src/App.tsx`<br>`src/invest-coordinator-status.ts` | 47 | in_commit | `node --test scripts/test-invest-ui-boundary.mjs`<br>(NOT `test-build-metadata.mjs`: asserts a generated build ID) | yes: `src/invest-coordinator-status.ts` | no | no | LOW | LOW | LOW | **EXCLUDE** | UI label mapping is a design choice, not a bug with a before/after; creates a new module with fixed exports. Bundled with a 0.4.13 version bump whose test hard-codes a build ID from generated `stable-build-meta.json`. |
| 70a5ece7c1 | feat: add X validation repair loop | d55d05d34f | `mcp/x/repair-loop.mjs` | 247 | in_commit | `node --test scripts/test-x-repair-loop.mjs` | yes: `mcp/x/repair-loop.mjs` | yes | no | LOW | MEDIUM | HIGH | **EXCLUDE** | A `feat`: creates the 247-line repair-loop module from scratch; the 386-line test defines its API. That is a design task, not a fix, and it is the executor's own repair path. |
| 69feb1c84c | fix(server): synchronize MCP server lifecycle state | 010b3fede8 | `electron/main.cjs`<br>`src/App.tsx` | 209 | in_commit | `node --test scripts/test-server-lifecycle.mjs` | no | no | yes | LOW | MEDIUM | LOW | **EXCLUDE** | Server-lifecycle state machine: `/health` probe, foreign-port detection, start timeout, stop-by-pid, state sync, in `main.cjs` + renderer. Several behaviors in one commit (test names only skimmed). |
| 50548177a3 | fix(updater): recover prepared update state | f4f5e890b8 | `electron/main.cjs`<br>`electron/remote-update-stager.cjs`<br>`electron/remote-update-state.cjs` | 163 | in_commit | `node --test scripts/test-remote-update-integration.mjs`<br>`node --test scripts/test-update-ready-recovery.mjs` | yes: `electron/remote-update-state.cjs` | no | yes | MEDIUM | HIGH | LOW | **EXCLUDE** | Creates a new module (`remote-update-state.cjs`) + refactors stager + rewires the check handler; tests fix the new API. Updater state-machine design. Possible later "stretch" tier. |
| 270d62491f | fix: make approval lifecycle durable in UI | 79664a00cc | `electron/main.cjs`<br>`mcp/http.mjs`<br>`src/App.tsx`<br>`src/electron.d.ts` | 133 | in_commit | `node --test scripts/test-electron-x-approval-lifecycle.mjs`<br>`node --test scripts/test-http-approval-lifecycle.mjs`<br>`node --test scripts/test-renderer-approval-fifo.mjs` | no | no | yes | MEDIUM | MEDIUM | LOW | **EXCLUDE** | Cross-layer event contract (`approval:resolved`) across `main.cjs`, `http.mjs`, renderer and types, 3 new test files that extract source by markers. Approval-lifecycle state machine (test bodies only skimmed). |
| ef1808fa2f | fix(runtime): hoist remote goal recovery helper | f99930f5c0 | `electron/main.cjs` | 6 | in_commit | `node scripts/test-remote-goal-requests.mjs` | no | no | yes | MEDIUM | LOW | LOW | **EXCLUDE** | Hoisting `const` to `function` (temporal-dead-zone fix). The only test is a regex demanding `async function recoverUnimportedGoalRequests()` and no `const ... =`: it dictates the literal implementation, no behavioral proof. |
| c41a557a0d | fix: make Electron message relay async | 9aa1446303 | `electron/main.cjs` | 2 | existing_related | 6 loosely related existing tests, e.g. `node scripts/test-bridge.mjs`; none proven | no | no | yes | LOW | UNKNOWN | LOW | **EXCLUDE** | One `async` keyword added to a handler; no observable behavior of its own and no test. `existing_related` matches 6 tests only because they read `main.cjs`. |

## Summary

| recommendation | count |
|---|---|
| INCLUDE | 4 |
| HOLD | 3 |
| EXCLUDE | 8 |

### INCLUDE, ordered from easiest / clearest ground truth

1. `c1d6770715`: 1 file, 11 lines. Rename a reason code, keep the raw code in evidence. Direct test. The task text must give the constant.
2. `4f261b2f4b`: 1 file, 4 lines. Wrong identifier. Trivial edit, but the file is 3,066 lines, so it mostly probes context retrieval. Text-based validator (MEDIUM).
3. `8d08bc3621`: 1 file, 17 lines. Small edit, but needs Electron/`original-fs` knowledge; strongest validator (real reproduction), highest environment cost.
4. `070e9850b1`: 2 files, 59 lines. Only multi-file, behavior-heavy item; the task must spell out the API; `main.cjs` plumbing is unverified by tests.

### HOLD, and what would promote it

- `79664a00cc`: limit scoring to the behavioral tests (WL1-WL7, S4, S5) -> INCLUDE.
- `9aa1446303`: needs a fail-at-parent regression test (authored or proven) -> INCLUDE.
- `c7cbaa326f`: only if split by hand to the tail-truncation behavior; leakage stays HIGH.

### Gaps to fill before a Gold Set of 20-30

Only 4 of 15 fix-like candidates are Gold-quality, so this pool cannot reach 20-30. What is missing:

1. **Pure-logic fixes outside Electron/updater/X.** All 4 INCLUDEs are updater or X-adjacent. Need behavioral-unit-test fixes in `mcp/goals`, `mcp/market`, `mcp/providers`, `mcp/router`, `mcp/context`, and renderer logic.
2. **A "medium" tier.** 3 of 4 INCLUDEs are 1-file, <=17 lines. Need 3-5 file fixes with behavioral tests. Relaxing the miner (now 5 files / 400 lines) would add some: 21 commits were cut for too many files, 14 for too large.
3. **The 35 unreviewed candidates** (30 `feat`, 5 untyped). Small additive commits with a crisp behavior and their own tests could be valid, but each needs the same human read.
4. **Fixes whose test arrived separately.** 4 `test_only` commits were rejected by the miner; some pair with an earlier source-only fix.
5. **Repo diversity.** Everything is one Electron/Node monorepo. Nothing exercises TypeScript/React logic beyond a UI mapping, or another repo's conventions.
6. **Miner improvement (optional).** Flag tests that validate by reading source text, and record when a test needs generated files, so requirements 3 and 4 above are caught automatically.

A non-historical source (seeded regressions on currently-passing tests) would give automatic ground truth but is not a "real patch" and is not proposed here without your decision.

## Review depth (what was actually read)

| depth | commits |
|---|---|
| source diff + full test diff/file | `c1d6770715`, `4f261b2f4b`, `ef1808fa2f`, `11ef37b6fe`, `8d08bc3621` |
| source diff + test diff or full test names (assertions partly read) | `070e9850b1`, `79664a00cc`, `c7cbaa326f`, `9aa1446303` (no test), `c41a557a0d` (no test) |
| source diff (partly) + test names/stats only | `69feb1c84c`, `50548177a3`, `270d62491f`, `474292fb78`, `70a5ece7c1` |

The EXCLUDE calls in the last row rest on scope and design (new modules, multi-file state machines), not on a full read of their tests.

## Not verified

- Any validator failing at the parent and passing at the fix.
- That any validator command runs in an isolated historical tree (dependencies, Electron, Node version).
- That a task text can be written for each INCLUDE without revealing the solution.
