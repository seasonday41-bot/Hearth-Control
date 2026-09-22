# Hearth Multi-Agent Router + Universal Ingress V1

> Historical design record. Anti/Antigravity has been removed from the active 0.4.24 product; references below describe prior architecture and must not be used as current operating instructions.

Status: P8 canonical design
Created: 2026-09-20
Baseline: main@d0278c4c6ba0f90fd895164fa268bcf7818a1730
Implementation branch: feature/p8-multi-agent-router-v1

## Goal

P8 adds one agent-agnostic ingress for supervisor/user-facing work:

```text
ส่งงาน: <what should be done>
        |
        v
hearth-job-v1
        |
        v
Hearth deterministic router
        |
        +--> X existing queue/runtime
        |
        +--> Antigravity existing TaskStore/runtime
        |
        +--> Codex specialist only through existing Goal specialist lifecycle
```

P8 does not create another executor, queue, durable job runtime, task store, or specialist runtime.

## Existing truth reused

The repository already contains:

- X queue + XRunStore + x-task-v1 / x-result-v1;
- Electron-owned TaskStore for Antigravity;
- shared X/Antigravity admission;
- JobManager durable worker runtime;
- Goal Runner;
- durable Review Queue;
- specialist handoff -> authorization -> JobManager/Codex dispatch -> result -> human accept/reject lifecycle;
- routing metadata on Antigravity tasks: requestedRoute, resolvedRoute, routeReason, routeTransitions.

P8 is therefore an ingress/adapter layer only.

## User-facing contract

Version:

```text
hearth-job-v1
```

Semantic kinds:

```text
code_change
code_inspect
general
```

There is deliberately no user-supplied worker/agent/provider field.

Hearth decides the worker deterministically from semantic kind:

```text
code_change  -> X
code_inspect -> X
general      -> Antigravity
```

Codex is not a primary router target in V1. Codex remains a specialist continuation target after an X Goal step reaches a review/failure boundary and the existing specialist lifecycle authorizes it.

Future Search/Invest/GVideo workers may extend the router registry with new semantic kinds later without changing the user-facing "ส่งงาน:" idea.

## Contract shape

Core fields:

```js
{
  version: "hearth-job-v1",
  job_id: "stable caller id",
  kind: "code_change" | "code_inspect" | "general",
  title?: "...",
  objective: "...",

  problem?: "...",
  expected_behavior?: "...",
  observed_behavior?: "...",
  why_this_matters?: "...",

  known_evidence?: ["..."],
  suspected_area?: ["src/..."],

  scope?: {
    allowed_paths: ["..."],
    preferred_files?: ["..."],
    forbidden_paths?: ["..."]
  },

  constraints?: {
    preserve?: ["..."],
    do_not?: ["..."]
  },

  acceptance_criteria?: ["..."],

  validation?: {
    required: ["..."],
    optional?: ["..."]
  },

  done_criteria?: ["..."],
  stop_conditions?: ["..."]
}
```

For code_* jobs, allowed_paths, acceptance_criteria and validation.required are mandatory and non-empty.

For general jobs those code-only fields are optional.

Unknown fields fail closed.

## Workspace authority

hearth-job-v1 carries no executable workspace root.

The authoritative root comes from the already-configured Hearth workspace attached to the MCP transport/Electron main.

For X adaptation:

```text
xTask.workspace.root = authoritative current Hearth workspace
```

The optional repo label is derived from the workspace directory name.

This prevents a generic job payload from selecting arbitrary local filesystem roots.

## X adapter

code_change and code_inspect are converted deterministically to a complete x-task-v1.

P8 sets X-internal policy rather than exposing it as universal job fields:

```text
revision = 1
attempt = 1
parent_task_id = null
based_on_result_id = null

code_change allowed_tools = [repo_read, repo_edit]
code_inspect allowed_tools = [repo_read]

repair_budget = canonical 1 + max 2 repairs / 3 rounds
commit_policy = never
timing = bounded canonical defaults
uncertainty_policy = stop_and_report
```

The existing parseXTask remains final X authority.

The adapter never widens workspace scope.

## Antigravity adapter

general jobs produce a bounded structured prompt from the normalized generic job.

Electron starts Antigravity with:

```text
existingTaskId = hearthjob:<job_id>
requestId = hearthjob:<job_id>:<generic-fingerprint>
requestedRoute = auto
resolvedRoute = antigravity
routeReason = deterministic P8 reason
```

TaskStore remains the durable source of truth.

A repeated identical general job returns the existing task instead of starting a duplicate.

The same job_id with a different fingerprint fails closed as a conflict.

## X identity / idempotency

X uses the existing Electron X ingress:

```text
requestId = hearthjob:<job_id>
task_id = hearthjob:<job_id>
```

The existing X queue receipt fingerprint/idempotency checks remain authoritative.

No P8 X queue is added.

## Universal tools

MCP exposes:

```text
hearth_job_submit
hearth_job_status
```

submit sends the generic job to Electron main over a dedicated transport.

status accepts only job_id and checks existing truth:

1. X receipt at `hearthjob:<job_id>`;
2. Antigravity TaskStore task at `hearthjob:<job_id>`.

If both exist, status fails closed as ambiguous instead of guessing.

## Permissions

Routing never bypasses provider/worker permissions.

X route:
- uses existing ingestXTask;
- X Blocked/Ask/Allow semantics unchanged;
- existing X approval/idempotency/admission applies.

Antigravity route:
- uses current Hearth Antigravity Blocked/Ask/Allow;
- Ask emits the existing local approval event/modal;
- liveness is rechecked after approval;
- no `userApproved` input is accepted from the generic job.

## Transport cancellation

The HTTP round trip sends a cancellation message when the caller disconnects.

Electron tracks the submit transport id with an AbortController.

Cancellation while waiting for approval:
- resolves approval as aborted;
- prevents dispatch.

Cancellation before X commit:
- removes the generic waiter from the in-flight X ingress;
- never aborts another still-live coalesced waiter.

For the Antigravity route, Electron performs one final caller/workspace liveness check immediately before crossing the existing start transaction boundary. A disconnect before that boundary prevents dispatch. Once that boundary is crossed, the existing Antigravity TaskStore/runtime owns launch and recovery truth; disconnect does not retroactively kill admitted work.

Once an existing runtime has accepted work, caller disconnect does not rewrite terminal truth.

## Status normalization

Universal status is read-only and returns a small normalized envelope:

```js
{
  found: true,
  job_id: "...",
  route: "x" | "antigravity",
  status: "...",
  detail: { ...bounded route-specific public evidence... }
}
```

No credentials or raw transcript are returned.

## Specialist boundary

P8 V1 does not route a fresh job directly to Codex.

Existing specialist flow stays:

```text
Goal X step
 -> NEEDS_REVIEW / FAILED
 -> specialist handoff request
 -> explicit specialist authorization
 -> Codex JobManager execution
 -> specialist result
 -> human accept/reject
```

This preserves the existing human control and evidence chain.

## Acceptance gate

P8 V1 is complete only when:

```text
✓ hearth-job-v1 validates deterministically and rejects unknown fields
✓ no worker/provider field exists in the universal contract
✓ code_change/code_inspect route to X
✓ general routes to Antigravity
✓ X adapter creates valid x-task-v1 without exposing X repair/timing internals
✓ generic payload cannot choose an arbitrary workspace root
✓ X submission reuses ingestXTask and X queue idempotency
✓ Antigravity submission is Electron/TaskStore-owned and idempotent
✓ same general job_id with changed fingerprint fails closed
✓ status reads existing X receipt / TaskStore only; no new status store
✓ ambiguous dual-route state fails closed
✓ X and Antigravity permission/approval boundaries remain authoritative
✓ caller disconnect during approval cannot cause stale execution
✓ Codex remains specialist-only in V1
✓ no new executor/queue/JobManager/runtime is created
✓ P2-P7/X regressions remain within validated baselines
```

## Out of scope

- LLM-based autonomous worker selection;
- fresh-job direct Codex routing;
- Search/Invest/GVideo worker implementations;
- new durable job/task database;
- replacing Goal Runner;
- replacing x-task-v1 internally;
- cross-machine router federation;
- P9 visual redesign.
