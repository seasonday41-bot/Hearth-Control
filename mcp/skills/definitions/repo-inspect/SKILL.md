---
schema: hearth-skill-v1
id: repo-inspect
name: Repo Inspect
version: 1
summary: Inspect a selected repository, Git state, and relevant source files without modifying workspace contents.
agents: [x]
mode: read-only
risk: low
tools: [repo_list, repo_read_file, file_search, git_inspect]
---

# Repo Inspect

Use this skill when the task asks X to understand repository state, locate relevant implementation, inspect source, trace a code path, identify likely areas involved in an issue, or report Git branch/HEAD/worktree information without changing files.

## Use when

- inspecting repository structure;
- checking current Git branch, HEAD, status, recent log, or diff;
- locating files, symbols, strings, configuration, or tests;
- reading relevant source before a later implementation task;
- producing a read-only technical audit grounded in repository evidence.

## Do not use when

- the task requires editing, creating, renaming, or deleting files;
- a test/build command must be executed;
- deployment, push, merge, database mutation, or external service mutation is required;
- the requested evidence requires a tool or connection that is not available through the current task.

When the request crosses one of these boundaries, stop and return the missing capability or recommend routing to the appropriate write/test/connection skill. Do not improvise a shell fallback.

## Workflow

1. **Confirm scope from the task.** Preserve task-level allowed paths, constraints, and acceptance criteria. Do not broaden the audit without evidence that broader inspection is necessary.
2. **Inspect Git state when relevant.** Use `git_inspect` for only the operations needed: `branch`, `head`, `status`, `log`, or `diff`.
3. **Map the repository selectively.** Use `repo_list` with bounded depth/entry limits. Avoid treating generated/build directories as source evidence.
4. **Locate relevant code.** Use `file_search` for focused terms, then read only the files needed to answer the task.
5. **Read source safely.** Use `repo_read_file`. If a path is protected, report that it was protected; never attempt another path trick or alternate command to expose it.
6. **Cross-check findings.** Distinguish direct evidence from inference. If two files or code paths disagree, report the mismatch rather than choosing silently.
7. **Return a concise evidence-backed result.** State what was inspected, what was found, what remains uncertain, and whether the task's requested evidence was fully satisfied.

## Evidence required

Do not report a repository fact as confirmed unless the matching tool evidence exists in the current run.

Examples:

- Branch name -> `git_inspect(branch)` output.
- HEAD SHA -> `git_inspect(head)` output.
- Clean/dirty worktree -> `git_inspect(status)` output.
- Symbol/file location -> `file_search` result and, when semantics matter, the relevant `repo_read_file` content.
- Code behavior -> relevant source lines read from the repository; do not infer implementation solely from filenames.

A successful tool call is only candidate evidence. Verify that its content actually answers the task before treating it as confirmed.

## Stop conditions

Stop instead of guessing when:

- the requested path is outside the selected workspace;
- the required file is protected or unavailable;
- the task needs a write-capable operation;
- the task needs an unregistered command or external connection;
- evidence is insufficient to satisfy a requested acceptance criterion;
- repository state changes during the inspection in a way that makes earlier evidence stale or contradictory.

## Output contract

Return a compact result containing, when applicable:

```text
Skill: repo-inspect
Status: completed | incomplete | blocked
Scope inspected: <paths/areas>
Git evidence: <branch/head/status facts requested by task>
Findings: <evidence-backed findings>
Relevant files: <paths actually inspected>
Uncertainty: <none or unresolved items>
Changes made: none
```

`completed` means all requested read-only evidence was obtained. `incomplete` means the inspection ran but one or more requested facts could not be established. `blocked` means policy, workspace, protected-path, or capability limits prevented meaningful inspection.

## Safety

This skill is strictly read-only. It never authorizes file writes, Git mutation, shell execution, network access, credential access, push, merge, deploy, or database mutation. Existing Hearth policy and task constraints always take precedence over this document.
