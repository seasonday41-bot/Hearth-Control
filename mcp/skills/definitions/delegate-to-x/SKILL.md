---
schema: hearth-skill-v1
id: delegate-to-x
name: Delegate to X
version: 1
summary: Decide when a bounded local repository task suits X and prepare a clear handoff within existing Hearth approval boundaries.
agents: [chatgpt, codex, claude]
mode: advisory
risk: low
tools: []
---

# Delegate to X

Use this shared playbook when a task may fit X's existing local repo-inspect, bug-fix, or test-regression workflows. A future Claude consumer may read this definition; it does not connect Claude to Hearth.

## Workflow

1. Decide whether X's available workspace, tools, and existing skills can complete the bounded task. Keep architecture, release, and cross-system decisions with the responsible agent or human.
2. Prepare a handoff with the objective, selected workspace, allowed paths and tools, constraints, acceptance criteria, and validation evidence needed.
3. Check the active task's authorization and Hearth's per-task approval requirements before any submission. If submission is not authorized or no connector is available, return the prepared handoff for review.
4. If an authorized route exists, submit through that route and track the actual result. Review X's diff and validation evidence before treating the task as complete.

## Stop conditions

Do not submit an ambiguous, oversized, destructive, or out-of-scope task to X. Do not bypass approval, invent a connector, or report delegation as completed without a submission result.

## Safety

This playbook grants no X access, tools, workspace permission, or approval bypass. Hearth's current runtime and X task policy remain authoritative.
