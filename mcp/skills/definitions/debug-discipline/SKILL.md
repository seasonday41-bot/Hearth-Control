---
schema: hearth-skill-v1
id: debug-discipline
name: Debug Discipline
version: 1
summary: Diagnose a software problem from evidence, make the smallest justified change, and verify the reported outcome.
agents: [chatgpt, codex, claude]
mode: advisory
risk: low
tools: []
---

# Debug Discipline

Use this shared playbook when investigating a defect or regression. It guides ChatGPT, Codex, and a future Claude consumer; X continues to use its existing bug-fix skill.

## Workflow

1. Confirm the reported behavior, expected behavior, scope, and constraints.
2. Inspect the relevant implementation, nearby callers, and available evidence before editing. Reproduce the failure when practical.
3. Identify a root cause supported by the observed behavior and source. Mark uncertain explanations as hypotheses.
4. Make the smallest change that addresses the cause while preserving existing contracts and unrelated behavior.
5. Inspect the diff, then run the most relevant available validation. Check the original failure directly when practical.
6. Report the cause, exact changes, checks actually run, results, and remaining uncertainty.

## Stop conditions

Pause for clarification or report a blocked result when the cause cannot be established, required evidence or tools are unavailable, or the fix needs authority or scope beyond the active task. Do not claim a fix from a passing unrelated test.

## Safety

This playbook grants no tools, write access, command execution, credentials, deployment rights, or approval bypass. The active task, host agent capabilities, and Hearth policy remain authoritative.
