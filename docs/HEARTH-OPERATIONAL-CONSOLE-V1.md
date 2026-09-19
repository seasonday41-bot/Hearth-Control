# Hearth Operational Console V1

Status: P7 canonical design
Created: 2026-09-20
Baseline: main@bddfb90ec9b12a9eb0a0cd4d1fed33f0a0d726ed
Implementation branch: feature/p7-console-v1

## Goal

P7 adds a small operational Console that makes already-existing Hearth state visible in one place:

```text
Connections health
Pending approvals
Operational evidence
```

P7 is an observability/operations layer. It does not create new execution authority.

## Existing truth reused

P7 reuses the existing runtime and UI sources:

```text
connections:list / connections:refresh
  -> P3/P4/P5/P6 provider-safe public snapshots

server:event approval / approval:resolved
  -> existing local approval lifecycle

renderer logs
  -> current-session operational events

Goal.checkpoints / GoalStep.evidence
  -> durable Goal evidence already persisted by Goal Runner
```

No second connection registry, approval queue, log store, evidence database, or execution router is added.

## Console sections

### 1. Connection Health

Shows renderer-safe fields only:

```text
alias
provider
label
status
account
capabilities
lastCheckedAt
lastError
```

Actions:

```text
Refresh all
Refresh one connection
GitHub: local Connect/Reconnect/Disconnect
Vercel: local Connect/Reconnect/Disconnect
```

Refresh uses the existing `connections:refresh` provider-specific health path.

Connection management reuses the existing P4/P6 local IPC only:

```text
github:connect / github:disconnect
vercel:connect / vercel:disconnect
```

No new credential backend is added. Secret input exists only in transient renderer component state, uses password-style fields, is never written to logs/localStorage/settings, and is cleared after a successful connect.

Supabase continues to use the existing Bridge / Project X auth surfaces. P7 does not create a second Supabase login flow.

The Console does not render connection `target` objects by default because they are unnecessary operational detail and could grow to contain provider metadata that should not be casually surfaced.

The Console contains no token/credential getter and never reads an existing secret back from Hearth.

### 2. Pending Approvals

Shows the renderer's existing FIFO approval queue:

```text
permission
action
request state
```

The Console is status-only.

Approval decisions remain owned by the existing modal and existing `server:respond-approval` flow. P7 must not create a second allow/deny path or bypass the modal lifecycle.

### 3. Evidence

P7 distinguishes evidence lifetime explicitly.

Current-session evidence:

```text
renderer system logs
approval request/resolution history
```

Durable evidence:

```text
Goal checkpoints
Goal step evidence already persisted by Goal Runner
```

The Console may summarize durable Goal evidence but must not mutate Goal state, mark completion, acknowledge reviews, or create retries.

## Approval history model

The renderer may keep a bounded current-session approval history derived from existing events.

Suggested states:

```text
pending
allowed
denied
timeout
aborted
shutdown
```

The record contains only:

```text
requestId
permission
action
state
time
reason
```

No credential/session/provider secret is included.

History is bounded and explicitly current-session only. P7 does not create a new durable approvals database.

## Connection refresh behavior

- Console entry may read `connections:list` without remote network calls.
- Explicit Refresh may call `connections:refresh`.
- Refresh errors are shown as bounded UI state.
- Refresh never changes credentials.
- Refresh does not connect/disconnect providers.
- Provider-specific mutation capability remains unchanged.

## UI scope

Add one navigation item:

```text
Console
```

P7 does not perform the P9 full UI redesign.

Existing Overview, Permissions, Logs, Goals, Task Console, Local Chat, and Storage Audit remain intact.

The Console should reuse existing panel/card visual primitives where practical and add only minimal responsive CSS.

## Evidence accuracy cleanup

Existing hard-coded UI copy that claims an exact old MCP tool count must not remain authoritative when the registered tool set has expanded.

Prefer wording such as:

```text
Hearth MCP tools
```

instead of a stale fixed number.

## Security boundaries

P7 must preserve:

- renderer never receives credentials/ciphertext;
- no new provider mutation tool;
- connect/disconnect is an explicit local credential-management action using already-validated P4/P6 IPC;
- no new execution route;
- no new approval bypass;
- no Goal/X state mutation from evidence rendering;
- no raw provider target metadata dump;
- no automatic remote health polling loop;
- no background provider mutation;
- no log/evidence claim stronger than the actual lifetime of the source.

## Acceptance gate

P7 V1 is complete only when:

```text
✓ Console nav/page exists
✓ safe connection snapshots render
✓ refresh all / one use existing connectionsRefresh
✓ GitHub and Vercel can connect/reconnect/disconnect only through existing local IPC
✓ secret inputs are transient and cleared; no credential getter exists
✓ Supabase auth is not duplicated
✓ target/auth/stored credential data are not rendered
✓ pending approvals are visible but not decidable from Console
✓ current-session approval history is bounded
✓ current-session logs are labeled as session evidence
✓ durable Goal checkpoint evidence is summarized read-only
✓ no new backend authority or durable state store is introduced
✓ stale fixed MCP tool-count copy is removed
✓ P3/P4/P5/P6/P2/X regressions remain within validated baselines
✓ build/TypeScript/syntax/git diff checks pass
```

## Out of scope

- duplicate Supabase credential/auth UI;
- provider mutation controls;
- deploy/promote/rollback;
- domain/env management;
- new approval decision path;
- durable system-log database;
- durable approval-history database;
- Router/P8;
- full navigation/design overhaul/P9.
