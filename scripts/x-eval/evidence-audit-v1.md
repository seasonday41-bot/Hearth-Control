# X-Eval v1 - Step 3: Evidence Audit

**Status: audit only.** No runner, no model call, no test run, no change to `mcp/x/*`, no telemetry added to X.
Read-only source review of the current frozen X v0.1 in the working tree on `main` at `11ef37b6fe` (verified with `git branch --show-current` / `git rev-parse` when this header was corrected).

## The one question

> What evidence does X already produce, and what must X-Eval capture itself, without modifying X?

**Answer in three lines**

1. **X already produces** the mechanical outcome (gate status, reason code, rounds, per-round blockers and file changes, validation exit/duration, model name, `finish_reason`). Almost all of it lives only in memory in `repairOutcome`; the persisted `x-result-v1` keeps a thinner subset.
2. **X never produces** the raw prompt, raw model text, the context packet the model saw, token counts (`usage` is always `null` with the Ollama provider), real elapsed time, diff line counts, or a root cause.
3. **X-Eval can capture all of that without touching X**, by calling `executeXTask` directly and passing (a) a recording `ModelAdapter`, (b) a second `loadTaskContext` call for round 1, (c) an isolated git repo whose diff it reads externally. Only the context packet for repair rounds 2+ and exact token counts (without an unsupported provider tap) are out of reach.

## What was read

| file | depth |
|---|---|
| `execute-x-task.mjs`, `model-adapter.mjs`, `executor.mjs`, `repair-loop.mjs` | full |
| `local-executor.mjs` | `executeTask`, result shapes, limits, prompt builders, response parsing (not every helper) |
| `context-loader.mjs` | limits, packet shape, load order, packet ceiling (not every helper) |
| `result-builder.mjs` | header, `buildXResult`, validation/change/evidence builders |
| `result-gate.mjs` | header, statuses, reason-code inventory (not every branch body) |
| `run-store.mjs` | header, statuses, schema, method list (not each method body) |
| supporting, for accuracy | `validation-runner.mjs` (command policy, result shape), `edit-writer.mjs` (error codes), `providers/ollama.mjs` (`chat` return), `skill-integration.mjs` (`selectSkillId`), `run-x-task.mjs` / `production-runtime.mjs` (call site) |

## Where evidence lives

```text
executeXTask(task, modelAdapter, options)              // execute-x-task.mjs
  runTaskWithRepair -> repairOutcome                   // in memory, richest
      rounds[i] = { round, kind: 'execution'|'validation', classification,
                    executor: executorResult, validation: {required[], optional[]} | null }
  evaluateResultGate(repairOutcome) -> gateResult      // COMPLETED | NEEDS_REVIEW | FAILED + reason_code
  buildXResult(task, repairOutcome, gateResult) -> xResult   // bounded, secret-guarded x-result-v1
run-x-task.mjs -> XRunStore.completeRun(...)           // persists xResult (result_json) + gate columns
```

- `XRunStore` stores `x_result` only: "never receives or persists raw model/terminal output" (`run-store.mjs` header). A run that **throws** gets `failRun` = status `failed`, `result_json = NULL`, `error` capped at 2,000 bytes.
- `XRunStore` also keeps only the latest **200** runs by default (`DEFAULT_RUN_RETENTION_LIMIT`). It must not be the eval's record.
- `executeXTask` is a plain function. X-Eval can call it directly and receive `{ repairOutcome, gateResult, xResult }` with no queue, claim, or lease.

## Data-availability matrix

Legend: **Y** available, **P** partial, **N** not available. "Eval must capture" is the channel X-Eval owns.

| evidence | `xResult` (persisted) | `repairOutcome` / `executorResult` (in memory) | `loadTaskContext` packet | external (git / harness) | verdict and note |
|---|---|---|---|---|---|
| final gate status + `reason_code` | Y | Y (`gateResult`) | | | Y. Gate reasons observed: `validated`, `structural_execution_failure`, `safety_boundary_review`, `unrecognized_repair_outcome`, `model_unavailable_after_repair`, `repair_budget_exhausted_transient`. |
| repair outcome `validated` / `escalation_required` | N | Y | | | Only via `repairOutcome.status`. |
| rounds used / repair count | Y (`repair_attempts`) | Y (`total_rounds`) | | | Y. |
| per-round kind + `classification` (`repairable` / `escalate`) | N | Y | | | In memory only. |
| per-round blockers (`reason`, `code`, `detail`, `path`) | P (top-level, bounded) | Y | | | Round-by-round only in `repairOutcome`. |
| files changed | Y (union of all rounds) | Y (per round) | | Y (git) | Y. |
| per-change `operation/path/status/code/detail/before_hash/after_hash/bytes_written` | P (`change_summary`: round, operation, path, status only) | Y | | | `code` and `detail` are dropped from `xResult`. |
| required/optional validation: status, exit code | Y (final round only) | Y (every round) | | Y (rerun) | Earlier rounds are never shown in `xResult`. |
| validation stdout/stderr, `signal`, `timedOut`, `outputTruncated`, `durationMs` | N (`stdout_ref`/`stderr_ref` are `null`) | Y (bounded by validation limits) | | | In memory only. |
| validation time | P (`validation_minutes`, sum only) | Y (per result) | | | |
| model provider / model name | N | Y (`model_metadata`) | | | `null` if the run failed before any model call (`context_load_failed`). |
| `finish_reason` (`length` = output cap hit) | N | Y (`model_metadata.finish_reason`) | | | Y for parse failures too (metadata is attached). |
| **token usage / Ollama eval counts** | N | **N (`usage` is always `null`)** | | | The Ollama `chat()` result drops `prompt_eval_count`, `eval_count`, durations; nothing populates `usage`. |
| model `explanation`, `confidence` | N (deliberately omitted) | Y (unverified prose, explanation capped at 2,000 bytes) | | | Never treat as evidence. |
| **raw model response text** | N | **N** | | | Discarded by `executeTask`. Eval capture needed. |
| **exact prompt + request options** (messages, JSON `format` schema, profile, num_ctx, num_predict) | N | **N** | | | Eval capture needed. |
| context files the model saw (path, status `ok`/`truncated`/`redacted`, bytes) | N | N | Y (round 1) | Y (prompt) | Reconstructable per round from the recorded prompt (`--- path (status: X) ---`). |
| `omitted[]`, `blockers[]`, `search_results`, git status in the packet | N | N | Y (round 1 only) | | **Not rendered in the prompt** (`buildContextSection` shows only files + known_evidence). Repair-round packets are not exposed (`buildRepairTask` output stays internal). |
| context limits in force | N | N | Y (`limits`) | | Defaults: 12 files, 8,000 B/file, 40,000 B total, 20 search results. |
| skill selected | N | N | | Y (`selectSkillId(task)`) | Deterministic and exported; the skill text is in the recorded prompt. |
| elapsed wall time | N (`actual_minutes = null`) | N | | Y (harness clock) | Per model call via recording adapter; per validation via `durationMs`. |
| diff insertions / deletions / patch | N (`null`) | N | | Y (`git diff --numstat`, `git diff`) | Needs the isolated baseline commit. |
| root cause / why fix works | N (`null` by design) | P (model prose, unverified) | | | Human review only. |
| memory pressure / swap | N | N | | Y (host sampling) | Coarse, heuristic. |
| uncaught exception in X | N (`failRun` text only, if used) | N | | Y (`try/catch` around `executeXTask`) | Harness must catch and record. |

## Non-obvious findings that shape the taxonomy

1. **`PRECONDITION_FAILED` is overloaded.** The same code covers: `old_string not found` / `not unique` (model precision), `patch target has no complete (status: ok) snapshot in the loaded context` (a **context** problem, set by `blockedActionResult` in `local-executor.mjs`), `a file already exists at this path` (bad `create`), and `expectedHash did not match` (drift, should be impossible in an isolated repo). The code alone cannot separate context from model; the fixed English `detail` string can. That is a **string match on X's own messages: deterministic today, brittle if X wording changes.**
2. **The validation command allowlist is narrow.** `validation-runner.mjs` accepts only `node --test scripts/test-<name>.mjs [...]` (`COMMAND_PATTERN`). Anything else is `invalid_command`, which **escalates immediately with no repair round** (task-authoring defect). Consequence for Gold Set v1: `070e9850b1`'s candidate command is `node scripts/test-updater.mjs` (a plain script, not `node:test`). It does not match the allowlist as written; whether `node --test scripts/test-updater.mjs` passes is **unverified**.
3. **Prompt vs model window.** The default profile is `normal` (`num_ctx` 8,192, `num_predict` 1,024, `think: false`), while the context budget is up to 40,000 bytes. Code is roughly 3-4 bytes/token, so a full budget can exceed 8K tokens by itself. Ollama then truncates silently, and X has no signal for it (`usage` is `null`). This is a **hypothesis to measure**, not an observed fact.
4. **Tuning does not require editing X.** `executeXTask(task, adapter, { modelOptions })` forwards `model`, `profile`, `num_ctx`, `num_predict`, `temperature`, `think`, `timeoutMs`, and `context` (Ollama options, e.g. `seed`) through `ModelAdapter.generate`. Record them per run.
5. **The model never controls validation.** `task.validation.required` comes only from the task. So a required validator that is weak or wrong is a task-design defect, and `COMPLETED` only means "X's own required command passed".
6. **`COMPLETED` is not success.** The gate trusts X's own required validation. If that command is the same test the eval scores, `COMPLETED` and eval-success coincide; if the model edits a test or the validator is weak, they can diverge. The eval needs its own independent scoring run.

## What X-Eval captures itself (no X change)

| channel | how | provides |
|---|---|---|
| **Recording ModelAdapter** | Wrap `createOllamaModelAdapter()`; delegate unchanged; log each `generate(request, options)` | exact messages and `format`, options actually passed, raw response text, `finish_reason`, model, error code, wall ms per call, prompt bytes, per-round file list and statuses parsed from the prompt |
| **Round-1 context packet** | Call `loadTaskContext(task, sameContextOptions)` once before `executeXTask` (deterministic on an unchanged tree) | `omitted`, `blockers`, `search_results`, git block, limits; ground-truth coverage flags |
| **Isolated repo** | `git archive <parent>` into a temp dir, `git init`, one baseline commit (chosen earlier) | patch, `--numstat`, files touched vs ground truth, tampering and scope checks |
| **Independent scorer** | After X returns, run the candidate's scoring command on the final tree, outside X | `SUCCESS` / `FALSE_SUCCESS`, validator exit, duration |
| **Harness clock + `try/catch`** | Around `executeXTask` and each phase | total wall time, uncaught exceptions |
| **Optional provider tap** | Instance-level wrap of the eval-created Ollama provider's internal `request()` | `prompt_eval_count`, `eval_count`, Ollama durations. **Depends on a provider internal, so fragile; keep optional.** |
| **Host sampler** | `vm_stat` / `memory_pressure` during the run | coarse memory and swap, heuristic |

**Cannot be obtained without changing X (parked, not needed now):** context packets for repair rounds 2+ (`omitted`/`blockers`); X-native per-phase timing; a root cause. Exact token counts are reachable only through the optional tap above.

## Failure taxonomy

Confidence classes: **D** deterministic (mechanical rule on recorded evidence), **H** heuristic (rule is mechanical but the *attribution* is an inference), **R** human-reviewed.

### A. Run outcome (mutually exclusive, first match wins)

| outcome | rule | class |
|---|---|---|
| `HARNESS_ERROR` | eval setup failed; scoring validator does not **fail on the baseline**; scoring command cannot run; eval code threw; `executeXTask` threw a non-cancellation error. Reported separately, excluded from X's rates. | D |
| `MODEL_UNAVAILABLE` | every failing round is `model_request_failed` with provider error `TIMEOUT` / `UNAVAILABLE` (or equivalent infra error). Rerun; excluded from quality rates. | D |
| `SUCCESS` | independent scorer passes on the final tree **and** no test or protected file modified **and** no path outside `scope.allowed_paths` | D |
| `FALSE_SUCCESS` | gate `COMPLETED` but scorer fails, or tampering/scope check fails | D |
| `FAILURE` | otherwise; assign causes below | D |

### B. Cause attribution for `FAILURE` (record every tag that fires; primary = first in this order)

| tag | fires when | evidence | class |
|---|---|---|---|
| `OUTPUT_LIMIT` | a round has `finish_reason == 'length'` **and** its blocker is `malformed_json`, `response_too_large`, or `schema_invalid` | `model_metadata`, recorded response | flag **D**; "caused the failure" **H** |
| `MODEL_FORMAT` | blocker `malformed_json` / `schema_invalid` / `unsupported_action` / `missing_field` / `too_many_actions` / `too_many_files`, no `length` | blocker reason | D |
| `MODEL_PATCH_INVALID` | `PRECONDITION_FAILED` with detail `old_string not found` or `not unique` | blocker code + detail string | D (brittle string) |
| `CONTEXT_FAILURE` (structural) | `PRECONDITION_FAILED` with detail `no complete (status: ok) snapshot`; **or** a ground-truth source file is missing from round-1 context, or present as `truncated` | blocker detail; round-1 packet vs candidate `source_files` | flag **D**; causal claim **H** |
| `CONTEXT_FAILURE` (confirmed) | a control rerun with the ground-truth files added to `scope.preferred_files` succeeds where the normal run failed | second run | **D** on the control's outcome, and the only causal test that needs no human |
| `PROMPT_OVERFLOW_SUSPECTED` | recorded prompt bytes / 3-4 exceeds `num_ctx`; or, with the optional tap, `prompt_eval_count` at/near `num_ctx` | prompt size, tap | **H** (estimate) / **D** (tap) |
| `SCOPE_ATTEMPT` | blocker `PATH_REJECTED` / `PROTECTED_PATH` / `SYMLINK_ESCAPE` / `INVALID_SCOPE` | blocker code | D (model tried; boundary held) |
| `TEST_TAMPERING` | any test file differs from the baseline, or the scorer's own test file was edited | git diff | D |
| `WRONG_FILE` | files changed ∩ ground-truth `source_files` is empty | git diff vs candidate | flag **D**; attribution (context vs model) **H** |
| `NO_EDIT` | executor `completed` with empty `files_changed` and validation still fails | executor result | D |
| `TOOL_FAILURE` | uncaught exception in X; `expectedHash did not match` (drift in an isolated repo); `UNREADABLE_TARGET` on a target that exists; validation `timed_out` for an environment reason | exception, blocker detail | D flag; "not the model" attribution **H** |
| `TASK_SPEC_FAILURE` | `invalid_validation_command` (command outside the allowlist); baseline validator not failing (caught earlier as `HARNESS_ERROR`); otherwise a human judges the task text vs the ground-truth patch | reason `invalid_validation_command`; human notes | allowlist case **D**; everything else **R** |
| `VALIDATION_FAILURE` (unattributed) | edits applied, required validation failed at the last round, and none of the tags above fired | final round validation | D as a descriptor |
| `MODEL_FAILURE` (by exclusion) | `VALIDATION_FAILURE` with adequate context, no output limit, well-formed applicable patch | absence of the other tags | **H** |

**Human review queue (R):** every `MODEL_FAILURE`, every `TASK_SPEC_FAILURE`, every `WRONG_FILE`, and every `SUCCESS` whose diff touches files outside the ground truth or is much larger than it (a passing test does not prove the fix is the intended one).

**Rule for the taxonomy itself:** a tag is stored with its evidence pointers and its class (D/H/R). Aggregates report D and H separately, so a headline "n% context failures" never silently mixes mechanical facts with inference.

## Proposed run-record fields (for schema stability, not implemented)

- **identity:** eval version, candidate commit + parent, task id, sample index, X version (git commit + build), model tag, profile and every `modelOptions`, node version, host.
- **timing:** total wall time, per-model-call ms, per-validation ms.
- **rounds[]:** kind, classification, executor status, blockers, changes (operation, path, status, code, detail, hashes), `model_metadata`, validation results (command, status, exit, duration, timedOut, outputTruncated, bounded stdout/stderr).
- **model_calls[]:** full request messages + format hash, options, raw response, `finish_reason`, error, ms, prompt bytes, estimated (or tapped) tokens.
- **context:** round-1 packet summary (files with status/bytes, omitted, blockers, search count, limits), ground-truth coverage flags.
- **result:** `gateResult`, full `xResult`, final patch, `--numstat`.
- **scoring:** independent validator command, exit, duration, tampering and scope checks.
- **classification:** outcome, primary cause, all tags with class D/H/R and evidence pointers, review status.

## Decisions this audit surfaces (for you, not made here)

1. **Validator shape.** Gold candidates' `validation.required` must match `node --test scripts/test-*.mjs`. `070e9850b1` needs checking (see finding 2). This constrains Step 4/5 candidate selection.
2. **Test visibility.** For X to have a meaningful `validation.required`, the baseline must contain the new/updated test file from the fix commit. That shows X the expected behavior, so it belongs to the spec, not to hidden ground truth. The alternative (hidden test, X validates against an old test that already passes) gives X no failure signal. Decide before the runner.
3. **Provider tap.** Accept a fragile, optional wrapper for token counts, or rely on prompt-size estimates.
4. **Control run cost.** The "oracle context" control roughly doubles the cost of failed runs only.

## Not verified

- Every branch body of `result-gate.mjs` and every method body of `run-store.mjs` (header, statuses, schema, and the reason-code inventory were read; the classification bodies were not read line by line).
- That a recording `ModelAdapter` and a pre-call `loadTaskContext` are observationally identical to production behavior across all task shapes.
- That `node --test` runs the plain-script test files (`test-updater.mjs`, `test-bridge.mjs`) with correct pass/fail semantics.
- The Ollama silent-truncation hypothesis (finding 3), and the Ollama version's truncation behavior.
- That `provider.request` remains a stable instance method for the optional tap.
