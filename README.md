# Hearth Control

A local macOS desktop control center, built with Electron, React, TypeScript, and Vite.

## 🚨 READ FIRST — Canonical continuation path

**Last updated: 2026-09-18**

This section is the project handoff/source of truth for any new ChatGPT/Codex/AI session. **Do not start a fresh architecture plan, choose a different next feature, or rediscover the roadmap from scratch.** Read this section first, inspect only the files needed for the current phase, and continue the first incomplete priority below.

```text
CURRENT_PHASE = P2_REMOTE_ONE_CLICK_UPDATER
NEXT_PHASE = P3_CONNECTION_REGISTRY
STATUS = READY_FOR_P2
BASELINE_MAIN = afdf3578f1e31c52f86bd12bc41fe18d171b4bd0
ACTIVE_BRANCH = main
MAC_RUNTIME_VALIDATION = PASS
BLOCKED_BY = none
LAST_COMPLETED_STEP = P1 Skill Registry integration closed, validated, installed, Smoke 007 passed, remote sync verified, baseline frozen and merged to main
NEXT_EXACT_ACTION = read docs/REMOTE-ONE-CLICK-UPDATER-V1.md and create the P2 branch from current main
VALIDATION_REQUIRED = P1 complete: 294/294 regression PASS; installed Main Smoke 007 PASS; remote Goal projection PASS
DO_NOT_START = P3/P4/P5/P6/P7/P8/P9 until P2 is completed
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

`main` contains the merged and validated P0 (Skill v1) and P1 (X Skill Integration + Remote Sync Fix) baselines.

P2 work will be authored on a dedicated branch created from `main` (`feature/remote-one-click-updater-v1`).

---

## ✅ Canonical progress checklist — MUST be maintained

This checklist is the handoff ledger for every future chat/agent. **A phase is not complete until its evidence is recorded here.** When a phase finishes, mark its checkbox, add the completion record, update `CURRENT_PHASE`, `NEXT_PHASE`, `ACTIVE_BRANCH`, and the exact next action before doing later work.

### Overall roadmap

- [x] **P0 — Validate and merge Hearth Skill v1**
- [x] **P1 — Wire Skill Registry into X**
- [ ] **P2 — Remote One-Click Updater** ← CURRENT
- [ ] **P3 — Connection Registry + Secure Credential Store**
- [ ] **P4 — GitHub multi-connection (2+)**
- [ ] **P5 — Supabase multi-project (2+)**
- [ ] **P6 — Vercel connection**
- [ ] **P7 — Console / connection health / approvals / evidence**
- [ ] **P8 — Multi-Agent Router + universal `ส่งงาน:` ingress**
- [ ] **P9 — Full UI redesign LAST**

### P0 detailed checklist — current truth

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
- [x] Update `BASELINE_MAIN` to the new merged `main` HEAD
- [x] Set `CURRENT_PHASE = P1_X_SKILL_INTEGRATION`
- [x] Set the new `ACTIVE_BRANCH` for P1 before coding

### P1 detailed checklist — current truth

- [x] Create branch `feature/x-skill-integration-v1` from merged `main`
- [x] Design and implement Skill integration into X: `mcp/x/skill-integration.mjs`
- [x] Wire Skill selection and loading into LocalExecutor (`mcp/x/local-executor.mjs`)
- [x] Preserve strict read-only authority enforcement (`repo_edit` sole write gate)
- [x] Support safe Review Queue reject resolution (`mcp/goals/model.mjs`, `mcp/goals/runner.mjs`, `mcp/tools.mjs`)
- [x] Dynamic path-scope schema and eligible file enums preserved
- [x] Goal remote sync fix: automatic projection on durable persistence (`goalRunner.onGoalPersisted`)
- [x] P1 supervisor integration test: `scripts/test-x-skill-integration.mjs` (22/22 PASS)
- [x] Core X regression: 159/159 PASS
- [x] Full regression suite: 294/294 PASS
- [x] Packaged macOS arm64 release and installed `/Applications/Hearth Control.app`
- [x] Installed `app.asar` SHA256 matches release: `f75ffc3888817aca39e093192e703861ec6b8320ceffd72fd66d41e2edb94962`
- [x] Post-install smoke 007 PASS (zero mutation, validation pass, automatic Supabase sync)
- [x] Freeze baseline commit `66489b9134de02f0482671cb8b8ce1c18e169a4d` with tag `hearth-p1-validated-20260918`
- [x] Merge `feature/x-skill-integration-v1` into `main`

### P0 validation evidence — 2026-09-17

```text
BRANCH = feature/hearth-skill-v1-repo-inspect
PRE_MERGE_HEAD = 6d1c6d754d875d0855c8c25bf1aff227341ff2c9 (before this evidence-only README commit)
BASELINE_MAIN = 750e42be30c2e5bef4ddd8d86051cdedb8089bc1

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
Remote compare before evidence commit = branch ahead of main, behind by 0
```

Expected pre-merge changed-file scope:

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

### Completion records

```text
PHASE_COMPLETED = P0
STATUS = PASS
COMPLETED_AT = 2026-09-17
BRANCH = feature/hearth-skill-v1-repo-inspect
MERGED_MAIN_HEAD = 764116776806a665dce10a716c91921c10e87d8d
VALIDATION = test:skill-registry 10/10 PASS; skill-definitions 4/4 PASS; test:local-skills 46/46 PASS; build PASS
FILES/ARCHITECTURE = docs/HEARTH-SKILL-V1.md, mcp/skills/registry.mjs, initial skill definitions (repo-inspect, bug-fix, test-regression)
KNOWN_LIMITATIONS = none
NEXT_PHASE = P1
NEXT_EXACT_ACTION = wire Skill Registry into X via feature/x-skill-integration-v1
```

```text
PHASE_COMPLETED = P1
STATUS = PASS
COMPLETED_AT = 2026-09-18
BRANCH = feature/x-skill-integration-v1
MERGED_MAIN_HEAD = afdf3578f1e31c52f86bd12bc41fe18d171b4bd0
VALIDATED_BASELINE = 66489b9134de02f0482671cb8b8ce1c18e169a4d
TAG = hearth-p1-validated-20260918
VALIDATION = 294/294 PASS + Smoke 007 PASS
INSTALLED_APP_ASAR_SHA256 = f75ffc3888817aca39e093192e703861ec6b8320ceffd72fd66d41e2edb94962
FILES/ARCHITECTURE = mcp/x/skill-integration.mjs, LocalExecutor skill loading & prompt injection, repo_edit-only authority enforcement, Review Queue reject support, dynamic path-scope schema, goalRunner.onGoalPersisted automatic remote Goal sync
KNOWN_LIMITATIONS = evidence text count normalization mismatch (38/38+23/23 text vs 46/46+15/15 structured); non-blocking separate follow-up
NEXT_PHASE = P2
NEXT_EXACT_ACTION = read docs/REMOTE-ONE-CLICK-UPDATER-V1.md before implementation
```

### Session handoff checklist — update before changing chats

Before ending a substantial session or moving to another chat, the current agent must verify:

- [x] `CURRENT_PHASE` matches the first unfinished roadmap phase.
- [x] `STATUS`, `BLOCKED_BY`, `LAST_COMPLETED_STEP`, `NEXT_EXACT_ACTION`, `VALIDATION_REQUIRED`, and `DO_NOT_START` reflect current truth.
- [x] The completed work in that phase is checked off above.
- [x] Validation evidence is recorded; do not mark runtime work complete from code inspection alone.
- [x] `ACTIVE_BRANCH` is correct.
- [x] `BASELINE_MAIN` is updated if a merge occurred.
- [x] `NEXT_PHASE` is correct.
- [x] `NEXT_EXACT_ACTION` is the first concrete action only; do not make a new chat infer it from prose.
- [x] Any locked design document path is named so the next chat does not invent a second architecture.
- [x] Known failures/blockers are written explicitly.
- [x] No later phase was started while an earlier required checklist item remained incomplete, unless the user explicitly changed priorities.

**Rule:** if the README and a chat summary disagree, inspect Git/relevant evidence and update this README first. Once corrected, this README becomes the continuation source of truth again.

---

## Canonical priority order

### P0 — Validate and merge Hearth Skill v1 branch **NOW**

Do this first when the Mac is available. Do not add more features before this branch is validated.

Required actions:

```bash
git checkout feature/hearth-skill-v1-repo-inspect
git pull
npm run test:skill-registry
node --test scripts/test-skill-definitions.mjs
npm run test:local-skills
npm run build
git diff --check
```

Then inspect `git status`, `git diff main...HEAD`, and test output. Fix only failures caused by this branch. Do not redesign unrelated stable subsystems.

Acceptance for P0:

```text
Skill Registry tests PASS
Skill definition tests PASS
existing Local Skills tests PASS
production build/typecheck PASS
git diff --check PASS
no unintended generated/source changes
```

After evidence is clean, merge this branch to `main`. Update this README phase marker to `P1_X_SKILL_INTEGRATION`.

### P1 — Wire Skill Registry into X

After P0 is merged, integrate the declarative Skill Registry with X using the smallest safe hook.

Locked rules:

- Reuse `mcp/skills/registry.mjs`.
- Reuse existing `mcp/skills/gateway.mjs` and `mcp/skills/test-runner.mjs` as tool execution layers.
- Skills are playbooks/policy consumers; they never grant permissions.
- Task constraints + Hearth permissions always override Skill metadata.
- No shell fallback when a Skill tool is unavailable.
- Do not redesign X claim/run stores, dispatcher, durable runtime, continuation, or Result Gate.
- Do not add more Skill categories until the three current definitions (`repo-inspect`, `bug-fix`, `test-regression`) can be selected/loaded and tested end-to-end.

Canonical Skill spec: `docs/HEARTH-SKILL-V1.md`.

Completion means X can load the appropriate current Skill definition, intersect requested tools with allowed tools, execute through existing safe tool layers, and return evidence without bypassing current task/approval constraints.

### P2 — Remote One-Click Updater

This is next because manual DMG drag/Replace creates friction on every iteration.

Create a **new branch from then-current `main`** after P1 is complete (or after P1 is safely merged if work is split). Do not implement Remote Updater on the current Skill branch.

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

When this phase starts, split the current large `src/App.tsx`/styles into clear pages/components without silently changing runtime/business behavior.

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