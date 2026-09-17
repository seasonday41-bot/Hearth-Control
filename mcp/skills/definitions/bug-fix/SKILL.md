---
schema: hearth-skill-v1
id: bug-fix
name: Bug Fix
version: 1
summary: Diagnose and fix a reproducible coding bug with the smallest safe change, then validate the result with approved tools and evidence.
agents: [x]
mode: workspace-write
risk: medium
tools: [repo_list, repo_read_file, file_search, git_inspect, test_run]
---

# Bug Fix

Use this skill when X is asked to fix a concrete software defect in the selected workspace and the task authorizes code changes.

## Use when

- a reproducible bug, failing behavior, or regression needs to be fixed;
- the task includes a clear objective and acceptance criteria;
- the affected code can be inspected within the selected workspace;
- the required edits are routine, scoped, and reversible;
- relevant validation can be performed with approved Hearth tools or explicitly reported as unavailable.

## Do not use when

- the task is read-only;
- the root cause is not yet understood well enough to justify an edit;
- the requested action requires deployment, push, merge, credential access, database mutation, destructive deletion, or an unavailable external connection;
- the required fix materially redesigns the architecture beyond the task scope;
- the task requires a command or tool not approved by Hearth.

When any of these boundaries are crossed, stop and return the missing capability or request escalation/approval through Hearth. Do not improvise a shell or network fallback.

## Workflow

1. **Confirm the requested behavior.** Read the task objective, constraints, allowed paths, acceptance criteria, and validation requirements before editing.
2. **Inspect before changing.** Locate the relevant implementation and nearby tests/configuration using the repository inspection tools.
3. **Establish the root cause.** State the evidence that connects the observed defect to the implementation. Do not patch only a symptom when the actual cause is visible.
4. **Choose the smallest safe fix.** Preserve existing contracts and unrelated behavior. Avoid opportunistic refactors, dependency changes, or cleanup outside the requested scope.
5. **Apply only authorized edits.** The skill itself does not grant write permission. Every write remains subject to the task contract, workspace boundary, Hearth policy, and approval model.
6. **Inspect the resulting diff.** Verify that only intended files and lines changed and that no secret/protected material was touched.
7. **Run relevant approved validation.** Prefer the narrowest available test profile that covers the changed behavior. Run broader validation only when required by the task or when the change has wider impact.
8. **Repair within the task budget.** If validation fails because of the change, diagnose and make a bounded repair only while the task's repair budget permits it.
9. **Verify completion evidence.** Confirm the acceptance criteria against source, diff, and validation results. A passing test alone is not sufficient when the task asks for additional evidence.
10. **Return the normalized result.** Report root cause, files changed, validation performed, evidence, and any remaining uncertainty.

## Evidence required

Do not report the bug as fixed unless the current run contains evidence for all task-relevant claims.

Minimum evidence normally includes:

- relevant source inspected before the edit;
- a root-cause explanation tied to that source;
- a bounded diff showing the intended change;
- validation requested by the task, or a clear statement that it could not be run;
- acceptance criteria checked individually when practical.

If tests pass but an acceptance criterion was not actually verified, return an incomplete/needs-review outcome rather than claiming full completion.

## Stop conditions

Stop and hand off instead of guessing when:

- required files are outside the selected workspace or protected;
- the task requires a tool/connection that is unavailable;
- the root cause remains ambiguous after reasonable inspection;
- a fix would require a broad redesign not authorized by the task;
- validation repeatedly fails beyond the task's repair budget;
- an edit would require destructive or irreversible action;
- repository state changes unexpectedly and makes the current evidence stale;
- task constraints and the requested fix conflict.

## Output contract

Return a compact result containing, when applicable:

```text
Skill: bug-fix
Status: completed | needs_review | failed | blocked
Root cause: <evidence-backed explanation>
Files changed: <authorized paths>
Change summary: <smallest safe fix applied>
Validation: <profiles/checks actually run and results>
Acceptance criteria: <satisfied / unresolved items>
Git evidence: <relevant diff/status facts>
Uncertainty: <none or unresolved items>
```

`completed` requires evidence that the requested fix and task acceptance criteria were satisfied. `needs_review` means the change is plausible but evidence is incomplete, validation is unavailable/ambiguous, or a human/specialist decision is required. `failed` means the attempted fix or required validation failed. `blocked` means policy, permissions, workspace boundaries, protected paths, unavailable capabilities, or approvals prevented the work.

## Safety

This skill is a workflow definition only. It does not grant filesystem writes, command execution, Git mutation, network access, credentials, deploy rights, database mutation, or approval bypasses. Existing Hearth policy, X task constraints, write controls, repair budget, and deterministic result validation always take precedence over this document.
