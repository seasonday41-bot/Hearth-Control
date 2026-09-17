# Hearth Skill v1

Status: initial declarative skill contract

Hearth Skill v1 defines reusable, lazily loaded playbooks for agents such as X. A skill describes **how to approach a class of work**. It does not grant tools, permissions, filesystem access, credentials, or approval bypasses.

## Design goals

- Keep skills small and task-specific.
- Load a skill only when its description matches the current task.
- Reuse Hearth's existing tool gateway, approval model, workspace boundary, secret guard, test runner, executor, and result gate.
- Keep skill definitions portable so future agents can share the same format.
- Treat tool output as evidence, not as permission to invent missing facts.

## Directory layout

```text
mcp/skills/
  definitions/
    <skill-id>/
      SKILL.md
```

Executable infrastructure such as `mcp/skills/gateway.mjs` and `mcp/skills/test-runner.mjs` remains separate from declarative skill definitions.

## Required frontmatter

Every `SKILL.md` must begin with YAML frontmatter containing:

```yaml
schema: hearth-skill-v1
id: repo-inspect
name: Repo Inspect
version: 1
summary: Inspect a repository without modifying it.
agents: [x]
mode: read-only
risk: low
tools: [repo_list, repo_read_file, file_search, git_inspect]
```

### Field meaning

- `schema`: must be `hearth-skill-v1`.
- `id`: stable lowercase skill identifier.
- `name`: human-readable name.
- `version`: positive integer definition version.
- `summary`: short routing description.
- `agents`: agents allowed to request this playbook. This does not grant tool permission.
- `mode`: expected operating mode such as `read-only` or `workspace-write`.
- `risk`: descriptive default risk classification.
- `tools`: tools the playbook may request. Hearth still decides whether each tool is available and permitted.

## Runtime invariants

A Hearth skill MUST NOT:

1. grant itself new permissions;
2. bypass workspace boundaries, protected-path checks, approvals, or the result gate;
3. embed credentials, tokens, secrets, private keys, or connection material;
4. turn an unavailable tool into a shell fallback automatically;
5. claim success without matching evidence;
6. silently expand a read-only task into a write operation;
7. override task-level constraints from `x-task-v1` or a future agent task contract.

If a skill conflicts with a task constraint or Hearth policy, the stricter constraint wins.

## Loading model

The intended future loader flow is:

```text
Task
  -> inspect skill metadata
  -> select the smallest matching skill set
  -> load full SKILL.md only for selected skills
  -> intersect requested tools with task + Hearth permissions
  -> execute through existing gateways/runtime
  -> verify evidence through the normal result gate
```

The initial implementation may store definitions before an automatic loader exists. A definition is inert until the runtime explicitly loads it.

## Skill authoring rules

A skill should contain:

- **Use when**: routing criteria.
- **Do not use when**: boundaries and handoff conditions.
- **Workflow**: bounded ordered procedure.
- **Evidence required**: minimum evidence before reporting completion.
- **Stop conditions**: when to stop rather than improvise.
- **Output contract**: concise normalized result shape or reporting requirements.

Prefer narrow skills over large general-purpose instruction bundles.

## Versioning

- Keep `id` stable for the same conceptual skill.
- Increment `version` when behavior or required evidence changes materially.
- Breaking schema changes require a new schema identifier, for example `hearth-skill-v2`.

## Security model

Skills are policy consumers, not policy owners. Security remains enforced by Hearth runtime components such as the workspace boundary, secret/path protection, explicit tool registration, approval gates, command allowlists, connection permissions, and deterministic result validation.
