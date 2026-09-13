# X Executor v1 — Canonical Implementation Spec

Status: **DESIGN FROZEN — AUDIT BEFORE IMPLEMENTATION**  
Date: 2026-09-13  
Repository: `seasonday41-bot/Hearth-Control`  
Implementation branch: `feature/x-executor-v1`  
Baseline source commit: `6f9baa073aeba9c77c23756d5493daff65837dad`

> **AUDIT TO CONFIRM. DO NOT REIMPLEMENT VALIDATED HEARTH LIFECYCLE BEHAVIOR. BUILD X AROUND THE STABLE RUNTIME, NOT THROUGH IT.**

> **IMPLEMENT THIS SPEC. DO NOT REDESIGN STABLE HEARTH COMPONENTS UNLESS NEW FAILING RUNTIME EVIDENCE PROVES A REGRESSION.**

> **AUDIT THE ACTUAL CURRENT SOURCE BEFORE CODING. Existing implementation and validated runtime evidence win over assumptions in this document. Report mismatches before changing stable architecture.**

---

## 1. Mission

X is a **Local Coding Executor**, not a general chat assistant.

```text
User
  ↓
ChatGPT / Sol / Astra
Brain / Architect / Supervisor / Teacher
  ↓
x-task-v1
  ↓
Remote / Supabase task queue
  ↓
Hearth
Trusted Execution Layer
  ↓
X + Local Coder
Inspect / Diagnose / Edit / Test / Repair / Verify
  ↓
x-result-v1
  ↓
ChatGPT / Sol / Astra
Review / Revision / Teaching
  ↓
User
```

Core rule:

> **ChatGPT / Sol / Astra = THINK**  
> **X = CODE**  
> **Hearth = EXECUTE + CONTROL**  
> **Supabase = TASK TRANSPORT / PERSISTED TASK STATE**  
> **Hearth local durable store = IN-FLIGHT PROCESS / JOB / CONTINUATION TRUTH**  
> **Tests + Evidence = TRUTH**

Primary objective:

- move routine coding execution off cloud models
- allow coding work to continue while cloud quota is unavailable
- keep high-level reasoning, architecture, ambiguity and review with supervisors
- keep Hearth as the trusted runtime, safety boundary, process owner and recovery layer

---

## 2. Stable Hearth Baseline — Validated, Preserve

Validated baseline:

- Hearth version: `v0.4.3`
- build: `0.4.3-20260912150720-3bd6ad`
- Local AI Test Runner branch: `feature/local-ai-test-runner-v0.2`
- validated commit: `6f9baa073aeba9c77c23756d5493daff65837dad`

### Evidence of record

Canonical baseline evidence is stored in:

`docs/STABLE_BASELINE.md`

That artifact records validation on **2026-09-12**:

- targeted continuation/recovery: **18/18 PASS**
- full regression: **316/316 PASS**
- Native Smoke #9 durable worker: **460089 ms, exit code 0, PASS**
- baseline build/artifact hashes are recorded in the same file

The Local AI Test Runner v0.2 validation associated with the baseline also recorded:

- Test Runner: `37/37`
- Local Chat: `9/9`
- Local Skills / grounding: `46/46`
- Context Builder: `24/24`
- Context Inspector: `7/7`
- Local Provider: `34/34`
- Provider Selection: `8/8`
- production build / typecheck: PASS
- `git diff --check`: PASS
- no stale test processes
- working tree clean

### Status

**Continuation/recovery is treated as VALIDATED, not as an open design task.**

The implementation agent must audit that the validated invariants still exist in the actual source and tests, but must not reimplement or redesign them unless a new failing runtime test provides evidence of regression.

Stable components that must not be casually redesigned:

- Durable Job Runtime
- JobManager ownership
- worker process ownership
- heartbeat lifecycle
- persisted durable-job state
- continuation bridge
- startup/historical recovery and reconciliation behavior already proven by runtime tests
- existing Remote transport that already works

Validated continuation path to preserve conceptually:

```text
job_completed
  ↓
continuationRunner
  ↓
resumeAntigravityTask
  ↓
same taskId / conversationId
  ↓
durableJobEvidence
  ↓
parent reaches final outcome
```

Lifecycle invariants to audit and preserve:

- while a durable worker is still running, provider-level interim `waiting` must not incorrectly move its parent task to `WAITING`; parent remains `RUNNING`
- startup recovery reconciles persisted non-terminal parents whose durable jobs are already terminal
- continuation is claimed before `resumeAntigravityTask` so a terminal durable job is not resumed twice
- persisted recovery evidence, not replay of an already-lost historical event, drives missed-event recovery

If the audit needs to prove a more detailed sub-case than the baseline evidence artifact states, inspect the actual targeted tests/runtime evidence before claiming it is proven.

---

## 3. Final Architecture

```text
Supervisor
  ↓ x-task-v1
Supabase task queue
  ↓ realtime event
Hearth Serial Dispatcher
  ↓ task execution claim + lease
X Local Executor
  ↓
INSPECT
  ↓
DIAGNOSE
  ↓
ROOT CAUSE
  ↓
EDIT / PATCH
  ↓
TEST / BUILD / TYPECHECK
  ↓
REPAIR
  ↓
VERIFY
  ↓
GIT DIFF
  ↓
CHECKPOINT / RESULT
  ↓ x-result-v1
Deterministic Result Gate
  ├─ COMPLETED
  ├─ NEEDS_REVIEW
  └─ FAILED
```

Concurrency policy for v1:

```text
MAX_ACTIVE_TASKS = 1
MAX_LLM_WORKERS = 1
MAX_REPAIR_TASKS = 1
```

A new task may begin only after the active task reaches a safe state.

Correctness and recoverability are more important than throughput.

### Two different claims — do not conflate them

1. **Task execution claim/lease**
   - belongs to the serial dispatcher / queue
   - prevents the same queued coding task from executing twice
   - enforces `MAX_ACTIVE_TASKS = 1` across duplicate realtime delivery, restart or competing dispatcher processes

2. **Durable continuation claim**
   - belongs to validated Hearth continuation/recovery
   - prevents duplicate `resumeAntigravityTask` for the same completed durable job

The continuation claim does **not** replace the task execution claim, and the serial policy does **not** replace continuation correctness.

---

## 4. Executor Interface

Hearth depends on an executor contract rather than hard-coding one provider implementation.

Conceptual interface:

```ts
interface Executor {
  run(task): Promise<ExecutorResult>
  resume(task, checkpoint): Promise<ExecutorResult>
  stop(taskId): Promise<void>
}
```

Normalized executor outcomes remain compatible with Hearth:

- `completed`
- `waiting`
- `error`

Purpose:

- allow LocalExecutor to become default later
- preserve Anti as fallback during migration
- avoid redesigning Hearth when switching execution engines

---

## 5. ModelAdapter and Local Model Policy

X sits behind a `ModelAdapter`; changing the local model must not change the Executor contract.

Bring-up policy:

- primary target: coding-focused model around **14B**, quantized appropriately for the current Mac
- existing Qwen 8B remains temporary fallback
- exact 14B default is pinned only after runtime evidence on the target M5 16GB machine
- do not benchmark many models before Core E2E works

Runtime selection evidence:

- task completion quality
- repair count
- latency
- memory pressure
- swap usage
- stability during long serial runs

Runtime policy:

- one local model instance at a time
- one coding task at a time
- targeted repository context, not whole-repo dumping
- start with moderate context and expand only when evidence requires it

---

## 6. x-task-v1 Contract

Supervisor sends structured tasks, not vague instructions.

Required contract:

```yaml
version: x-task-v1

task_id: string
parent_task_id: string | null
revision: integer
attempt: integer
based_on_result_id: string | null

objective: string
problem: string
expected_behavior: string
observed_behavior: string
why_this_matters: string

known_evidence: []
suspected_area: []

workspace:
  repo: string
  root: string

scope:
  allowed_paths: []
  preferred_files: []
  forbidden_paths: []

constraints:
  preserve: []
  do_not: []

allowed_tools: []

verification:
  required: []
  optional: []

done_criteria: []
teaching_notes: []

uncertainty:
  policy: bounded_autonomy
  stop_conditions: []

commit_policy:
  mode: never | require_user_approval | after_tests

timing:
  estimated_minutes: integer
  first_check_after_minutes: integer
  soft_deadline_minutes: integer
  hard_timeout_minutes: integer
```

Task-writing rules:

- explain user intent
- explain current incorrect behavior
- define expected behavior
- explain why it matters
- include known evidence and suspected area
- define what X may change and what it must preserve
- define required validation and DONE criteria
- specify desired behavior rather than forcing a guessed implementation unless implementation itself is a requirement

---

## 7. LocalExecutor Loop

```text
INSPECT
  ↓
DIAGNOSE
  ↓
ROOT CAUSE
  ↓
EDIT / PATCH
  ↓
TEST / BUILD / TYPECHECK
  ↓
REPAIR
  ↓
VERIFY
  ↓
GIT DIFF
  ↓
RESULT / CHECKPOINT
```

Before meaningful edits, X records concise auditable observations:

- current behavior observed
- likely root cause
- relevant files
- whether planned edits remain inside scope

Do not store hidden chain-of-thought. Store only evidence and auditable observations.

Repair budget:

- initial implementation = attempt 1
- repair 1 = attempt 2
- repair 2 = attempt 3
- maximum total implementation attempts = **3**

After budget exhaustion, do not widen scope or refactor unrelated code merely to make tests green.

---

## 8. Tool and Workspace Safety

Allowed v1 tool families:

- workspace-scoped filesystem read
- workspace-scoped search
- workspace-scoped edit/patch
- approved Test Runner profiles
- explicitly registered build/typecheck/lint profiles
- Git inspection
- bounded local Git mutation according to commit policy

### Workspace boundary

Every path must be resolved to a real path and validated against the configured workspace root.

Defend against:

- `../` traversal
- absolute paths outside workspace
- symlink escape
- implicit cwd escape

### Command execution

Never execute arbitrary model-generated shell strings.

Use:

- registered command profiles
- executable + argv arrays
- `execFile` / `spawn`
- no shell interpolation by default
- explicit cwd
- bounded environment
- output and timeout limits

`npm run` is permitted only for pre-registered script names. If `npx` is ever required, use a pre-registered profile that cannot install arbitrary packages (for example, an audited `--no-install` profile); never expose free-form `npx` to the model.

### Permanent owner-only actions

These are never automatically approved, including during Autopilot:

- delete important files/data
- destructive reset
- force push
- push
- merge to main/stable
- deploy/publish
- secrets/credential changes
- destructive database actions

---

## 9. Secret Guard

Before anything leaves the machine or enters an external escalation bundle, block or redact likely secrets.

Minimum controls:

- path rules: `.env*`, `*.pem`, `*.key`, credentials/secrets files
- content rules: private keys, passwords, tokens, common provider/API key patterns, session data
- prefer bounded sanitized snippets over whole files

Do not rely on the model to remember secret handling.

---

## 10. Decision Boundary

X may decide implementation details only when all are true:

1. inside approved scope
2. reversible
3. no public behavior change outside acceptance criteria
4. repository/test evidence supports the decision

X may decide:

- local implementation details inside scope
- naming following project conventions
- small reversible scoped refactors
- tests that prove specified behavior
- fixing lint/type/test failures introduced by X
- inspecting more files inside allowed scope

X must stop/escalate for:

- public API/contract change
- architecture decision
- business-logic ambiguity
- security/auth/RLS decision
- database schema/migration decision
- new dependency requirement
- root cause outside allowed scope
- materially different requirement interpretations
- destructive/external owner-only action
- repair budget exhaustion
- missing evidence needed to continue safely

Reason codes:

```text
AMBIGUOUS_REQUIREMENT
SCOPE_EXPANSION_REQUIRED
PUBLIC_CONTRACT_CHANGE_REQUIRED
ARCHITECTURE_DECISION_REQUIRED
BUSINESS_LOGIC_CONFLICT
SECURITY_DECISION_REQUIRED
DATABASE_CHANGE_REQUIRED
DEPENDENCY_CHANGE_REQUIRED
DESTRUCTIVE_ACTION_REQUIRED
EXTERNAL_ACTION_APPROVAL_REQUIRED
VALIDATION_FAILED
ROOT_CAUSE_OUTSIDE_SCOPE
TASK_REPLAN_REQUIRED
MISSING_REQUIRED_CONTEXT
HARD_TIMEOUT_CHECKPOINT
```

---

## 11. Deterministic Result Gate

The model does not declare itself successful.

Evidence of record:

- command exit codes
- bounded stdout/stderr evidence
- actual Git diff
- registered validation results
- Hearth runtime/process state
- task acceptance/DONE criteria

### COMPLETED

All must be true:

- all required validations actually ran
- all required validations passed
- DONE criteria satisfied
- diff inside approved scope
- no forbidden/destructive action
- no unresolved blocker
- required diff checks pass
- result evidence internally consistent

### NEEDS_REVIEW

Use when supervisor judgment is required, including:

- root cause not sufficiently proven
- suspicious diff/scope
- relevant pre-existing failure
- hard timeout with safe checkpoint
- requirement ambiguity
- correct fix requires scope expansion
- architecture/security/business decision
- incomplete validation evidence for reasons not caused by X's patch

### FAILED

Use for objective execution failure:

- required validation fails because of X's change
- repair budget exhausted
- required build/typecheck/test remains red
- executor/tool error blocks continuation
- repository state cannot be safely verified
- task cannot produce a safe checkpoint/result

### Pre-existing failures

A failure that existed before X's change must not automatically classify the task as FAILED.

Record each relevant failure origin as:

- `introduced`
- `pre_existing`
- `unknown`

Material `pre_existing` or `unknown` evidence normally routes to NEEDS_REVIEW rather than falsely blaming X.

### Result Gate → Hearth Executor mapping

```text
COMPLETED    → hearth_outcome = completed
NEEDS_REVIEW → hearth_outcome = waiting
FAILED       → hearth_outcome = error
```

This mapping is allowed only with the waiting semantics in §13. A bare Hearth `waiting` value must never be treated as sufficient evidence that a durable continuation should run.

Cancellation is a Hearth task-lifecycle action, not a Result Gate branch. If the owner/system cancels a task, Hearth persists cancellation/checkpoint state separately; X must not fabricate COMPLETED/NEEDS_REVIEW/FAILED for a cancelled task.

---

## 12. x-result-v1 Contract

There is one explicit result schema; status semantics are not implicit.

```yaml
version: x-result-v1

result_id: string
task_id: string
parent_task_id: string | null
revision: integer
attempt: integer

# Deterministic Result Gate decision
gate_status: COMPLETED | NEEDS_REVIEW | FAILED

# Normalized Executor outcome returned to Hearth
hearth_outcome: completed | waiting | error

# Required when hearth_outcome=waiting; otherwise null
waiting_reason:
  supervisor_review |
  owner_approval |
  external_dependency |
  null

reason_code: string | null

root_cause: string | null
evidence_found: []

files_changed: []
change_summary: []
why_fix_works: string | null

validation:
  - name: string
    required: boolean
    status: passed | failed | not_run
    exit_code: integer | null
    failure_origin: introduced | pre_existing | unknown | null
    stdout_ref: string | null
    stderr_ref: string | null

repair_attempts: integer

final_diff_summary:
  files_changed: integer
  insertions: integer | null
  deletions: integer | null

commit:
  created: boolean
  sha: string | null
  branch: string | null

lesson_candidate: object | null
remaining_risks: []
blockers: []
next_recommended_action: string | null

timing:
  estimated_minutes: integer | null
  actual_minutes: number | null
  validation_minutes: number | null
  repair_minutes: number | null
```

Deterministic invariants:

- `gate_status=COMPLETED` iff `hearth_outcome=completed`
- `gate_status=NEEDS_REVIEW` iff `hearth_outcome=waiting`
- `gate_status=FAILED` iff `hearth_outcome=error`
- `waiting_reason` is non-null only for `hearth_outcome=waiting`
- full terminal logs are not embedded; use bounded local artifact references

---

## 13. Supabase Task Queue, Hearth Durable State, and Waiting Semantics

### Source-of-truth split

Supabase is the source of truth for:

- remote task queue
- persisted task state
- result
- escalation
- revision chain

Hearth local durable storage is the source of truth for:

- owned in-flight process state
- durable job state/evidence
- continuation claim/recovery state
- local watchdog/checkpoint evidence needed for restart reconciliation

Do not infer process truth from Supabase task status alone.

### Task states

Supabase task states remain compatible with the existing task model:

- `queued`
- `running`
- `waiting`
- `completed`
- `failed`
- `cancelled`

For v0.1, `NEEDS_REVIEW` is represented as:

```yaml
task_status: waiting
waiting_reason: supervisor_review
pending_continuation: false
```

Owner approval is represented as:

```yaml
task_status: waiting
waiting_reason: owner_approval
pending_continuation: false
```

A durable job still running must remain conceptually:

```yaml
task_status: running
waiting_reason: null
pending_continuation: true
```

A provider-level interim `waiting` while the durable job still runs must not rewrite the parent task to `waiting`.

### Required semantic axes

Exact persisted field names must be confirmed by source audit, but the implementation must preserve equivalent independent semantics for:

```text
task_status
waiting_reason
pending_continuation
continuation_claim_state
```

Conceptual continuation claim states:

```text
none | not_started | in_progress | completed
```

### Reconciliation eligibility

Startup/historical continuation reconciliation must be driven by continuation evidence, not by `task_status == waiting`.

Conceptual eligibility:

```text
parent is non-terminal
AND persisted durable job is terminal
AND pending_continuation == true
AND continuation_claim_state != completed
```

A review wait such as:

```yaml
task_status: waiting
waiting_reason: supervisor_review
pending_continuation: false
```

must never enter the durable continuation path.

### Atomic task claim + lease

Even with one active coding task, task execution claim/lease remains required because:

- duplicate Realtime delivery is possible
- restart/recovery can race with normal dispatch
- multiple dispatcher processes can briefly exist

This claim is separate from the validated durable continuation claim described in §3.

### Minimal Supabase writes

Normal operation does not persist every progress step.

Typical writes:

- queued/task creation
- claimed/running
- final completed/waiting/failed
- recovery checkpoint only when required

Local progress stays local unless recovery requires persistence.

---

## 14. Event-Driven Task Timing v1

Principle:

> **Event = normal operation**  
> **Local timer = watchdog**  
> **Supabase = persistence + recovery**  
> **Query = exception, not heartbeat**

```text
TASK CREATED
  ↓
Realtime Event
  ↓
HEARTH TASK CLAIM + LEASE
  ↓
RUNNING + local timers
  ↓
X EXECUTES
  ├─ local progress events
  ├─ first-check timer
  ├─ soft-deadline timer
  └─ hard-timeout timer
```

First Check:

- confirm real progress
- confirm worker health
- estimate remaining work
- inspect local runtime state; do not poll Supabase to ask if the owned worker is alive

Soft Deadline:

- assess healthy-but-slow work
- allow bounded extension when evidence shows progress
- detect repeated failure loops or inactivity
- soft deadline is not failure

Hard Timeout:

- do not blindly kill X in the middle of a file write/transaction
- request a safe checkpoint containing stage, progress, evidence/root cause, files/diff, completed/remaining validations, repair attempts and next action
- classify as NEEDS_REVIEW or FAILED based on evidence
- if an owned process is still running, explicitly record that fact; a timer event alone never proves the process stopped

---

## 15. Autopilot v1

Autopilot is in v1 because unattended execution is a core reason X exists.

**Do not implement or enable Autopilot until Core E2E and safety gates are proven.**

States:

- `ON`
- `DRAINING`
- `OFF`

ON:

- may claim new runnable tasks
- execute serially
- completed → next task
- waiting/needs-review/failed → persist evidence and move to next independent runnable task

DRAINING:

- stop claiming new tasks
- let current operation reach safe checkpoint
- persist checkpoint/result
- then OFF

OFF:

- no unattended claims
- owner/supervisor review mode

Owner-return command concept:

```text
"ผมมาแล้ว" → OWNER_RETURNED
```

```text
ON
  ↓
DRAINING
  ↓
stop new claims
  ↓
current task → safe checkpoint
  ↓
OFF
  ↓
one batch query for unresolved tasks
```

No continuous Supabase polling during Autopilot.

---

## 16. Escalation Bundle

When X cannot safely continue:

```yaml
task_id: string
revision: integer
status: waiting | failed

escalation:
  required: true
  target: sol | astra | codex | owner
  reason_code: string

problem_summary: string
root_cause_observed: string | null
files_inspected: []
files_changed: []
attempts: []
validation: []
errors: []
current_diff_summary: object
recommended_action: string | null
```

If `gate_status=NEEDS_REVIEW`, persist `status=waiting` with an explicit `waiting_reason` such as `supervisor_review` or `owner_approval`.

Goal: supervisor sees what X inspected, changed, tried and proved without restarting investigation from zero.

During unattended execution, do not automatically call cloud models for every escalation; keep unresolved tasks for batched review.

---

## 17. Revision Chain

Meaningful supervisor revisions create a new revision rather than overwriting history.

```text
TASK-008 rev1
  ↓
RESULT-008-R1
  ↓
Supervisor review
  ↓
TASK-008 rev2
```

Persist:

- `task_id`
- `parent_task_id`
- `revision`
- `attempt`
- `based_on_result_id`

X should see previous attempts, why they failed, what was tried, and what changed in the revised task.

---

## 18. Commit Policy

Bring-up:

```yaml
commit_policy:
  mode: require_user_approval
```

Selected Autopilot tasks may switch to:

```yaml
commit_policy:
  mode: after_tests
```

only after:

- Core E2E PASS
- serial multi-task smoke PASS
- zero false completion in validation set
- safety tests PASS
- recovery stable

Always blocked automatically:

- push
- merge main/stable
- deploy/publish
- force push
- destructive reset
- delete important files/data

Prefer one task = one bounded local commit when auto-commit is enabled.

---

## 19. Learning and Project Knowledge

X learns **why**, not only patches.

```text
Execute
  ↓
Verify
  ↓
Explain Root Cause
  ↓
Lesson Candidate
  ↓
Supervisor Review
  ↓
Validated Lesson
  ↓
Reuse
```

A symptom disappearing is not a validated lesson.

Reusable lesson requires:

- expected behavior / user intent
- actual failure
- root cause
- why fix is correct
- evidence
- proving tests
- reusable rule
- supervisor validation

`lesson_candidate` exists in x-result-v1 from the beginning, but automated lesson promotion and a separate X knowledge database are not Core E2E requirements.

---

## 20. X Consult

X Consult is a high-cost/manual review path for important decisions, not routine implementation.

Direction:

- Round 1 independent review
- Round 2 cross-review
- consolidate into CONSENSUS / ONLY / DISAGREEMENT / FINAL ACTIONS (P0/P1/P2)

Automated XGEN/LiteLLM routing is a later, separately audited capability.

---

## 21. Anti → Local Migration

Do not remove Anti before LocalExecutor proves reliability.

1. preserve/freeze validated Hearth baseline
2. add Executor interface
3. implement LocalExecutor v0.1
4. Local becomes default; Anti remains fallback
5. remove Anti only after evidence threshold

Removal evidence target:

- representative local completion rate `>= 80–90%`
- false completion `0`
- destructive change `0`
- unattended serial runs stable
- recovery stable

---

## 22. Resource Policy for Current Mac

Prioritize stability over throughput:

```text
one task at a time
one local coding model at a time
no parallel coding workers
```

Before next task, Hearth may check locally:

- memory pressure acceptable
- disk free space acceptable
- no stale owned worker
- repository state safe
- local model healthy

Pause rather than forcing another task under unsafe resource pressure.

Do not hard-code permanent thresholds before collecting real runtime evidence.

---

## 23. Implementation Order

### P0 — required before X is usable

1. audit actual branch/source/test state
2. confirm validated Hearth lifecycle invariants and evidence; do not reimplement them
3. Executor interface
4. ModelAdapter
5. x-task-v1 parser/validator
6. serial dispatcher (`MAX_ACTIVE_TASKS=1`)
7. task execution claim + lease
8. scoped Context/Repo Loader
9. LocalExecutor inspect/diagnose/edit loop
10. approved validation runner integration
11. repair budget
12. Decision Boundary
13. deterministic Result Gate
14. x-result-v1
15. waiting-reason / continuation semantic separation
16. escalation bundle
17. revision chain
18. event-driven timing/watchdog
19. safe checkpoint
20. Remote → Supabase → Hearth → X → Result Core E2E
21. commit policy enforcement
22. Autopilot `ON → DRAINING → OFF`
23. owner-return (`"ผมมาแล้ว"`) flow
24. serial unattended smoke
25. final regression/build/diff validation
26. freeze new stable baseline

Not on critical path:

- full long-term memory
- automated lesson promotion
- separate X knowledge database
- multi-agent
- browser/computer use
- mobile
- voice/JARVIS
- parallel workers
- broad UI redesign
- multi-user expansion
- broad multi-model benchmark suite

---

## 24. Required E2E Proof

### A — successful coding task

```text
Remote
  ↓
x-task-v1
  ↓
Supabase queued
  ↓
Hearth task claim
  ↓
X inspects real repo
  ↓
X edits real source
  ↓
required validation
  ↓
repair if required
  ↓
git diff verified
  ↓
x-result-v1
  ↓
completed
  ↓
Remote sees result
```

### B — unresolved task does not block queue

```text
Task A → completed
Task B → waiting + waiting_reason=supervisor_review
Task C → completed
```

### C — owner-only action

Push/deploy/destructive action stops for owner approval.

### D — hard timeout

Hard timeout produces a safe checkpoint and deterministic state; it does not blindly kill work or lose evidence.

### E — Autopilot drain

```text
Autopilot ON
  ↓
serial tasks
  ↓
OWNER_RETURNED / "ผมมาแล้ว"
  ↓
DRAINING
  ↓
no new claims
  ↓
current task safe checkpoint
  ↓
OFF
  ↓
unresolved batch available
```

### F — waiting semantic isolation

Prove all three independently:

1. durable worker still running → parent remains `running`, no review wait
2. terminal durable job with pending continuation → reconciliation may resume exactly once
3. X NEEDS_REVIEW → `waiting + waiting_reason=supervisor_review + pending_continuation=false` and must **not** enter durable continuation reconciliation

---

## 25. Definition of Done

X Executor v1 is DONE only when:

- stable Hearth runtime behavior preserved
- baseline evidence linked and source audit completed
- LocalExecutor reads scoped repository context
- LocalExecutor makes bounded edits
- required validation runs through approved tools
- repair budget enforced
- deterministic Result Gate works
- x-result-v1 schema and mapping are enforced
- false model-declared success is impossible without evidence
- serial execution enforced
- task execution claim prevents duplicate task execution
- durable continuation claim remains independently correct
- review waiting cannot trigger durable continuation
- timing/watchdog works without Supabase polling loops
- safe checkpoint works
- escalation bundle contains useful evidence
- revision chain works
- Remote submits and observes final result
- unresolved task does not halt independent queued work
- owner-only actions remain blocked
- Autopilot ON/DRAINING/OFF works after Core E2E
- final regression passes
- production build/typecheck passes
- `git diff --check` passes
- no stale owned processes remain
- new baseline documented/frozen

Representative acceptance target after bring-up:

- run 10 representative coding tasks
- `>= 7/10` completed locally
- unresolved tasks correctly escalated
- false completion `0`
- unintended destructive changes `0`
- secret leakage `0`
- restart/resume correct
- every task produces diff + validation + result evidence

---

## 26. Implementation Guardrails for Agents

When Anti, Codex, Claude Code, Sol, Astra or another agent implements this spec:

1. audit actual source first
2. do not restart architecture design from scratch
3. do not rewrite Durable Job Runtime without new failing runtime evidence
4. treat `docs/STABLE_BASELINE.md` as the baseline evidence index and inspect actual tests/source for any detailed invariant being claimed
5. keep task execution claim and durable continuation claim separate
6. never use bare `status=waiting` as a continuation trigger
7. prefer adapters/narrow interfaces over invasive rewrites
8. keep changes scoped and reversible
9. run targeted tests after each bounded phase
10. run broader regression before declaring a phase complete
11. never claim a test/build ran unless it actually ran
12. distinguish pre-existing failures from introduced failures
13. do not merge to main merely to begin X work
14. do not push/deploy/delete unless explicitly approved
15. use runtime evidence to resolve uncertainty

If this document conflicts with proven current runtime behavior, stop, record the mismatch and evidence, and request a decision before modifying stable architecture.

---

## 27. Final Principle

The system succeeds when the user can hand over a queue of coding tasks, leave the machine unattended, and return to:

- completed tasks with real test evidence
- bounded local commits when policy allows
- unresolved tasks preserved with useful evidence
- no silent destructive actions
- no false completion
- no need for continuous cloud-model supervision

```text
User sets goal
  ↓
Supervisor creates precise tasks
  ↓
X executes locally for as long as possible
  ↓
Hearth enforces safety + truth
  ↓
Only unresolved/novel decisions return to Sol/Astra/Codex
```

That is the purpose of X Executor v1.
