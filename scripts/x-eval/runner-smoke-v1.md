# X-Eval v1 - Step 5: Isolated Snapshot Runner (smoke with model stubs)

**Status: runner built; smoke 42/42 checks PASS (two consecutive runs, identical results); 16 runs, ~12 s.** Model = stubs only. **No Ollama, no real model, no benchmark score taken.** Frozen X v0.1 untouched (`mcp/x` index hash and clean-vs-HEAD verified before and after). Nothing committed.

## Headline finding: 2 of the 5 QUALIFIED tasks cannot be done by frozen X v0.1

`4f261b2f4b` and `79664a00cc` require editing `electron/main.cjs` (148,260 and 75,328 bytes). X's context loader has a hard per-file ceiling of 20,000 bytes; a longer file is loaded as `truncated`, and X refuses to `patch`/`replace` any file it did not see in full (`PRECONDITION_FAILED: patch target has no complete (status: ok) snapshot`). The **oracle stub, which replays the exact reference fix, still fails both** (checks A3, A4). So the outcome is decided by X's design, not by the model. This corrects two earlier statements of mine (Step 3 and the Step-4 conditions called it "retrieval difficulty"; both docs are now amended).

Two consequences worth knowing:

- **X mis-classifies it.** `PRECONDITION_FAILED` is in X's *repairable* set, so X burns all 3 rounds on a hopeless situation and the gate reports `NEEDS_REVIEW / repair_budget_exhausted_transient`, i.e. "transient", though it is permanent.
- **The other three tasks also depend on a config override.** Their target files are 13-15 KB once line-numbered, above the production default of 8,000 bytes. The runner sets `maxBytesPerFile: 20000` (X's own ceiling) and records it on every run. With the default, all five tasks would be structurally impossible.

With that override the oracle stub gets **SUCCESS with X's gate agreeing** on `c1d6770715`, `8d08bc3621`, `070e9850b1` (checks A1, A2: the final diff equals the reference numstat, hidden scorer 25/25, 3/3, 9/9). Those three are the measurable set; the two main.cjs tasks are deterministic "X cannot" probes.

## Design

```text
current frozen X v0.1  (imported from the main checkout; never from a snapshot)
        |
git archive <parent>  ->  neutral temp dir  ws-XXXXXX
        |               git init + ONE commit "baseline"; node_modules = excluded symlink
        |               inject the visible validator ONLY (historical or historical_derived)
        |
   PREFLIGHT: visible AND hidden must FAIL at the baseline, else HARNESS_ERROR and the model is never called
        |
   leak scan (snapshot, task text)  ->  round-1 context packet  ->  executeXTask(recording adapter)
        |                                                              (repairOutcome, gateResult, xResult, model calls, wall time)
   external checks on the final tree: diff vs baseline, out-of-scope paths, test tampering, HEAD unchanged
        |
   hidden scorer  (outside the snapshot, given --root <snapshot>, started only after X ended)
        |
   outcome A: SUCCESS | FALSE_SUCCESS | FAILURE | MODEL_UNAVAILABLE | HARNESS_ERROR   ->   snapshot deleted, artifacts kept outside
```

Rules locked (each is asserted by a smoke check, see the tables):

1. `qualification/scorers/` is never inside the target workspace; the scorer receives `--root <snapshot>` from outside (D1, D6, E3).
2. The visible validator is read-only to X: the task scope forbids `scripts/`, the file is not loaded into context, `create` cannot overwrite, and any change is caught externally (B3, B4, B5, B6).
3. The reference SHA, patch lines and scorer strings are absent from the snapshot, the task text and the round-1 prompt (D1, D2, D3), verified with a positive control so "no hits" is not vacuous (D4, D5).
4. Executor and target never share code: corrupting the snapshot's `mcp/x/*` does not change the frozen executor (B7).
5. `validator_provenance` is recorded per run; `synthetic` is refused (B10, E5). Tier A = `historical` (`c1d6770715`, `8d08bc3621`, `070e9850b1`); Tier B = `historical_derived` (`4f261b2f4b`, `79664a00cc`). `9aa1446303` and `c7cbaa326f` stay HOLD and are not runnable.
6. No automatic context control run.

## Files (all under `scripts/x-eval/`)

- `runner/lib.mjs` snapshot, diff, scorer, leak-scan helpers; `runner/run-task.mjs` one task end to end (CLI accepts `stub:*` only); `runner/stubs.mjs` model stubs; `runner/smoke.mjs` the smoke suite
- `tasks/tasks-v1.mjs` the 5 task definitions (**draft text, unreviewed**)
- `runner-smoke-results-v1.json` raw results. Artifacts per run (`run-record.json`, `final.patch`) go to `--artifacts-dir`, outside every snapshot.
- Reproduce: `node scripts/x-eval/runner/smoke.mjs --work-dir <dir> --artifacts-dir <dir>`

## Smoke results

### A end-to-end

| id | check | result |
|---|---|---|
| A1.c1d6770715 | oracle replay -> SUCCESS, X gate agrees (A, historical) | PASS |
| A2.c1d6770715 | final numstat vs baseline equals the reference fix numstat | PASS |
| A1.8d08bc3621 | oracle replay -> SUCCESS, X gate agrees (A, historical) | PASS |
| A2.8d08bc3621 | final numstat vs baseline equals the reference fix numstat | PASS |
| A1.070e9850b1 | oracle replay -> SUCCESS, X gate agrees (A, historical) | PASS |
| A2.070e9850b1 | final numstat vs baseline equals the reference fix numstat | PASS |
| A3.4f261b2f4b | STRUCTURAL: perfect (oracle) model still cannot edit electron/main.cjs (loaded as truncated, patch refused) | PASS |
| A4.4f261b2f4b | X spends its whole repair budget on it and reports repair_budget_exhausted_transient (X classifies PRECONDITION_FAILED as repairable) | PASS |
| A3.79664a00cc | STRUCTURAL: perfect (oracle) model still cannot edit electron/main.cjs (loaded as truncated, patch refused) | PASS |
| A4.79664a00cc | X spends its whole repair budget on it and reports repair_budget_exhausted_transient (X classifies PRECONDITION_FAILED as repairable) | PASS |

### B controls

| id | check | result |
|---|---|---|
| B1 | noop model: FAILURE, empty diff, full repair budget (3 model calls), hidden scorer fails | PASS |
| B2 | malformed model output: FAILURE, empty diff, blocker malformed_json recorded | PASS |
| B3.1 | X refuses create at '../xeval-escape-probe.txt': blocked, empty diff, nothing written outside the snapshot | PASS |
| B3.2 | X refuses create at '<abs path inside the eval dir>': blocked, empty diff, nothing written outside the snapshot | PASS |
| B3.3 | X refuses create at 'scripts/test-xeval-injected.mjs': blocked, empty diff, nothing written outside the snapshot | PASS |
| B3.4 | X refuses create at 'docs/xeval-probe.md': blocked, empty diff, nothing written outside the snapshot | PASS |
| B4 | X cannot overwrite the visible validator (not loaded in context, forbidden path): blocked, no tampering | PASS |
| B5 | harness-level tampering (stub rewrites the visible test + touches README): X gate is fooled (COMPLETED) but the runner reports FALSE_SUCCESS | PASS |
| B6 | external check flags TEST_TAMPERING (visible test) and OUT_OF_SCOPE (README.md and the test path) | PASS |
| B7 | executor isolation: corrupting the snapshot's own mcp/x/* does not affect the frozen executor (no throw, full X result produced) | PASS |
| B8 | the corruption itself is visible to the external checks (out-of-scope changes under mcp/x) | PASS |
| B9 | preflight guard: baseline already FIXED -> HARNESS_ERROR and the model is never called | PASS |
| B10 | validator_provenance 'synthetic' is refused | PASS |

### C determinism

| id | check | result |
|---|---|---|
| C1 | same task + same oracle twice: identical final patch and identical round-1 prompt (path-independent) | PASS |

### D secrecy

| id | check | result |
|---|---|---|
| D1 | no reference SHA / hidden-scorer token in any snapshot (all runs) | PASS |
| D2 | no reference SHA / scorer token / reference-added source line in any x-task text | PASS |
| D3 | no reference SHA / scorer token / reference-added source line in the round-1 model prompt | PASS |
| D4 | POSITIVE CONTROL: the leak scanner does detect a planted scorer token (file scan and prompt scan), so "no hits" is not vacuous | PASS |
| D5 | scanner inputs stay non-vacuous per task AFTER excluding natural-text tokens (>=2 SHA tokens, >=5 scorer tokens used, >=1 reference-added line) | PASS |
| D6 | hidden scorer lives outside every snapshot and started only AFTER X ended (all runs that scored) | PASS |
| D7 | no task id / commit SHA in the workspace directory name X can observe | PASS |

### E isolation

| id | check | result |
|---|---|---|
| E1 | every snapshot: exactly 1 reachable commit ("baseline"), no remotes, only refs/heads/main | PASS |
| E2 | X's own git_inspect (log/head/branch) in the snapshot shows only the baseline commit | PASS |
| E3 | executor module and eval dir are both outside every snapshot; every snapshot is outside the repo | PASS |
| E4 | X could not move HEAD (commit_policy never): HEAD is still the baseline in every scored run | PASS |
| E5 | provenance recorded on every run and limited to historical / historical_derived; tiers match the Step-4 plan | PASS |

### F cleanup

| id | check | result |
|---|---|---|
| F1 | every run removed its snapshot; work dir holds no ws-*/pat-*/ctl-* leftovers | PASS |
| F2 | no process left running with the work dir in its command line | PASS |
| F3 | artifacts (run-record.json, final.patch) are outside the snapshot and survived cleanup | PASS |

### F frozen X

| id | check | result |
|---|---|---|
| F4 | frozen X v0.1 untouched: mcp/x index hash and clean-vs-HEAD flag identical before/after all runs, and clean | PASS |
| F5 | main checkout untouched: HEAD and `git status --porcelain` identical before/after | PASS |
| F6 | no stray probe files were created in the main checkout or eval dir | PASS |

### Runs

| task | stub | outcome | model calls | hidden scorer | wall time |
|---|---|---|---|---|---|
| c1d6770715 | oracle | SUCCESS | 1 | 25/25 | 683 ms |
| 8d08bc3621 | oracle | SUCCESS | 1 | 3/3 | 1284 ms |
| 070e9850b1 | oracle | SUCCESS | 1 | 9/9 | 1132 ms |
| 4f261b2f4b | oracle | FAILURE | 3 | 3/8 | 943 ms |
| 79664a00cc | oracle | FAILURE | 3 | 4/7 | 820 ms |
| c1d6770715 | noop | FAILURE | 3 | 4/25 | 800 ms |
| c1d6770715 | malformed | FAILURE | 3 | 4/25 | 692 ms |
| c1d6770715 | create:../xeval-escape-probe.txt | FAILURE | 1 | 4/25 | 635 ms |
| c1d6770715 | create:/Users/illman/D... | FAILURE | 1 | 4/25 | 628 ms |
| c1d6770715 | create:scripts/test-xeval-injected.mjs | FAILURE | 1 | 4/25 | 630 ms |
| c1d6770715 | create:docs/xeval-probe.md | FAILURE | 1 | 4/25 | 632 ms |
| c1d6770715 | replace-visible-test | FAILURE | 3 | 4/25 | 699 ms |
| c1d6770715 | side-effect-tamper | FALSE_SUCCESS | 1 | 4/25 | 660 ms |
| c1d6770715 | poison-snapshot-x | FAILURE | 3 | 0/1 | 793 ms |
| c1d6770715 | noop | HARNESS_ERROR (preflight: a validator did not fail at t) | 0 | - | 292 ms |
| c1d6770715 | oracle | SUCCESS | 1 | 25/25 | 688 ms |

## What this proves, and what it does not

**Proves (for these stubs and tasks):** the snapshot has exactly one commit and no path to the reference; the executor is the frozen X, unaffected by the snapshot; the hidden scorer stays outside and runs after X; a stub that tampers with the validator or escapes the workspace is caught (or blocked by X), including the case where X's own gate is fooled; a bad baseline aborts before any model call; cleanup leaves nothing behind; the main checkout and `mcp/x` are unchanged; identical inputs give identical patches and prompts.

**Does not prove:** anything about a real model; that a real model will not find a leak path a stub cannot (X exposes no arbitrary read to the model today, and `git_inspect` is a fixed enum, but that is a code reading, not a test against a model); behavior with each commit's historical dependencies (current `node_modules` are symlinked); that the task texts are good.

## Decisions needed before Step 6 (real model)

1. **The two `main.cjs` tasks.** Recommendation: keep them as deterministic "X v0.1 cannot" probes but **exclude them from quality scoring**, leaving Gold v1 measurable on 3 tasks. Changing X to lift the cap is out of scope while X is frozen.
2. **Context override.** Confirm `maxBytesPerFile: 20000` as the benchmark's frozen-X configuration (deviates from the production default; recorded per run).
3. **Prompt size vs the model window.** Round-1 prompts are 21.9-24.3 KB (~6.3-6.9K tokens at 3.5 B/token) for the three feasible tasks, against `normal` profile `num_ctx` 8,192 with `num_predict` 1,024, and repair rounds add evidence. Step 6 needs an explicit `num_ctx`, or Ollama may truncate silently (the earlier hypothesis, now with concrete sizes).
4. **Task text review.** The five drafts name the suspected file (`hint_level: file`) and, for `c1d6770715` and `070e9850b1`, the constant/API the validators need.

## Not done (by design)

Cause tagging and the taxonomy beyond outcome layer A; the oracle-context control run; any real-model adapter (the CLI refuses non-stub adapters); Gold Set lock.
