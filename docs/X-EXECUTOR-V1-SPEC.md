# X Executor v1 — Master Implementation Spec

Status: **LOCKED FOR IMPLEMENTATION**  
Date: 2026-09-13  
Repository: `seasonday41-bot/Hearth-Control`  
Implementation branch: `feature/x-executor-v1`  
Baseline source commit: `6f9baa073aeba9c77c23756d5493daff65837dad`

> **IMPLEMENT THIS SPEC. DO NOT REDESIGN STABLE HEARTH COMPONENTS UNLESS NEW RUNTIME EVIDENCE PROVES A REGRESSION.**

> **AUDIT THE ACTUAL CURRENT SOURCE BEFORE CODING. Existing implementation and validated runtime evidence win over assumptions in this document. Report mismatches before changing stable architecture.**

---

## 1. Mission

X is a **Local Coding Executor**, not a general chat assistant.

Final role split:

```text
User
  ↓
ChatGPT / Sol / Astra
Brain / Architect / Supervisor / Teacher
  ↓
x-task-v1
  ↓
Remote / Hearth Supabase
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

Primary objective:

- move routine coding execution off cloud models
- allow coding work to continue while cloud quota is unavailable
- keep high-level reasoning, architecture, ambiguous decisions, and review with ChatGPT / Sol / Astra
- keep Hearth as the trusted runtime, safety boundary, process owner, and recovery layer

Core rule:

> **ChatGPT / Sol / Astra = THINK**  
> **X = CODE**  
> **Hearth = EXECUTE + CONTROL**  
> **Supabase = TRANSPORT / STATE**  
> **Tests + Evidence = TRUTH**

---

## 2. Stable Hearth Baseline — Preserve

Validated stable baseline:

- Hearth version: `v0.4.3`
- build: `0.4.3-20260912150720-3bd6ad`
- Local AI Test Runner v0.2 branch: `feature/local-ai-test-runner-v0.2`
- validated commit: `6f9baa073aeba9c77c23756d5493daff65837dad`

Final validation at that baseline:

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
- working tree: clean

### Stable components that must not be casually redesigned

- Durable Job Runtime
- JobManager ownership
- worker process ownership
- heartbeat lifecycle
- persisted durable-job state
- continuation bridge
- recovery / reconciliation behavior already proven by runtime tests
- existing Remote transport that already works

The validated continuation path must remain conceptually intact:

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
parent task reaches final state
```

Important lifecycle invariant:

- while a durable job is still running, a provider-level interim `waiting` response must **not** incorrectly move the parent task to `WAITING`
- startup recovery must reconcile persisted non-terminal parents whose durable jobs are already terminal

Do not reopen these designs unless new runtime evidence demonstrates a regression.

---

## 3. Final Architecture

```text
Supervisor
  ↓ x-task-v1
Supabase task queue
  ↓ realtime event
Hearth
  ↓ atomic claim + lease
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
Result Gate
  ├─ COMPLETED
  ├─ NEEDS_REVIEW
  └─ FAILED
```

Concurrency for v1:

```text
MAX_ACTIVE_TASKS = 1
MAX_LLM_WORKERS = 1
MAX_REPAIR_TASKS = 1
```

A new task must not begin until the current task reaches a safe state:

- `completed`
- `needs_review`
- `waiting`
- `failed`
- `cancelled`

Correctness and recoverability are more important than throughput.

---

## 4. Executor Interface

Hearth should depend on an executor contract rather than hard-code one provider implementation.

Conceptual interface:

```ts
interface Executor {
  run(task): Promise<ExecutorResult>
  resume(task, checkpoint): Promise<ExecutorResult>
  stop(taskId): Promise<void>
}
```

Normalized executor terminal outcomes:

- `completed`
- `waiting`
- `error`

Purpose:

- allow LocalExecutor to become default later
- preserve Anti as fallback during migration
- avoid redesigning Hearth when switching execution engines

---

## 5. ModelAdapter and Local Model Policy

X must sit behind a `ModelAdapter` so model choice is replaceable without changing the executor contract.

Current preferred direction:

- primary target: coding-focused model around **14B**, quantized appropriately for the current Mac
- existing 8B model remains temporary fallback
- final selection is based on **runtime evidence**, not model-name preference

Runtime selection evidence should include:

- task completion quality
- required repair count
- latency
- memory pressure
- swap usage
- stability during long serial runs

Initial runtime policy:

- one local model instance at a time
- one coding task at a time
- avoid large context unless required
- start with targeted repository context instead of loading the entire repository

Do not benchmark many models before Core E2E works.

---

## 6. x-task-v1

Supervisor must send a structured task, not a vague instruction such as "fix this file".

Required fields:

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

commit_policy:
  mode: never | require_user_approval | after_tests

timing:
  estimated_minutes: integer
  first_check_after_minutes: integer
  soft_deadline_minutes: integer
  hard_timeout_minutes: integer
```

### Task-writing principles

A task must explain:

- what the user wants
- what is currently wrong
- what correct behavior looks like
- why the behavior matters
- what evidence is already known
- where X should inspect first
- what X may change
- what X must preserve
- how success will be verified
- what counts as DONE

The supervisor should specify desired behavior, not force a guessed implementation unless implementation itself is a requirement.

---

## 7. X Execution Loop

Required high-level loop:

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

### Evidence before modification

Before meaningful edits, X should be able to state machine-verifiable observations such as:

- current behavior observed
- likely root cause
- relevant files
- whether planned edits remain inside scope

Do not store hidden reasoning or chain-of-thought. Store only concise, auditable observations and evidence.

### Repair budget

Interpretation:

- initial implementation = attempt 1
- repair attempt 1 = attempt 2
- repair attempt 2 = attempt 3
- maximum total implementation attempts = **3**

After the repair budget is exhausted, do not keep widening scope or refactoring unrelated code.

---

## 8. Tool and Workspace Safety

X tools are intentionally constrained.

Allowed tool families for v1:

- workspace-scoped filesystem read
- workspace-scoped search
- workspace-scoped edit / patch
- approved Test Runner profiles
- approved build / typecheck / lint profiles where explicitly registered
- Git inspection
- bounded local Git mutation according to commit policy

### Workspace boundary

Every filesystem path must be resolved to a real path and validated against the configured workspace root.

Must defend against:

- `../` traversal
- absolute paths outside the workspace
- symlink escape
- implicit cwd changes outside workspace

### Command execution

Do not execute arbitrary model-generated shell strings.

Preferred safety model:

- registered command profiles
- structured executable + argument arrays
- `execFile` / `spawn`
- no shell interpolation by default
- explicit cwd
- bounded environment
- output and timeout limits

### Permanent destructive-action rule

Automatic deletion is never allowed.

The following always require explicit owner approval and must never be auto-approved by Autopilot:

- delete important files or data
- destructive Git reset
- force push
- push
- merge to stable/main
- deploy / publish
- secrets changes
- credential changes
- destructive database actions

---

## 9. Secret Guard

Before any content leaves the local machine or is included in an external escalation bundle, redact or block likely secrets.

Minimum guard patterns:

- `.env*`
- `*.pem`
- `*.key`
- private keys
- tokens
- passwords
- credentials files
- common API key formats
- provider session data

Use path-based blocking plus content-based detection.

Do not rely on the model to remember secret handling.

---

## 10. Decision Boundary

X may decide implementation details autonomously only when all are true:

1. change remains inside approved scope
2. change is reversible
3. public behavior outside acceptance criteria is unchanged
4. repository/test evidence supports the decision

### X may decide itself

Examples:

- local implementation choice inside scope
- variable/function naming following project conventions
- small reversible refactor necessary for the scoped fix
- test additions that prove specified behavior
- fixing lint/type/test failures introduced by X's own change
- inspecting more files inside allowed scope

### X must stop and escalate

Examples:

- public API or contract change
- architecture decision
- business-logic ambiguity
- security/auth/RLS decision
- database schema/migration decision
- new dependency requirement
- root cause outside allowed scope
- materially different interpretations of requirement
- destructive action
- external action requiring owner authorization
- repair budget exhausted
- missing evidence needed to safely continue

Suggested reason codes:

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

The model does not get to declare itself successful.

Command exit codes, actual Git diff, Hearth runtime state, registered validation results, and task criteria are the evidence of record.

### COMPLETED

All required conditions must be true:

- all required validation commands actually ran
- all required validation commands passed
- DONE criteria are satisfied
- diff remains within approved scope
- no forbidden or destructive action occurred
- no unresolved blocker remains
- required diff checks pass
- result evidence is internally consistent

### NEEDS_REVIEW

Use when implementation may be usable but supervisor judgment is required, including:

- root cause not sufficiently proven
- diff or scope is suspicious
- a relevant failure appears pre-existing
- hard timeout occurred but safe checkpoint succeeded
- requirement remains ambiguous
- correct fix requires scope expansion
- architecture/security/business decision is required
- validation evidence is incomplete for reasons not caused by X's patch

### FAILED

Use when execution objectively failed, including:

- required validation fails because of X's change
- repair budget exhausted
- required build/typecheck/test remains failing
- executor/tool error prevents continuation
- repository state cannot be safely verified
- task cannot produce a safe checkpoint/result

### Pre-existing failures

A failure that existed before X's change must not automatically classify the task as FAILED.

X must record evidence distinguishing:

- caused by this task
- clearly pre-existing
- unknown / insufficient evidence

Unknown or material pre-existing failures usually lead to `NEEDS_REVIEW`, not false blame on X.

---

## 12. x-result-v1

Required result structure:

```yaml
version: x-result-v1

task_id: string
parent_task_id: string | null
revision: integer
attempt: integer
status: completed | needs_review | waiting | failed | cancelled

root_cause: string | null
evidence_found: []

files_changed: []
change_summary: []
why_fix_works: string | null

tests_run: []
tests_passed: []
tests_failed: []

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

Do not dump full terminal logs into the result object. Store concise evidence and reference bounded local artifacts/log paths when needed.

---

## 13. Supabase Task Queue and Source of Truth

Supabase is the persistent task/state transport layer.

Expected task states:

- `queued`
- `running`
- `waiting`
- `completed`
- `failed`
- `cancelled`

`needs_review` may be represented either as a dedicated state if schema evolves, or as `waiting` plus deterministic review metadata. Do not create incompatible state duplication without an audit first.

### Atomic claim + lease

Even with one active task, atomic claim/lease remains required because:

- app restart can briefly create multiple processes
- recovery can race with normal dispatch
- duplicate Realtime delivery is possible
- multiple dispatchers must not execute one task twice

### Minimal Supabase writes

Normal operation should not persist every progress step.

Typical important writes:

- task created / queued
- task claimed / running
- final completed / waiting / failed
- recovery checkpoint only when necessary

Local progress events stay local unless persistence is required for recovery.

---

## 14. Event-Driven Task Timing v1

Normal operation is event-driven.

Principle:

> **Event = normal operation**  
> **Local timer = watchdog**  
> **Supabase = persistence + recovery**  
> **Query = exception, not heartbeat**

Conceptual flow:

```text
TASK CREATED
  ↓
Realtime Event
  ↓
HEARTH CLAIM + LEASE
  ↓
RUNNING + local timers
  ↓
X EXECUTES
  ├─ local progress events
  ├─ first-check timer
  ├─ soft-deadline timer
  └─ hard-timeout timer
```

### First Check

Purpose:

- confirm real progress
- confirm worker health
- estimate remaining work

Do not query Supabase merely to ask whether the worker is still running. Hearth already owns the process and should inspect local runtime state.

### Soft Deadline

Purpose:

- assess whether work is healthy but slower than expected
- allow a reasonable local extension when evidence shows progress
- detect repeated failed loops or no activity

Soft deadline is not failure.

### Hard Timeout

Hard timeout must not kill X in the middle of a file write or transaction unless there is no safer recovery option.

Request a safe checkpoint containing:

- current stage
- progress
- root cause/evidence discovered so far
- files changed
- current diff
- validation completed
- validation remaining
- repair attempts
- next recommended action

Then classify deterministically as `needs_review`, `waiting`, or `failed`.

Hard timeout does **not** automatically mean FAILED.

---

## 15. Autopilot v1

Autopilot is part of v1 because unattended execution is a core reason X exists.

However:

> **Do not implement or enable Autopilot until Core E2E and safety gates are proven.**

States:

- `ON`
- `DRAINING`
- `OFF`

### ON

- may claim new runnable tasks
- execute serially
- completed task → next task
- waiting/needs_review/failed task → persist evidence and move to next runnable independent task

### DRAINING

Entered when owner returns or Autopilot is asked to stop gracefully.

Behavior:

- stop claiming new tasks
- allow current operation to reach safe checkpoint
- persist checkpoint/result
- transition to OFF

### OFF

- no unattended claims
- owner/supervisor review mode

### Owner-return command

The phrase / command concept:

```text
"ผมมาแล้ว"
```

maps to an `OWNER_RETURNED` event.

Behavior:

```text
ON
  ↓
DRAINING
  ↓
stop new claims
  ↓
current task reaches safe checkpoint
  ↓
OFF
  ↓
one batch query for unresolved tasks
```

Unresolved batch should include only relevant states/reasons such as:

- needs review
- waiting
- failed
- timed out / checkpointed

Do not poll Supabase continuously for these during Autopilot.

---

## 16. Escalation Bundle

When X cannot safely continue, store a concise supervisor handoff.

Required information:

```yaml
task_id: string
revision: integer
status: waiting | needs_review | failed

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

Goal:

- supervisor must not restart investigation from zero
- supervisor sees what X inspected, changed, tried, and proved

During unattended execution, do not automatically call cloud models for every escalation. Keep unresolved work and batch-review it when appropriate.

---

## 17. Revision Chain

A revised task must preserve ancestry.

Example:

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

X should be able to see:

- what failed previously
- what was already tried
- why supervisor changed the task
- what new evidence/constraints now apply

Do not overwrite history in place when a meaningful supervisor revision is created.

---

## 18. Commit Policy

Initial policy during bring-up:

```yaml
commit_policy:
  mode: require_user_approval
```

After all of the following are proven:

- Core E2E PASS
- serial multi-task smoke PASS
- zero false completion in validation set
- safety tests PASS
- recovery stable

then selected Autopilot tasks may use:

```yaml
commit_policy:
  mode: after_tests
```

Even when local auto-commit is allowed, the following remain blocked automatically:

- push
- merge main/stable
- deploy
- publish
- force push
- destructive reset
- delete important files/data

Prefer one task = one bounded local commit when auto-commit is enabled.

---

## 19. Learning and Project Knowledge

X must learn **why**, not only patches.

Desired learning loop:

```text
Execute
  ↓
Verify
  ↓
Explain Root Cause
  ↓
Record Lesson Candidate
  ↓
Supervisor Review
  ↓
Validated Lesson
  ↓
Reuse
```

A patch that happens to make symptoms disappear is not a validated lesson.

A reusable lesson requires:

- user intent / expected behavior
- actual failure
- root cause
- why the fix is correct
- evidence
- tests that prove it
- general reusable rule
- supervisor validation

### v1 storage direction

X does not need a large personal-assistant memory system.

Useful long-term coding knowledge includes:

- architecture
- project conventions
- fragile areas
- validated root causes
- validated fixes
- test map
- build commands
- do-not-touch rules
- checkpoints
- lessons

A separate X knowledge store may be added later.

Do not mix long-term validated knowledge with noisy Hearth execution state unless deliberately referenced.

`lesson_candidate` belongs in `x-result-v1` from the beginning, but full automated lesson promotion is **not** required for Core v1 E2E.

---

## 20. X Consult

X Consult is a high-cost/manual review path, not the default coding loop.

Current direction:

- Round 1: independent review
- Round 2: cross-review
- consolidate into:
  - CONSENSUS
  - ONLY
  - DISAGREEMENT
  - FINAL ACTIONS (P0/P1/P2)

Use for important decisions, not routine implementation.

When automated later, it may route through existing XGEN/LiteLLM infrastructure after a separate audit.

---

## 21. Anti → Local Migration

Do not remove Anti before LocalExecutor proves reliability.

Migration phases:

1. freeze validated Hearth baseline
2. add Executor interface
3. implement LocalExecutor v0.1
4. Local becomes default; Anti remains fallback
5. remove Anti only after evidence threshold is reached

Suggested removal threshold:

- Local completion rate: `>= 80–90%` on representative real tasks
- false completion: `0`
- destructive change: `0`
- unattended serial runs stable
- recovery stable

---

## 22. Resource Policy for Current Mac

The current machine must prioritize stability over throughput.

Required v1 behavior:

```text
one task at a time
one local coding model at a time
no parallel coding workers
```

Before starting the next task, Hearth may perform a lightweight local resource guard:

- memory pressure acceptable
- disk free space acceptable
- no stale owned worker
- repository state safe
- local model healthy

If resource pressure is unsafe, pause rather than forcing another task.

Do not make resource thresholds permanent constants before observing real runtime behavior on the machine.

---

## 23. Implementation Order

Prioritize finish over features.

### P0 — must finish before calling X usable

1. audit actual current source and branch state
2. preserve/freeze validated Hearth runtime behavior
3. Executor interface
4. ModelAdapter
5. `x-task-v1` parser + validator
6. serial dispatcher (`MAX_ACTIVE_TASKS=1`)
7. atomic claim + lease
8. scoped Context / Repo Loader
9. LocalExecutor inspect/diagnose/edit loop
10. approved validation runner integration
11. repair budget
12. Decision Boundary
13. deterministic Result Gate
14. `x-result-v1`
15. escalation bundle
16. revision chain
17. event-driven timing + watchdog
18. safe checkpoint behavior
19. Remote → Supabase → Hearth → X → Result E2E
20. commit policy enforcement
21. Autopilot `ON → DRAINING → OFF`
22. owner-return (`"ผมมาแล้ว"`) flow
23. serial unattended smoke
24. final regression/build/diff validation
25. freeze new stable baseline

### Not on the critical path

- full long-term memory
- automated lesson promotion
- separate X Supabase knowledge database
- multi-agent
- browser/computer use
- mobile client
- voice/JARVIS
- parallel workers
- broad UI redesign
- multi-user expansion
- multi-model benchmark suite

---

## 24. Required E2E Proof

X is not considered usable because unit tests pass alone.

At minimum prove:

### Case A — successful coding task

```text
Remote
  ↓
x-task-v1
  ↓
Supabase queued
  ↓
Hearth claim
  ↓
X inspects real repo
  ↓
X edits real source
  ↓
required validation runs
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

### Case B — unresolved task does not block queue

```text
Task A → completed
Task B → needs_review / waiting
Task C → completed
```

Task B must not prevent independent Task C from running.

### Case C — owner-only action

Task requiring push/deploy/destructive action must stop and request owner approval.

### Case D — hard timeout

Hard timeout must produce a safe checkpoint and deterministic state, not blindly kill work and lose evidence.

### Case E — Autopilot drain

```text
Autopilot ON
  ↓
serial tasks execute
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
unresolved batch available for supervisor
```

---

## 25. Definition of Done

X Executor v1 is DONE only when all are true:

- stable Hearth runtime behavior preserved
- actual source audit completed
- LocalExecutor can read/inspect scoped repository context
- LocalExecutor can make bounded edits
- required tests/build/typecheck can run through approved tools
- repair budget enforced
- deterministic Result Gate works
- false model-declared success is impossible without evidence
- serial execution enforced
- atomic claim prevents duplicate task execution
- timing/watchdog works without Supabase polling loops
- safe checkpoint works
- escalation bundle persists useful evidence
- revision chain works
- Remote can submit and observe final result
- unresolved task does not halt independent queued work
- owner-only actions remain blocked
- Autopilot ON/DRAINING/OFF works after Core E2E
- final regression suite passes
- production build/typecheck passes
- `git diff --check` passes
- no stale owned processes remain
- stable baseline is documented/frozen

---

## 26. Implementation Guardrails for Agents

When Anti, Codex, Claude Code, Sol, Astra, or another coding agent implements this spec:

1. **Audit actual source first.**
2. **Do not restart architecture design from scratch.**
3. **Do not rewrite Durable Job Runtime without new failing runtime evidence.**
4. **Prefer adapters and narrow interfaces over invasive rewrites.**
5. **Keep changes scoped and reversible.**
6. **Run targeted tests after each bounded phase.**
7. **Run broader regression before declaring a phase complete.**
8. **Do not claim a test/build ran unless it actually ran.**
9. **Distinguish pre-existing failures from introduced failures.**
10. **Do not merge to main merely to begin X work.**
11. **Do not push/deploy/delete unless explicitly approved.**
12. **Use runtime evidence to resolve uncertainty.**

If this document conflicts with proven current runtime behavior, stop, record the mismatch and evidence, and request a decision before modifying stable architecture.

---

## 27. Final Principle

The system is successful when the user can hand over a queue of coding tasks, leave the machine unattended, and return to:

- completed tasks with real test evidence
- bounded local commits when policy allows
- unresolved tasks preserved with useful diagnostic evidence
- no silent destructive actions
- no false completion
- no need for continuous cloud-model supervision

The intended steady-state workflow is:

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
