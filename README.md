# Hearth Control

A local macOS desktop control center, built with Electron, React, TypeScript, and Vite.

## 🚨 READ FIRST — Canonical continuation path

**Last updated: 2026-09-17**

This section is the project handoff/source of truth for any new ChatGPT/Codex/AI session. **Do not start a fresh architecture plan, choose a different next feature, or rediscover the roadmap from scratch.** Read this section first, inspect only the files needed for the current phase, and continue the first incomplete priority below.

```text
CURRENT_PHASE = P1_X_SKILL_INTEGRATION
NEXT_PHASE = P2_REMOTE_ONE_CLICK_UPDATER
STATUS = IN_PROGRESS
BASELINE_MAIN = 764116776806a665dce10a716c91921c10e87d8d
ACTIVE_BRANCH = feature/x-skill-integration-v1
MAC_RUNTIME_VALIDATION = P0 PASS; P1 PENDING
BLOCKED_BY = none
LAST_COMPLETED_STEP = P0 Skill v1 validated on Mac and merged to main; P1 branch created and pushed from merged main
NEXT_EXACT_ACTION = inspect and implement the smallest safe Skill Registry hook into X without changing claim/lease/durable runtime/Result Gate
VALIDATION_REQUIRED = P1 targeted integration tests + existing Skill tests + existing X regression tests + build + git diff --check + clean/scope review
DO_NOT_START = P2/P3/P4/P5/P6/P7/P8/P9 until P1 integration evidence is clean and P1 is merged to main
```

**Continuation rule:** if `BLOCKED_BY` is still true, do not invent substitute feature work. Wait for the blocker to clear, then execute `NEXT_EXACT_ACTION`. After every meaningful completed step, update `LAST_COMPLETED_STEP`, `NEXT_EXACT_ACTION`, checklist state, and evidence before switching chats.

### Current validated/stable direction

Hearth is the trusted execution/control layer. X is the local coding executor. Supabase is task/goal transport and persisted remote state. Existing durable runtime, claims, continuation/recovery, Goal Runner, approval boundaries, and local updater install/rollback path are established components and must not be casually redesigned.

The project direction is:

```text
Chat / Supervisor
  -> Hearth ingress / Router
  -> X + Skills
  -> Hearth-owned Connections
  -> validation/evidence/result gate

Future specialized agents reuse Hearth-owned Skills/Connections.
UI redesign happens only after the backend/control path is complete.
```

### Current active branch — what already exists

`feature/x-skill-integration-v1` was created from merged `main` at `764116776806a665dce10a716c91921c10e87d8d` and is the only branch for P1 work.

P0 Skill v1 is now canonical on `main` and includes:

```text
docs/HEARTH-SKILL-V1.md
mcp/skills/registry.mjs
mcp/skills/definitions/README.md
mcp/skills/definitions/repo-inspect/SKILL.md
mcp/skills/definitions/bug-fix/SKILL.md
mcp/skills/definitions/test-regression/SKILL.md
scripts/test-skill-registry.mjs
scripts/test-skill-definitions.mjs
package.json                         # adds Skill Registry test script
docs/REMOTE-ONE-CLICK-UPDATER-V1.md # design only; do NOT implement during P1
```

P1 must reuse those components. Do not create a second Skill Registry, alternate task runner, alternate gateway, or alternate Result Gate.

---

## ✅ Canonical progress checklist — MUST be maintained

This checklist is the handoff ledger for every future chat/agent. **A phase is not complete until its evidence is recorded here.** When a phase finishes, mark its checkbox, add the completion record, update `CURRENT_PHASE`, `NEXT_PHASE`, `ACTIVE_BRANCH`, and the exact next action before doing later work.

### Overall roadmap

- [x] **P0 — Validate and merge Hearth Skill v1**
- [ ] **P1 — Wire Skill Registry into X** ← CURRENT
- [ ] **P2 — Remote One-Click Updater**
- [ ] **P3 — Connection Registry + Secure Credential Store**
- [ ] **P4 — GitHub multi-connection (2+)**
- [ ] **P5 — Supabase multi-project (2+)**
- [ ] **P6 — Vercel connection**
- [ ] **P7 — Console / connection health / approvals / evidence**
- [ ] **P8 — Multi-Agent Router + universal `ส่งงาน:` ingress**
- [ ] **P9 — Full UI redesign LAST**

### P0 detailed checklist — completed

- [x] Hearth Skill v1 contract authored: `docs/HEARTH-SKILL-V1.md`
- [x] `repo-inspect` Skill definition authored
- [x] `bug-fix` Skill definition authored
- [x] `test-regression` Skill definition authored
- [x] Skill Registry/Loader authored: `mcp/skills/registry.mjs`
- [x] Registry tests authored: `scripts/test-skill-registry.mjs`
- [x] Skill definition tests authored: `scripts/test-skill-definitions.mjs`
- [x] Package script added for Skill Registry tests
- [x] Run `npm run test:skill-registry` on the Mac — 10/10 PASS
- [x] Run `node --test scripts/test-skill-definitions.mjs` on the Mac — 4/4 PASS
- [x] Run `npm run test:local-skills` on the Mac — 46/46 PASS; Local Skills gateway subset 18 PASS
- [x] Run `npm run build` on the Mac — PASS (`built in 67ms`)
- [x] Run `git diff --check` — PASS (no output)
- [x] Inspect `git status` and `git diff main...HEAD` — worktree clean; expected 11 changed files only
- [x] Fix only branch-caused failures if any — no branch-caused failures found
- [x] Record exact validation evidence below
- [x] Merge branch into `main`
- [x] Update `BASELINE_MAIN` to merged `main` HEAD `764116776806a665dce10a716c91921c10e87d8d`
- [x] Set `CURRENT_PHASE = P1_X_SKILL_INTEGRATION`
- [x] Create/push `feature/x-skill-integration-v1` from updated `main`

### P0 validation evidence — 2026-09-17

```text
BRANCH = feature/hearth-skill-v1-repo-inspect
PRE_MERGE_HEAD = 6d1c6d754d875d0855c8c25bf1aff227341ff2c9 (before evidence-only README commit)
MERGED_MAIN_HEAD = 764116776806a665dce10a716c91921c10e87d8d

npm run test:skill-registry
  PASS = 10/10
  FAIL = 0

node --test scripts/test-skill-definitions.mjs
  PASS = 4/4
  FAIL = 0

npm run test:local-skills
  PASS = 46/46
  FAIL = 0
  Local Skills gateway subset = 18 passed

npm run build
  PASS
  dist/index.html = 0.40 kB
  dist/assets/index-D_VEEULc.css = 56.30 kB
  dist/assets/index-rpJKux6c.js = 270.67 kB
  built in 67ms

Generated electron/build-meta.json changed during build and was restored deliberately.
git status --short = CLEAN after restore
git diff --check = PASS (no output)
git diff --name-status main...HEAD = expected 11 files only
Remote compare after merge = main and P0 branch identical
```

Expected P0 changed-file scope:

```text
M README.md
A docs/HEARTH-SKILL-V1.md
A docs/REMOTE-ONE-CLICK-UPDATER-V1.md
A mcp/skills/definitions/README.md
A mcp/skills/definitions/bug-fix/SKILL.md
A mcp/skills/definitions/repo-inspect/SKILL.md
A mcp/skills/definitions/test-regression/SKILL.md
A mcp/skills/registry.mjs
M package.json
A scripts/test-skill-definitions.mjs
A scripts/test-skill-registry.mjs
```

### P1 detailed checklist — current truth

- [x] P1 branch created from merged P0 `main`: `feature/x-skill-integration-v1`
- [x] P1 branch pushed to `origin`
- [x] Inspect current X execution path: `run-x-task.mjs` -> `execute-x-task.mjs` -> `repair-loop.mjs` -> `local-executor.mjs`
- [x] Confirm Skill Registry remains permission-neutral (`grantsPermissions: false`)
- [x] Confirm existing read-only gateway owns `repo_list`, `repo_read_file`, `file_search`, `git_inspect`
- [x] Confirm Test Runner owns only approved `test_run` profiles
- [x] Confirm `x-task-v1` already carries `allowed_tools`; do not add a second permission source merely for Skills
- [ ] Define the smallest deterministic Skill selection/loading hook for X
- [ ] Intersect Skill-requested tools with `task.allowed_tools` and actual Hearth-provided tool availability
- [ ] Inject only selected Skill instructions/tool availability into the X model/execution context
- [ ] Ensure missing Skill tools fail closed; no shell/general-command fallback
- [ ] Ensure Skill metadata cannot widen workspace scope, write authority, validation authority, or approval boundaries
- [ ] Keep `run-x-task.mjs` claim/lease/run persistence unchanged unless runtime evidence proves a targeted change is required
- [ ] Keep dispatcher/durable runtime/continuation/Result Gate unchanged
- [ ] Add targeted P1 integration tests for the three current Skills
- [ ] Prove `repo-inspect` remains read-only end-to-end
- [ ] Prove `bug-fix` does not gain write authority from the Skill definition itself
- [ ] Prove `test-regression` can request only approved Test Runner profiles
- [ ] Run existing Skill Registry/definition/Local Skills regressions
- [ ] Run relevant existing X regressions
- [ ] Run `npm run build`
- [ ] Run `git diff --check`
- [ ] Inspect `git status` and `git diff main...HEAD`
- [ ] Record P1 evidence here
- [ ] Merge P1 to `main` only after user authorization
- [ ] Update `BASELINE_MAIN`, set `CURRENT_PHASE = P2_REMOTE_ONE_CLICK_UPDATER`, and create the P2 branch before coding P2

### P0 completion record

```text
PHASE_COMPLETED = P0
STATUS = PASS
COMPLETED_AT = 2026-09-17
BRANCH = feature/hearth-skill-v1-repo-inspect
MERGED_MAIN_HEAD = 764116776806a665dce10a716c91921c10e87d8d
VALIDATION = test:skill-registry 10/10 PASS; skill definitions 4/4 PASS; test:local-skills 46/46 PASS; build PASS; git diff --check PASS; clean/scope review PASS
FILES/ARCHITECTURE = Hearth Skill v1 contract, three initial Skill definitions, permission-neutral Registry/Loader, tests, and locked Remote Updater design became canonical
KNOWN_LIMITATIONS = Skill Registry is not yet wired into X execution; that is P1
NEXT_PHASE = P1_X_SKILL_INTEGRATION
NEXT_EXACT_ACTION = implement the smallest safe Skill selection/loading hook into X while preserving all existing safety/runtime owners
```

### Completion record — append one block for every completed phase

Use this exact structure so a new chat can continue without reconstructing history:

```text
PHASE_COMPLETED = P?
STATUS = PASS
COMPLETED_AT = <ISO timestamp or local date/time>
BRANCH = <branch used>
MERGED_MAIN_HEAD = <SHA, if merged>
VALIDATION = <exact test/build commands + pass counts/results>
FILES/ARCHITECTURE = <short summary of what became canonical>
KNOWN_LIMITATIONS = <none or explicit remaining limitations>
NEXT_PHASE = P?
NEXT_EXACT_ACTION = <first concrete action only>
```

### Session handoff checklist — update before changing chats

Before ending a substantial session or moving to another chat, the current agent must verify:

- [ ] `CURRENT_PHASE` matches the first unfinished roadmap phase.
- [ ] `STATUS`, `BLOCKED_BY`, `LAST_COMPLETED_STEP`, `NEXT_EXACT_ACTION`, `VALIDATION_REQUIRED`, and `DO_NOT_START` reflect current truth.
- [ ] The completed work in that phase is checked off above.
- [ ] Validation evidence is recorded; do not mark runtime work complete from code inspection alone.
- [ ] `ACTIVE_BRANCH` is correct.
- [ ] `BASELINE_MAIN` is updated if a merge occurred.
- [ ] `NEXT_PHASE` is correct.
- [ ] `NEXT_EXACT_ACTION` is the first concrete action only; do not make a new chat infer it from prose.
- [ ] Any locked design document path is named so the next chat does not invent a second architecture.
- [ ] Known failures/blockers are written explicitly.
- [ ] No later phase was started while an earlier required checklist item remained incomplete, unless the user explicitly changed priorities.

**Rule:** if the README and a chat summary disagree, inspect Git/relevant evidence and update this README first. Once corrected, this README becomes the continuation source of truth again.

---

## Canonical priority order

### P0 — Validate and merge Hearth Skill v1 — COMPLETE

P0 is merged into `main` at:

```text
764116776806a665dce10a716c91921c10e87d8d
```

Do not reopen P0 unless new regression evidence shows a concrete defect in the merged Skill v1 foundation.

### P1 — Wire Skill Registry into X **NOW**

Integrate the declarative Skill Registry with X using the smallest safe hook.

Locked rules:

- Reuse `mcp/skills/registry.mjs`.
- Reuse existing `mcp/skills/gateway.mjs` and `mcp/skills/test-runner.mjs` as tool execution layers.
- Skills are playbooks/policy consumers; they never grant permissions.
- `task.allowed_tools`, task scope/constraints, Hearth permissions, and actual available tools always override Skill metadata.
- No shell/general-command fallback when a Skill tool is unavailable.
- Do not redesign X claim/run stores, dispatcher, durable runtime, continuation, or Result Gate.
- Do not add more Skill categories until the three current definitions (`repo-inspect`, `bug-fix`, `test-regression`) can be selected/loaded and tested end-to-end.
- `x-task-v1` already has `allowed_tools`; do not create a second parallel permission field solely for Skills without a demonstrated contract need.

Canonical Skill spec: `docs/HEARTH-SKILL-V1.md`.

Current execution path to preserve:

```text
runXTask
  -> executeXTask
     -> runTaskWithRepair
        -> executeTask (LocalExecutor)
           -> Context Loader
           -> ModelAdapter
           -> Scoped Edit Writer
        -> Validation Runner
     -> Result Gate
     -> X Result
```

P1 completion means X can deterministically select/load the appropriate current Skill, intersect the Skill's requested tools with task/Hearth availability, expose only that bounded playbook/tool set to execution, and return grounded evidence without bypassing current task/workspace/approval/result constraints.

### P2 — Remote One-Click Updater

This is next because manual DMG drag/Replace creates friction on every iteration.

Create a **new branch from then-current `main`** after P1 is complete. Do not implement Remote Updater on the P1 Skill Integration branch.

Canonical design: `docs/REMOTE-ONE-CLICK-UPDATER-V1.md`.

Locked architecture:

```text
remote signed manifest
 -> secure download + DMG verification/staging (new layer)
 -> existing electron/updater.cjs
 -> existing install/backup/restart
 -> existing updater-helper.cjs rollback watchdog
```

Do **not** replace the existing local updater. Do not allow X, Goal, MCP, Supabase, remote tasks, or a manifest to trigger installation directly. Final install remains an explicit local-user action.

### P3 — Hearth Connection Registry + Secure Credential Store

Connections belong to **Hearth**, not to X. Build one registry that future agents can reuse.

Target aliases:

```text
github:personal
github:work
supabase:hearth
supabase:xgen
vercel:main
```

Requirements:

- stable alias -> provider/account/project mapping;
- credentials never embedded in tasks/prompts/logs;
- secure local credential storage (reuse Electron/macOS secure facilities after auditing current patterns);
- explicit connection states such as `CONNECTED`, `EXPIRED`, `NEEDS_REAUTH`, `ERROR`;
- health check and re-auth path;
- permission/capability metadata separate from the secret itself.

Do not hardcode one GitHub account, one Supabase project, or provider secrets into X.

### P4 — GitHub multi-connection

Use the Connection Registry foundation. X/Hearth must support at least **2 GitHub connections** simultaneously without disconnect/reconnect churn.

Keep push/merge/delete/deploy-style mutations aligned with Hearth approval policy. Read/inspect capability and write capability must remain distinguishable.

### P5 — Supabase multi-project

Support at least **2 Supabase projects** simultaneously through aliases, initially:

```text
supabase:hearth
supabase:xgen
```

Do not put raw project credentials into X tasks. Do not collapse existing Project X/legacy bridge auth boundaries unless an explicit migration is designed and validated.

### P6 — Vercel connection

Add Vercel to the same Hearth Connection Registry. Start with one stable connection but keep the registry multi-connection capable.

Separate read/inspect capability from sensitive actions such as production deploy, domain mutation, and environment-variable changes. Sensitive mutations require the existing approval philosophy.

### P7 — Console / connection health / approvals / evidence

After Skills and provider connections work, build the operational Console needed to manage them.

Target information architecture:

```text
Dashboard
Projects
Agents
Skills
Connections
Tasks / Goals
Approvals
Console / Logs / Evidence
Settings
```

This phase is functional/operational UI. Do not perform the full visual redesign yet.

### P8 — Multi-Agent Router + universal ingress

Only after X + Skills + Connections are stable, extend Hearth routing for future specialized workers.

Desired user-level command remains agent-agnostic:

```text
ส่งงาน: <งานที่ต้องการ>
```

Hearth decides the worker. Do not expose `x-task-v1` as the permanent universal user-facing contract. A future generic Hearth job contract may be transformed internally into agent-specific contracts.

Do not build GVideo/Search/other agent runtimes before this foundation is ready.

### P9 — Full UI redesign **LAST**

Current UI is known to be crowded. Do not spend backend implementation time polishing/restructuring the display before P0-P8 are stable enough to define the real information architecture.

When this phase starts, split the current large `src/App.tsx`/styles into clear pages/components without silently changing runtime/business behavior. Target UX direction is easy to use, polished, colorful, and visually rich rather than ultra-minimal; detailed visual design is intentionally deferred until P9.

---

## Do-not-deviate rules for a new chat/agent

A new session must follow this protocol:

1. Read this README section before proposing work.
2. Read the canonical document named in the **current phase only**.
3. Check `main`, the active feature branch, and their diff before editing.
4. Continue the **first incomplete priority**. Do not choose a later priority because it seems more interesting or easier.
5. Do not create a second implementation path for something that already has a locked design/spec.
6. Do not redesign validated Hearth lifecycle components without new failing runtime evidence.
7. Do not merge/push/deploy/release unless the task explicitly authorizes it and the required validation evidence exists.
8. Before ending a substantial work session or changing chats, update this README: current phase, completed evidence, active branch, and exact next action.

If the user explicitly changes priorities, update this section first so the new direction becomes the single source of truth. Otherwise this order is authoritative for continuation.

## Protected stable areas

Unless the current phase explicitly requires a targeted change, preserve:

```text
Durable Job Runtime / JobManager ownership
worker process + heartbeat lifecycle
continuation/recovery and startup reconciliation
X task claim/run persistence and MAX_ACTIVE_TASKS=1 safety
Goal Runner durable/local truth
existing Supabase Remote Task/Goal contracts
existing local updater validation/install/backup/rollback flow
approval boundaries and workspace/path protections
```

## Current user-facing architecture target

```text
User / Chat
   -> Hearth
      -> Router
      -> Skills
      -> Connection Registry
      -> Agent X (first worker)
      -> future specialized workers
      -> Tests / Evidence / Result Gate

Hearth owns control, connections, permissions, persistence and recovery.
Agents consume those capabilities; they do not own credentials or bypass policy.
```

---

## Run it

```bash
npm install
npm run dev
```

`npm run build` creates the production renderer bundle in `dist/`.

## Functional V1

- Uses the native macOS folder picker for workspace selection.
- Persists workspace, port, theme, and permission choices in Electron's app data directory.
- Starts and stops a dedicated local Node.js server process.
- Streams process state and logs from Electron to the React interface over a restricted preload bridge.
- Exposes Streamable HTTP MCP at `POST /mcp`, plus `GET /health` and `GET /tools`, on `127.0.0.1:3001` by default.
- Provides a local stdio transport with `npm run mcp:stdio`.
- Sends one-time approval requests back to the desktop app when a permission is set to `Ask`.

## MCP tools

- `workspace_info`
- `list_files`
- `search_files`
- `read_file`
- `write_file`
- `git_status`
- `git_diff`
- `run_command`

Every filesystem path is resolved against the selected workspace. Parent traversal and symlink escapes are rejected. `Allow` runs the request, `Ask` opens a one-time approval dialog in the app for HTTP connections, and `Blocked` rejects it. Stdio runs without a desktop approval channel, so `Ask` is rejected safely.

Run `npm run test:mcp` while the desktop server is active to verify Streamable HTTP, or `npm run test:mcp:stdio` to verify the local stdio launcher. See `mcp-config.example.json` for a client configuration example.
