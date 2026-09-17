---
schema: hearth-skill-v1
id: test-regression
name: Test Regression
version: 1
summary: Select and run the smallest approved regression tests needed to verify a code change or suspected regression, then report evidence without overstating coverage.
agents: [x]
mode: validation
risk: low
tools: [repo_list, repo_read_file, file_search, git_inspect, test_run]
---

# Test Regression

Use this skill when X needs to verify that a change, fix, or suspected regression is covered by the existing approved Hearth test profiles.

## Use when

- a task explicitly requires tests or regression validation;
- a code change has already been made and needs evidence;
- a suspected regression needs targeted confirmation;
- the available approved test profiles can meaningfully cover the affected area.

## Do not use when

- the task requires arbitrary shell commands or unregistered test commands;
- no approved test profile covers the requested behavior;
- the task is asking for implementation rather than validation;
- deployment, production mutation, external credentials, or network access is required.

When coverage is unavailable, report the gap instead of inventing or running an unapproved command.

## Workflow

1. **Read the validation requirement.** Identify exactly what behavior, files, or acceptance criteria need regression evidence.
2. **Inspect the affected area when necessary.** Use read-only repository tools to map the change to an existing test profile.
3. **Select the narrowest approved profile.** Prefer targeted validation over broad suites when it is sufficient.
4. **Request/run through `test_run`.** Do not bypass the Test Runner with shell execution.
5. **Capture actual evidence.** Record profile, status, exit code, counts when available, duration, truncation, and any runner errors.
6. **Interpret conservatively.** A passing profile proves only what that profile meaningfully covers. Do not generalize to unrelated behavior.
7. **Escalate gaps.** If no approved profile covers the required behavior, return `needs_review`/`blocked` with the missing validation capability.
8. **Return a compact result.** Include what ran, what passed/failed, what coverage remains uncertain, and whether the task's acceptance criteria are supported.

## Evidence required

Do not claim a test passed unless the current `test_run` result reports a passing status. Do not claim full regression safety when only a targeted profile ran unless the task explicitly defines that profile as sufficient.

## Stop conditions

Stop instead of improvising when:

- the requested profile is not registered;
- the selected workspace is not a Hearth project where the approved profile is valid;
- a Test Runner process is already active and cannot safely proceed;
- the task requires a test command outside approved profiles;
- output is truncated or ambiguous in a way that prevents the requested conclusion;
- the test process remains alive after termination and manual review is required.

## Output contract

```text
Skill: test-regression
Status: completed | needs_review | failed | blocked
Profiles run: <ids>
Results: <actual statuses/counts>
Coverage: <what the evidence supports>
Unverified: <remaining gaps>
Changes made: none
```

## Safety

This skill does not authorize arbitrary command execution, file writes, Git mutation, network access, credentials, deployment, or database mutation. It only coordinates approved Hearth validation tools under existing permissions and task constraints.
