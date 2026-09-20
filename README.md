# Hearth Control

A local macOS desktop control center, built with Electron, React, TypeScript, and Vite.

## 🚨 READ FIRST — Canonical continuation path

**Last updated: 2026-09-20**

This section is the project handoff/source of truth for any new ChatGPT/Codex/AI session. **Do not start a fresh architecture plan, choose a different next feature, or rediscover the roadmap from scratch.** Read this section first, verify Git state, and continue only the canonical next action below.

## CURRENT STATUS

```text
PHASE = P9_FULL_UI_REDESIGN — COMPLETE / VALIDATED
CURRENT_BRANCH = main
VALIDATED_MAIN_COMMIT = 1de00f330bb60bc3e6faaf2399d4ef5d6c0cef51
RELEASE_VERSION = 0.4.9
RELEASE_BUILD = 0.4.9-20260920153122-5186af
RELEASE_TAG = v0.4.9-20260920153122-5186af
FINAL_GATE = MAIN_0.4.9_PRODUCTION_E2E_PASS
STATUS = P9_COMPLETE_AND_UPDATER_0.4.9_PRODUCTION_VALIDATED
BLOCKED_BY = none
LAST_COMPLETED_STEP = One-Click Updater production E2E validated: 0.4.8 -> 0.4.9, download/verify/stage/recovery/install/restart/UP_TO_DATE all PASS
NEXT_PHASE = MARKET_SPECIALISTS_V1
NEXT_EXACT_ACTION = compare feature/market-specialists-v1 against current main, preserve the validated 0.4.9 updater baseline, then continue approved Invest/MT5 work
DO_NOT_MODIFY_FROZEN = X v0.1, P2 updater core, P3-P9 validated behavior unless an actual regression/security issue or explicitly approved work requires a targeted change
```

**Continuation rule:** Git/source is authoritative over chat history. Verify branch, HEAD, tag, and worktree before editing. Do not modify frozen X/P2/P3/P4/P5/P6/P7/P8 behavior unless a regression/security issue or the approved current phase requires a targeted extension. Continue only `NEXT_EXACT_ACTION`.

### Current validated/stable direction

Hearth is the trusted execution/control plane. X is the local coding worker. External services are consumed through Hearth-controlled connections and permission boundaries. Existing durable runtime, claims, continuation/recovery, Goal Runner, approval boundaries, frozen X v0.1, and validated P2 install/rollback path are established components and must not be casually redesigned.

The role split is:

```text
ChatGPT / Supervisor
  -> planning, diagnosis, task design, acceptance criteria

Hearth
  -> trusted execution/control plane
  -> permissions, runtime state, evidence, routing
  -> connection and credential authority

X
  -> local coder worker

GitHub / Supabase / Vercel / AI providers
  -> external integrations through Hearth-controlled connections
```

### Current active branch — validated baseline

`main` is the canonical branch and now contains the validated P8 implementation checkpoint:

```text
P8_VALIDATED_IMPLEMENTATION_COMMIT = 016225615855f65e0c11cf048c6f8a654b481a88
P8_TAG = hearth-p8-validated-0.4.7-20260920
P8_FINAL_GATE = P8_MAIN_FINAL_GATE_PASS
P7_TAG = hearth-p7-validated-0.4.7-20260920
P6_TAG = hearth-p6-validated-0.4.7-20260920
P5_TAG = hearth-p5-validated-0.4.7-20260920
P4_TAG = hearth-p4-validated-0.4.7-20260919
P3_TAG = hearth-p3-validated-0.4.7-20260919
P2_TAG = hearth-p2-validated-0.4.7-20260919
```

P0, P1, X v0.1, P2, P3, P4, P5, P6, P7, and P8 histories are preserved in Git. X/P2/P3/P4/P5/P6/P7/P8 are frozen unless a real regression/security issue or an explicitly approved later phase requires a targeted change.

---

## ✅ Canonical progress checklist — MUST be maintained

This checklist is the handoff ledger for every future chat/agent. **A phase is not complete until its evidence is recorded here.** When a phase finishes, mark its checkbox, add the completion record, update `CURRENT_PHASE`, `NEXT_PHASE`, `ACTIVE_BRANCH`, and the exact next action before doing later work.

### Overall roadmap

- [x] **P0 — Validate and merge Hearth Skill v1**
- [x] **P1 — Wire Skill Registry into X**
- [x] **P2 — Remote One-Click Updater** — VALIDATED / FROZEN
- [x] **P3 — Connection Registry + Secure Credential Store** — VALIDATED / FROZEN
- [x] **P4 — GitHub multi-connection (2+)** — VALIDATED / FROZEN
- [x] **P5 — Supabase multi-project (2+)** — VALIDATED / FROZEN
- [x] **P6 — Vercel connection** — VALIDATED / FROZEN
- [x] **P7 — Console / connection health / approvals / evidence** — VALIDATED / FROZEN
- [x] **P8 — Multi-Agent Router + universal `ส่งงาน:` ingress** — VALIDATED / FROZEN
- [ ] **P9 — Full UI redesign LAST**

### P4 detailed checklist — current truth

- [x] Push P3 validated `main` checkpoint to `origin/main`
- [x] Push annotated tag `hearth-p3-validated-0.4.7-20260919`
- [x] Verify remote `main` = `99c2b91c4843e1268c472c31859966df9623ce2b`
- [x] Verify remote P3 tag dereferences to validated implementation commit `474a4f6f3994d13136d467bf6105a2a1486aad6b`
- [x] Create `feature/p4-github-multi-connection-v1`
- [x] Audit existing GitHub surfaces: no GitHub REST client/auth/tools in Hearth; P2 updater is public/fixed-trust only
- [x] Confirm P3 already seeds `github:personal` and `github:work` with separate credential refs
- [x] Confirm machine has GitHub CLI + macOS keyring auth, but global active-account state is unsuitable as Hearth multi-connection authority
- [x] Lock P4 V1 auth to local fine-grained PAT per alias; never import/copy `gh` token state
- [x] Lock GitHub API authority to fixed `https://api.github.com`; no arbitrary base URL in V1
- [x] Lock explicit alias requirement for every GitHub data/action tool; no default/fallback account
- [x] Lock P2 updater isolation from P4 credentials
- [x] Lock generic Git push/merge/delete/release/admin out of P4 V1 token path
- [x] Author canonical design: `docs/HEARTH-GITHUB-MULTI-CONNECTION-V1.md`
- [x] P4.1 — GitHub fixed-origin REST client + focused tests
- [x] P4.2 — local connect/disconnect + remote health
- [x] P4.3 — dual-account isolation tests
- [x] P4.4 — read-only MCP tools with explicit connection alias
- [x] P4.5 — first approved mutation (`github_pull_request_create`) after read path stabilized; capability + Git permission/approval gated
- [x] P4.6 — full regression / checkpoint / freeze — PASS; implementation commit `cf9e24dd4e3d0bd19e68c0ebf71a777e58056148`, tag `hearth-p4-validated-0.4.7-20260919`, fast-forward merged to `main`

### P4 validation evidence — 2026-09-19 (main Final Gate)

```text
BRANCH = main
VALIDATED_MAIN_COMMIT = cf9e24dd4e3d0bd19e68c0ebf71a777e58056148
TAG = hearth-p4-validated-0.4.7-20260919
FINAL_GATE = P4_MAIN_FINAL_GATE_PASS

npm run test:github
  PASS = 30/30
  FAIL = 0
  includes real HTTP-child -> Electron-style parent IPC round-trip with no credential fields in child message

npm run test:connections
  PASS = 18/18
  FAIL = 0

X MCP tools regression
  PASS = 21/21
  FAIL = 0

Project X auth
  PASS = 13/13
  FAIL = 0

Bridge
  PASS = 46/46
  FAIL = 0

Electron/main/preload/server integration
  PASS = 98/98
  FAIL = 0

Goal/Review/Remote Goal
  PASS = all executed suites
  FAIL = 0

P2 updater regression
  PASS = 149/149
  FAIL = 0

X full regression
  PASS = 616/617
  FAIL = 1 PRE-EXISTING BASELINE TEST MISMATCH ONLY
  PRE_EXISTING = scripts/test-x-terminal-event.mjs EVT12 expects a non-async serverProcess message handler, while validated baseline already uses async (message) =>

npm run build
  PASS
  TypeScript = PASS
  Vite production build = PASS
  stable build metadata restored after validation

Runtime syntax checks
  PASS

git diff --check
  PASS
```

P4 V1 security/architecture evidence:

```text
GitHub API authority = fixed https://api.github.com
GitHub REST version = 2026-03-10
Accepted local credential shape = fine-grained PAT prefix github_pat_
Credential storage = P3 SecureCredentialStore only
github:personal and github:work = simultaneous + isolated
global gh auth switch/token import = NOT USED
MCP credential setter/getter = NONE
MCP GitHub tools = explicit alias required
PR create = pull_request.create capability + Hearth Git permission + exact approval when Git=Ask
generic push/merge/delete/release/admin = OUT OF SCOPE / ABSENT
P2 GitHub Releases updater = unchanged / credential-independent
Connection management UI = deferred to P7; P4 exposes local renderer IPC only
```

### P5 detailed checklist — current truth

- [x] Push P4 validated `main` + `hearth-p4-validated-0.4.7-20260919`
- [x] Create `feature/p5-supabase-multi-project-v1` from `main@2299ce6deff8070fb4e4d73faf51c0ae697e8342`
- [x] Audit existing two-project runtime: `supabase:hearth` Bridge and `supabase:xgen` PublicTasks/Review/Goal are already separate clients/auth domains
- [x] Lock canonical design: `docs/HEARTH-SUPABASE-MULTI-PROJECT-V1.md`
- [x] Classify project URL + publishable/legacy-anon key as provider config; user access/refresh session remains P3 encrypted credential
- [x] Reject `sb_secret_...` and legacy `service_role` keys in P5 V1
- [x] Add strict hosted-Supabase URL validation and no arbitrary origin/default alias fallback
- [x] Add `SupabaseProjectService` for explicit alias config/auth/remote health/public snapshot
- [x] Extend registry Supabase targets with publishable-key config sourced from compatibility settings
- [x] Migrate Hearth auth wrapper to explicit `supabase:hearth`
- [x] Migrate Project X auth wrapper to explicit `supabase:xgen`
- [x] Initialize HearthBridgeClient from Hearth alias config only
- [x] Initialize PublicTasks/ReviewItems/GoalRequests clients from XGEN alias config only
- [x] Migrate `hearth_devices` REST calls to Hearth alias config
- [x] Dispatch `connections:list/refresh` through Supabase provider snapshots/remote health
- [x] Fix Project X publishable-key live update so PublicTasks/ReviewItems/GoalRequests all receive the same updated XGEN config
- [x] Preserve legacy settings fields only as compatibility persistence; runtime authority is alias-driven
- [x] `npm run test:supabase` — 28/28 PASS
- [x] Bridge — 46/46 PASS
- [x] PublicTasksClient — 27/27 PASS
- [x] Review Queue sync/tools — 15/15 PASS
- [x] Remote Goal ingress — 24/24 PASS
- [x] P3 Connections — 18/18 PASS
- [x] P4 GitHub — 30/30 PASS
- [x] Electron/server integration — 98/98 PASS
- [x] Goal/Review/Remote Goal — all executed suites PASS
- [x] P2 updater — 149/149 PASS
- [x] production build + TypeScript — PASS
- [x] runtime syntax + `git diff --check` — PASS
- [x] X full regression — 616/617 PASS; sole failure is pre-existing EVT12 source-regex mismatch
- [x] Create P5 implementation checkpoint commit — `034e34479e0f37866c264a694ba705caee5869d4`
- [x] Fast-forward merge validated P5 branch into `main`
- [x] Run P5 Main Final Gate — PASS
- [x] Create validated P5 tag and push `main` + tag — remote `main` verified at `f6b8922e6971949c69f55b710e0499853a4d8207`; tag dereferences to `034e34479e0f37866c264a694ba705caee5869d4`

### P5 validation evidence — 2026-09-20 (main Final Gate)

```text
BRANCH = main
VALIDATED_MAIN_COMMIT = 034e34479e0f37866c264a694ba705caee5869d4
TAG = hearth-p5-validated-0.4.7-20260920
FINAL_GATE = P5_MAIN_FINAL_GATE_PASS

npm run test:supabase
  PASS = 28/28
  FAIL = 0

Bridge
  PASS = 46/46
  FAIL = 0

PublicTasksClient
  PASS = 27/27
  FAIL = 0

Review Queue sync/tools
  PASS = 15/15
  FAIL = 0

Remote Goal ingress
  PASS = 24/24
  FAIL = 0

npm run test:connections
  PASS = 18/18
  FAIL = 0

npm run test:github
  PASS = 30/30
  FAIL = 0

Electron/main/preload/server integration
  PASS = 98/98
  FAIL = 0

Goal/Review/Remote Goal
  PASS = all executed suites
  FAIL = 0

P2 updater
  PASS = 149/149
  FAIL = 0

X full regression
  PASS = 616/617
  FAIL = 1 PRE-EXISTING BASELINE TEST MISMATCH ONLY
  PRE_EXISTING = scripts/test-x-terminal-event.mjs EVT12 source-regex expects non-async serverProcess message handler while validated baseline already uses async (message) =>

npm run build
  PASS
  TypeScript = PASS
  Vite production build = PASS
  stable build metadata restored after validation

SECURITY / ISOLATION =
  supabase:hearth and supabase:xgen project config/session remain separate
  no default/fallback alias
  sb_secret_ and service_role forbidden
  public connection snapshot does not expose publishable key value or session credential
  runtime auth/client/device operations resolve through alias authority
```

### P6 detailed checklist — current truth

- [x] Create `feature/p6-vercel-connection-v1` from `main@8c561b7bef66a3d15e9bc26b3e85b731ee1b0e04`
- [x] Audit Vercel surfaces: no existing Vercel REST client/auth/MCP tools; CLI is installed/authenticated globally but Hearth repo is not `.vercel` linked
- [x] Lock canonical design: `docs/HEARTH-VERCEL-CONNECTION-V1.md`
- [x] Reuse P3 alias `vercel:main` + `credential:vercel:main`; do not import Vercel CLI/global token state
- [x] Fixed REST authority `https://api.vercel.com`; no arbitrary base URL
- [x] Accept bounded personal/legacy opaque access tokens; reject identifiable app/integration/refresh/API-key token types
- [x] Validate remote `GET /v2/user` identity before credential persistence
- [x] Add optional explicit `teamId` metadata with stale-team clearing on personal reconnect
- [x] Grant default capabilities `project.read` + `deployment.read` only
- [x] Add local renderer IPC `vercel:connect` / `vercel:disconnect` with no credential getter
- [x] Dispatch `connections:list/refresh` through Vercel provider snapshot/remote health
- [x] Add read-only MCP tools: `vercel_projects_list`, `vercel_project_get`, `vercel_deployments_list`, `vercel_deployment_get`
- [x] Add dedicated Hearth permission `Vercel = Ask`; Ask/Blocked stop requests before provider transport
- [x] Prove HTTP child -> Electron parent transport carries no token/credential material
- [x] Keep deployment creation/promote/rollback, domain mutation, env read/write, and project admin tools absent in P6 V1
- [x] `npm run test:vercel` — 31/31 PASS
- [x] P3 Connections — 18/18 PASS
- [x] P4 GitHub — 30/30 PASS
- [x] P5 Supabase — 28/28 PASS
- [x] Electron/HTTP + X MCP registry — 119/119 PASS
- [x] Bridge standalone — 46/46 PASS
- [x] Goal/Review/Remote Goal — all executed suites PASS
- [x] P2 updater — 149/149 PASS
- [x] production build + TypeScript — PASS
- [x] X full regression — 616/617 PASS; sole failure is pre-existing EVT12 source-regex mismatch
- [x] Create P6 implementation checkpoint commit — `6fc48dd876ebde72af2d49981dde16c0268b2e02`
- [x] Fast-forward merge validated P6 branch into `main`
- [x] Run P6 Main Final Gate — PASS
- [x] Create validated P6 tag and push `main` + tag — remote `main` verified at `f0adadecb09a24473bdde3cae3129f138d8338fd`; tag dereferences to `6fc48dd876ebde72af2d49981dde16c0268b2e02`

### P6 validation evidence — 2026-09-20 (main Final Gate)

```text
BRANCH = main
VALIDATED_MAIN_COMMIT = 6fc48dd876ebde72af2d49981dde16c0268b2e02
TAG = hearth-p6-validated-0.4.7-20260920
FINAL_GATE = P6_MAIN_FINAL_GATE_PASS

npm run test:vercel
  PASS = 31/31
  FAIL = 0
  includes HTTP child -> parent IPC round-trip with no credential fields

npm run test:connections
  PASS = 18/18
  FAIL = 0

npm run test:github
  PASS = 30/30
  FAIL = 0

npm run test:supabase
  PASS = 28/28
  FAIL = 0

Electron/HTTP + X MCP registry
  PASS = 119/119
  FAIL = 0

Bridge standalone
  PASS = 46/46
  FAIL = 0

Goal/Review/Remote Goal
  PASS = all executed suites
  FAIL = 0

P2 updater
  PASS = 149/149
  FAIL = 0

X full regression
  PASS = 616/617
  FAIL = 1 PRE-EXISTING BASELINE TEST MISMATCH ONLY
  PRE_EXISTING = scripts/test-x-terminal-event.mjs EVT12 source-regex expects non-async serverProcess message handler while validated baseline already uses async (message) =>

npm run build
  PASS
  TypeScript = PASS
  Vite production build = PASS
  stable build metadata restored after validation

SECURITY / AUTHORITY =
  token storage = P3 SecureCredentialStore only
  Vercel CLI/global auth import = NONE
  API origin = fixed https://api.vercel.com
  alias = explicit vercel:main only
  teamId = explicit non-secret metadata
  default capabilities = project.read + deployment.read only
  Hearth permission = Vercel Ask/Allow/Blocked
  mutation tools = NONE

LIVE_PROVIDER_SMOKE =
  not performed through Hearth because no P6 PAT was entered into Hearth;
  global Vercel CLI credential was deliberately not imported or exposed.
```

### P7 detailed checklist — current truth

- [x] Create `feature/p7-console-v1` from `main@bddfb90ec9b12a9eb0a0cd4d1fed33f0a0d726ed`
- [x] Audit existing Overview/Permissions/Logs/connection/approval/evidence surfaces instead of creating a parallel backend
- [x] Lock canonical design: `docs/HEARTH-OPERATIONAL-CONSOLE-V1.md`
- [x] Add first-class `Console` navigation/page without removing existing pages
- [x] Reuse `connections:list` and `connections:refresh` for renderer-safe connection health
- [x] Render alias/provider/status/account/capabilities/last checked/error only; do not render provider target/auth/stored credential material
- [x] Add local GitHub Connect/Reconnect/Disconnect using existing P4 IPC only
- [x] Add local Vercel Connect/Reconnect/Disconnect using existing P6 IPC only
- [x] Keep connection token inputs transient/password-style; clear after successful connect; no localStorage/settings/log writes
- [x] Keep Supabase authentication in existing Remote Bridge / Project X surfaces; no duplicate Supabase login path
- [x] Show pending approvals as status-only; existing approval modal remains the only decision path
- [x] Add bounded current-session approval history (40 max) from existing approval/resolution events
- [x] Label system logs and approval history explicitly as current-session evidence
- [x] Summarize durable Goal checkpoints read-only from already-persisted Goal Runner evidence
- [x] Add no `console:` backend IPC namespace, no new durable store, no new execution route, and no provider mutation action
- [x] Remove stale fixed `8 MCP tools` UI copy
- [x] `npm run test:console` — 10/10 PASS
- [x] P3 Connections — 18/18 PASS
- [x] P4 GitHub — 30/30 PASS
- [x] P5 Supabase — 28/28 PASS
- [x] P6 Vercel — 31/31 PASS
- [x] Electron/HTTP + X MCP registry — 119/119 PASS
- [x] Bridge standalone — 46/46 PASS
- [x] Goal/Review/Remote Goal — all executed suites PASS
- [x] P2 updater — 149/149 PASS
- [x] production build + TypeScript — PASS
- [x] X full regression — 616/617 PASS; sole failure is pre-existing EVT12 source-regex mismatch
- [x] runtime scope audit + `git diff --check` — PASS
- [x] Create P7 implementation checkpoint commit — `7865119f9e242099db9ba30b9215e0fd5dfd9a8d`
- [x] Fast-forward merge validated P7 branch into `main`
- [x] Run P7 Main Final Gate — PASS
- [x] Create validated P7 tag and push `main` + tag — remote `main` verified at `2218c3a76308e4487cc2f4fab93f6e476af68f6d`; tag dereferences to `7865119f9e242099db9ba30b9215e0fd5dfd9a8d`

### P7 validation evidence — 2026-09-20 (main Final Gate)

```text
BRANCH = main
VALIDATED_MAIN_COMMIT = 7865119f9e242099db9ba30b9215e0fd5dfd9a8d
TAG = hearth-p7-validated-0.4.7-20260920
FINAL_GATE = P7_MAIN_FINAL_GATE_PASS

npm run test:console
  PASS = 10/10
  FAIL = 0

npm run test:connections
  PASS = 18/18
  FAIL = 0

npm run test:github
  PASS = 30/30
  FAIL = 0

npm run test:supabase
  PASS = 28/28
  FAIL = 0

npm run test:vercel
  PASS = 31/31
  FAIL = 0

Electron/HTTP + X MCP registry
  PASS = 119/119
  FAIL = 0

Bridge standalone
  PASS = 46/46
  FAIL = 0

Goal/Review/Remote Goal
  PASS = all executed suites
  FAIL = 0

P2 updater
  PASS = 149/149
  FAIL = 0

X full regression
  PASS = 616/617
  FAIL = 1 PRE-EXISTING BASELINE TEST MISMATCH ONLY
  PRE_EXISTING = scripts/test-x-terminal-event.mjs EVT12 source-regex expects non-async serverProcess message handler while validated baseline already uses async (message) =>

npm run build
  PASS
  TypeScript = PASS
  Vite production build = PASS
  stable build metadata restored after validation

SCOPE / SECURITY =
  backend/runtime authority changes = NONE
  new console IPC namespace = NONE
  GitHub/Vercel management = existing local P4/P6 IPC only
  Supabase auth duplication = NONE
  stored credential readback = NONE
  token input persistence/logging = NONE
  approval decision path from Console = NONE
  current-session evidence is labeled non-durable
  durable evidence source = existing Goal checkpoints
```

### P8 detailed checklist — current truth

- [x] Create `feature/p8-multi-agent-router-v1` from `main@d0278c4c6ba0f90fd895164fa268bcf7818a1730`
- [x] Audit current X queue, Antigravity TaskStore, JobManager, Goal Runner, Review Queue, and specialist lifecycle before adding any router
- [x] Confirm existing specialist lifecycle already supports handoff -> authorization -> Codex JobManager dispatch -> result -> human accept/reject
- [x] Lock canonical design: `docs/HEARTH-MULTI-AGENT-ROUTER-V1.md`
- [x] Add strict `hearth-job-v1` generic contract with semantic kinds only: `code_change`, `code_inspect`, `general`
- [x] Reject unknown fields and caller-supplied worker/agent/provider/workspace/repair-budget authority
- [x] Redact secret-shaped generic text before routing
- [x] Deterministically route `code_change` / `code_inspect` to X and `general` to Antigravity
- [x] Keep Codex outside fresh-job routing; existing specialist lifecycle remains the only Codex execution path in P8 V1
- [x] Adapt code jobs internally to complete `x-task-v1` with canonical repair/timing/commit policy
- [x] Derive X workspace root from authoritative Hearth workspace transport; generic payload cannot choose a filesystem root
- [x] Include normalized generic-job fingerprint in adapted X evidence so same job_id + changed generic payload conflicts through existing X receipt fingerprinting
- [x] Reuse Electron `ingestXTask` for universal X submit; no P8 X queue/run store
- [x] Reuse Electron-owned Antigravity TaskStore/runtime with `taskId = hearthjob:<job_id>`
- [x] Persist Antigravity generic fingerprint in existing `requestId`; same identical job returns existing task, changed payload fails closed
- [x] Fail closed on cross-route/dual-route ambiguity
- [x] Add MCP tools `hearth_job_submit` and `hearth_job_status`
- [x] Route universal MCP calls through Electron-owned HTTP IPC; no direct universal worker execution in MCP child
- [x] Add transport cancellation so disconnect during approval removes waiter and prevents pre-commit execution
- [x] Reuse existing X and Antigravity Blocked/Ask/Allow permission boundaries
- [x] Status reads only existing X receipt / Antigravity TaskStore truth; no P8 status database
- [x] Focused P8 router/transport/TaskStore suite — 24/24 PASS
- [x] Fresh HTTP child round-trip exposes universal submit/status through parent IPC
- [x] stdio tool discovery exposes `hearth_job_submit` + `hearth_job_status`
- [x] P3 Connections — 18/18 PASS
- [x] P4 GitHub — 30/30 PASS
- [x] P5 Supabase — 28/28 PASS
- [x] P6 Vercel — 31/31 PASS
- [x] P7 Console — 10/10 PASS
- [x] Electron/HTTP + X MCP registry — 119/119 PASS
- [x] Bridge standalone — 46/46 PASS
- [x] Goal/Review/Remote Goal — all executed suites PASS
- [x] P2 updater — 149/149 PASS
- [x] production build + TypeScript — PASS
- [x] X full regression — 616/617 PASS; sole failure is pre-existing EVT12 source-regex mismatch
- [x] syntax + `git diff --check` — PASS
- [x] Create P8 implementation checkpoint commit — `016225615855f65e0c11cf048c6f8a654b481a88`
- [x] Fast-forward merge validated P8 branch into `main`
- [x] Run P8 Main Final Gate — PASS
- [x] Create validated P8 tag and push `main` + tag — remote `main` verified at `311e19dd29ab5ca781a2b5981e78c5f0e2ebdaba`; tag dereferences to `016225615855f65e0c11cf048c6f8a654b481a88`

### P8 validation evidence — 2026-09-20 (main Final Gate)

```text
BRANCH = main
VALIDATED_MAIN_COMMIT = 016225615855f65e0c11cf048c6f8a654b481a88
TAG = hearth-p8-validated-0.4.7-20260920
FINAL_GATE = P8_MAIN_FINAL_GATE_PASS

npm run test:router
  PASS = 24/24
  FAIL = 0
  COVERAGE = generic contract, no worker authority, X adapter, secret redaction, fresh HTTP IPC, Electron boundary, cancellation wiring, TaskStore Antigravity identity smoke

npm run test:connections
  PASS = 18/18

npm run test:github
  PASS = 30/30

npm run test:supabase
  PASS = 28/28

npm run test:vercel
  PASS = 31/31

npm run test:console
  PASS = 10/10

Electron/HTTP + X MCP registry
  PASS = 119/119
  FAIL = 0

Bridge standalone
  PASS = 46/46
  FAIL = 0

Goal/Review/Remote Goal
  PASS = all executed suites
  FAIL = 0

P2 updater
  PASS = 149/149
  FAIL = 0

X full regression
  PASS = 616/617
  FAIL = 1 PRE-EXISTING BASELINE TEST MISMATCH ONLY
  PRE_EXISTING = scripts/test-x-terminal-event.mjs EVT12 source-regex expects non-async serverProcess message handler while validated baseline already uses async (message) =>

npm run build
  PASS
  TypeScript = PASS
  Vite production build = PASS
  stable build metadata restored after validation

MCP discovery
  stdio source process = PASS and exposes hearth_job_submit/hearth_job_status
  fresh P8 HTTP child = PASS and round-trips submit/status over parent IPC
  currently-running port 3001 process = older pre-P8 child; restart required before that live process advertises P8 tools

SECURITY / ARCHITECTURE =
  new executor/runtime/store = NONE
  generic durable status database = NONE
  direct fresh-job Codex route = NONE
  generic worker/provider selection field = NONE
  generic workspace-root authority = NONE
  generic secret-shaped text = redacted before routing
  X route = existing ingestXTask / X queue authority
  Antigravity route = existing Electron TaskStore + shared admission authority
  permission bypass = NONE
  disconnect during approval = aborts pre-commit waiter
```

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

### P3 detailed checklist — current truth

- [x] Create `feature/p3-connection-registry-v1` from `main@4f261b2f4ba51722ea18968e22cdde631c28bed0`
- [x] Author canonical design: `docs/HEARTH-CONNECTION-REGISTRY-V1.md`
- [x] Add durable non-secret Connection Registry under `mcp/connections/`
- [x] Seed stable aliases: `github:personal`, `github:work`, `supabase:hearth`, `supabase:xgen`, `vercel:main`
- [x] Preserve future provider target/capability metadata when built-in aliases are re-seeded
- [x] Add Electron-main `SecureCredentialStore` backed by `safeStorage`, atomic writes, owner-only file mode, fail-closed behavior
- [x] Add `ConnectionService` with trusted credential resolution and renderer-safe public snapshots
- [x] Keep `supabase:hearth` and `supabase:xgen` credential/session namespaces strictly isolated
- [x] Migrate `bridgeSessionEncrypted`, `publicTasksSessionEncrypted`, and `bridgePairingEncrypted` out of `settings.json` using verify-before-delete migration
- [x] Preserve legacy encrypted settings if secure migration cannot be verified
- [x] Stop all new session/pairing writes to legacy encrypted settings fields
- [x] Harden `settings:get` to strip every `*Encrypted` field and allowlist renderer `settings:save` keys
- [x] Add read-only renderer IPC: `connections:list`, `connections:refresh`
- [x] Add connection states: `UNKNOWN`, `CONNECTED`, `DISCONNECTED`, `EXPIRED`, `NEEDS_REAUTH`, `ERROR`
- [x] Add `npm run test:connections` — 18/18 PASS
- [x] Project X auth boundary regression — 13/13 PASS
- [x] Bridge regression — 46/46 PASS
- [x] Electron/main/preload/server integration regression — 98/98 PASS
- [x] Goal/Review/Remote Goal regressions — PASS (all executed suites)
- [x] P2 updater/final-gate regression group — 149/149 PASS
- [x] X regression group — 616/617 PASS; sole failure `EVT12` is a pre-existing baseline source-regex mismatch (`main` already used `async (message) =>` at `4f261b2`; test regex accepts only non-async shape), not caused by P3
- [x] `npm run build` — PASS; generated build metadata restored to stable `0.4.7-20260919154331-2d91b9`
- [x] Final `git diff --check` + final scoped diff/status review — PASS; untracked P3 text files also checked for trailing whitespace/final newline
- [x] Create P3 checkpoint commit/tag — `474a4f6f3994d13136d467bf6105a2a1486aad6b` / `hearth-p3-validated-0.4.7-20260919`
- [x] Merge validated P3 branch into `main` — fast-forward

### P3 validation evidence — 2026-09-19 (main Final Gate)

```text
BRANCH = main
VALIDATED_MAIN_COMMIT = 474a4f6f3994d13136d467bf6105a2a1486aad6b
TAG = hearth-p3-validated-0.4.7-20260919
FINAL_GATE = P3_MAIN_FINAL_GATE_PASS

npm run test:connections
  PASS = 18/18
  FAIL = 0

node --test scripts/test-electron-public-x-auth.mjs
  PASS = 13/13
  FAIL = 0

node --test scripts/test-bridge.mjs
  PASS = 46/46
  FAIL = 0

Electron/main/preload/server integration regression group
  PASS = 98/98
  FAIL = 0

Goal/Review/Remote Goal regression group
  PASS = all executed suites
  FAIL = 0

P2 updater/final-gate regression group
  PASS = 149/149
  FAIL = 0

X regression group
  PASS = 616/617
  FAIL = 1 PRE-EXISTING BASELINE TEST MISMATCH ONLY
  PRE_EXISTING = scripts/test-x-terminal-event.mjs EVT12 expects non-async serverProcess message handler, while baseline main@4f261b2 already uses async (message) =>

npm run build
  PASS
  TypeScript project build = PASS
  Vite production build = PASS
  generated electron/build-meta.json restored to stable metadata after validation

SECURITY_BOUNDARY =
  credentials.json stores only safeStorage ciphertext
  connections.json stores non-secret metadata only
  renderer receives no credentialRef/token/password/private key/ciphertext
  settings.json receives no new encrypted session/pairing fields
  renderer settings writes are allowlisted
```

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

```text
PHASE_COMPLETED = P2_REMOTE_ONE_CLICK_UPDATER
STATUS = PASS / VALIDATED / FROZEN
COMPLETED_AT = 2026-09-19
VALIDATED_MAIN_COMMIT = 301e64fa216e10bb9a29566e3e3dff29a5620b91
TAG = hearth-p2-validated-20260919
FINAL_GATE = P2_MAIN_FINAL_GATE_PASS
VALIDATION = remote integration 18/18; startup health 4/4; runtime preflight 8/8; local updater 33/33; remote updater P2A/B/C 94/94; Electron lifecycle 12/12; TypeScript PASS; syntax PASS; git diff --check PASS
KNOWN_LIMITATIONS = no blocker remaining for P2 V1; release publication remains a separately authorized operation
NEXT_PHASE = P3_CONNECTION_REGISTRY_SECURE_CREDENTIAL_STORE
NEXT_EXACT_ACTION = audit current Hearth connection/credential architecture and design the smallest P3 foundation without modifying frozen X/P2 behavior
```

```text
PHASE_COMPLETED = P3_CONNECTION_REGISTRY_SECURE_CREDENTIAL_STORE
STATUS = PASS / VALIDATED / FROZEN
COMPLETED_AT = 2026-09-19
VALIDATED_MAIN_COMMIT = 474a4f6f3994d13136d467bf6105a2a1486aad6b
TAG = hearth-p3-validated-0.4.7-20260919
FINAL_GATE = P3_MAIN_FINAL_GATE_PASS
VALIDATION = connections 18/18; Project X auth 13/13; Bridge 46/46; Electron/server 98/98; Goal/Review/Remote Goal all executed suites PASS; P2 updater regression 149/149; production build + TypeScript PASS; git diff --check PASS; X regression 616/617 with EVT12 confirmed pre-existing baseline source-regex mismatch
KNOWN_LIMITATIONS = scripts/test-x-terminal-event.mjs EVT12 remains a pre-existing baseline test-shape mismatch; production handler already used async (message) => before P3
NEXT_PHASE = P4_GITHUB_MULTI_CONNECTION
NEXT_EXACT_ACTION = audit GitHub auth/integration surfaces and design the smallest P4 multi-connection implementation on top of the P3 registry
```

```text
PHASE_COMPLETED = P4_GITHUB_MULTI_CONNECTION
STATUS = PASS / VALIDATED / FROZEN
COMPLETED_AT = 2026-09-19
VALIDATED_MAIN_COMMIT = cf9e24dd4e3d0bd19e68c0ebf71a777e58056148
TAG = hearth-p4-validated-0.4.7-20260919
FINAL_GATE = P4_MAIN_FINAL_GATE_PASS
VALIDATION = GitHub focused 30/30; P3 connections 18/18; X MCP tools 21/21; Project X auth 13/13; Bridge 46/46; Electron/server 98/98; Goal/Review/Remote Goal all executed suites PASS; P2 updater 149/149; production build + TypeScript PASS; syntax PASS; git diff --check PASS; X full regression 616/617 with EVT12 confirmed pre-existing baseline source-regex mismatch
SECURITY = fine-grained PAT only; SecureCredentialStore only; no GH_TOKEN/GITHUB_TOKEN import; no gh auth switch; explicit alias per MCP tool; no cross-alias fallback; PR creation approval-gated; generic push/merge/delete/release/admin absent; P2 updater credential-independent
KNOWN_LIMITATIONS = full Connections management UI remains deferred to P7; scripts/test-x-terminal-event.mjs EVT12 remains the pre-existing baseline test-shape mismatch
NEXT_PHASE = P5_SUPABASE_MULTI_PROJECT
NEXT_EXACT_ACTION = audit existing supabase:hearth and supabase:xgen auth/client surfaces and design the smallest P5 multi-project implementation on top of the frozen P3 registry
```

```text
PHASE_COMPLETED = P5_SUPABASE_MULTI_PROJECT
STATUS = PASS / VALIDATED / FROZEN
COMPLETED_AT = 2026-09-20
VALIDATED_MAIN_COMMIT = 034e34479e0f37866c264a694ba705caee5869d4
TAG = hearth-p5-validated-0.4.7-20260920
FINAL_GATE = P5_MAIN_FINAL_GATE_PASS
VALIDATION = P5 focused 28/28; Bridge standalone 46/46; PublicTasksClient 27/27; Review Queue sync/tools 15/15; Remote Goal ingress 24/24; P3 connections 18/18; P4 GitHub 30/30; Electron/server 98/98; Goal/Review/Remote Goal all executed suites PASS; P2 updater 149/149; production build + TypeScript PASS; syntax + git diff --check PASS; X full regression 616/617 with EVT12 confirmed pre-existing baseline source-regex mismatch
SECURITY = explicit supabase:hearth / supabase:xgen aliases; separate encrypted sessions; hosted Supabase URLs only; publishable/legacy-anon config only; sb_secret_ and service_role forbidden; no default/fallback alias; public snapshots hide publishable key values and session credentials
KNOWN_LIMITATIONS = one combined multi-file Bridge regression run produced a device-identity test isolation flake; immediate standalone rerun passed 46/46. EVT12 remains the pre-existing X test-shape mismatch. Full Connections management UI remains P7.
NEXT_PHASE = P6_VERCEL_CONNECTION
NEXT_EXACT_ACTION = audit Vercel auth/deploy/environment surfaces and design the smallest P6 Vercel connection with read-first capabilities and approval-gated sensitive mutations
```

```text
PHASE_COMPLETED = P6_VERCEL_CONNECTION
STATUS = PASS / VALIDATED / FROZEN
COMPLETED_AT = 2026-09-20
VALIDATED_MAIN_COMMIT = 6fc48dd876ebde72af2d49981dde16c0268b2e02
TAG = hearth-p6-validated-0.4.7-20260920
FINAL_GATE = P6_MAIN_FINAL_GATE_PASS
VALIDATION = P6 focused 31/31; P3 connections 18/18; P4 GitHub 30/30; P5 Supabase 28/28; Electron/HTTP + X MCP registry 119/119; Bridge standalone 46/46; Goal/Review/Remote Goal all executed suites PASS; P2 updater 149/149; production build + TypeScript PASS; syntax + git diff --check PASS; X full regression 616/617 with EVT12 confirmed pre-existing baseline source-regex mismatch
SECURITY = fixed api.vercel.com; Hearth-owned secure token storage; remote identity-before-persist; explicit vercel:main alias; optional explicit teamId; Vercel permission defaults Ask; project/deployment read only; no CLI/global auth import; no deploy/promote/rollback/domain/env/project-admin mutation tools
KNOWN_LIMITATIONS = no live provider smoke through Hearth because no P6 PAT has been entered into Hearth and global Vercel CLI credentials were deliberately not imported. EVT12 remains the pre-existing X test-shape mismatch. Full Connections/Approvals/Evidence Console remains P7.
NEXT_PHASE = P7_CONSOLE_CONNECTION_HEALTH_APPROVALS_EVIDENCE
NEXT_EXACT_ACTION = audit current Overview/Permissions/Logs/connection IPC surfaces and design the smallest P7 operational Console without adding provider mutation authority or redesigning frozen runtime/provider behavior
```

```text
PHASE_COMPLETED = P7_OPERATIONAL_CONSOLE
STATUS = PASS / VALIDATED / FROZEN
COMPLETED_AT = 2026-09-20
VALIDATED_MAIN_COMMIT = 7865119f9e242099db9ba30b9215e0fd5dfd9a8d
TAG = hearth-p7-validated-0.4.7-20260920
FINAL_GATE = P7_MAIN_FINAL_GATE_PASS
VALIDATION = P7 focused 10/10; P3 connections 18/18; P4 GitHub 30/30; P5 Supabase 28/28; P6 Vercel 31/31; Electron/HTTP + X MCP registry 119/119; Bridge standalone 46/46; Goal/Review/Remote Goal all executed suites PASS; P2 updater 149/149; production build + TypeScript PASS; git diff --check PASS; X full regression 616/617 with EVT12 confirmed pre-existing baseline source-regex mismatch
SECURITY = no new backend authority; GitHub/Vercel management reuses existing local IPC; Supabase auth not duplicated; stored secrets never read back into renderer; transient token inputs are password-style and cleared after successful connect; Console cannot decide approvals; no new execution route/provider mutation; evidence lifetime is explicitly labeled
KNOWN_LIMITATIONS = approval/log evidence is current-session only unless already durable Goal checkpoint evidence. EVT12 remains the pre-existing X test-shape mismatch. Full visual redesign remains P9.
NEXT_PHASE = P8_MULTI_AGENT_ROUTER_UNIVERSAL_INGRESS
NEXT_EXACT_ACTION = audit existing task/job/Goal/X/specialist routing and design the smallest generic Hearth job contract + user-facing ส่งงาน: ingress while preserving x-task-v1 as an X-internal adapter target
```

```text
PHASE_COMPLETED = P8_MULTI_AGENT_ROUTER_UNIVERSAL_INGRESS
STATUS = PASS / VALIDATED / FROZEN
COMPLETED_AT = 2026-09-20
VALIDATED_MAIN_COMMIT = 016225615855f65e0c11cf048c6f8a654b481a88
TAG = hearth-p8-validated-0.4.7-20260920
FINAL_GATE = P8_MAIN_FINAL_GATE_PASS
VALIDATION = P8 focused 24/24; P3 connections 18/18; P4 GitHub 30/30; P5 Supabase 28/28; P6 Vercel 31/31; P7 Console 10/10; Electron/HTTP + X MCP registry 119/119; Bridge standalone 46/46; Goal/Review/Remote Goal all executed suites PASS; P2 updater 149/149; production build + TypeScript PASS; syntax + git diff --check PASS; X full regression 616/617 with EVT12 confirmed pre-existing baseline source-regex mismatch
SECURITY = no new executor/runtime/store/status database; semantic kind only; no caller worker/provider/workspace-root/repair-budget authority; generic secret-shaped text redacted before routing; X uses existing ingestXTask/X queue/shared admission; Antigravity uses Electron TaskStore/shared admission; existing permissions preserved; caller disconnect aborts pre-commit approval waiters; Codex remains specialist-only behind the validated handoff/authorization/result lifecycle
KNOWN_LIMITATIONS = the already-running MCP server process on port 3001 was started before P8 and must restart before that live process advertises hearth_job_submit/hearth_job_status; fresh HTTP child and stdio source discovery validated the new tools. EVT12 remains the pre-existing X test-shape mismatch. Full visual redesign remains P9.
NEXT_PHASE = P9_FULL_UI_REDESIGN
NEXT_EXACT_ACTION = audit the current App/UI information architecture and split the large App/styles into clear pages/components incrementally without changing frozen runtime, routing, permission, provider, Goal, X, updater, or connection behavior
```

### Frozen baselines

```text
X v0.1 = FROZEN / VALIDATED
X_TAG = hearth-x-v0.1-validated-20260918

P2 Remote One-Click Updater V1 = FROZEN / VALIDATED
P2_TAG = hearth-p2-validated-0.4.7-20260919

P3 Connection Registry + Secure Credential Store V1 = FROZEN / VALIDATED
P3_TAG = hearth-p3-validated-0.4.7-20260919

P4 GitHub Multi-Connection V1 = FROZEN / VALIDATED
P4_TAG = hearth-p4-validated-0.4.7-20260919

P5 Supabase Multi-Project V1 = FROZEN / VALIDATED
P5_TAG = hearth-p5-validated-0.4.7-20260920

P6 Vercel Connection V1 = FROZEN / VALIDATED
P6_TAG = hearth-p6-validated-0.4.7-20260920

P7 Operational Console V1 = FROZEN / VALIDATED
P7_TAG = hearth-p7-validated-0.4.7-20260920

P8 Multi-Agent Router + Universal Ingress V1 = FROZEN / VALIDATED
P8_TAG = hearth-p8-validated-0.4.7-20260920
```

Do not modify frozen X/P2/P3/P4/P5/P6/P7/P8 implementation unless an actual regression, security issue, or explicitly approved new phase requires it.

### Secure MCP / Direct Coder status

```text
Secure MCP Tunnel = VALIDATED
ChatGPT -> Hearth read-only = VALIDATED
ChatGPT -> Hearth Direct Coder = VALIDATED
Background tunnel service = VALIDATED
```

No API keys, tunnel credentials, private signing keys, secret hashes, or other secret material belong in this README.

### New chat continuation contract

For a new session:

1. Read this README canonical checkpoint first.
2. Verify current branch, HEAD, validated tag, and `git status`.
3. Treat Git/source as truth over chat history.
4. Do not modify frozen X/P2/P3/P4/P5/P6/P7/P8 unless a regression or security issue is proven.
5. Continue `NEXT_EXACT_ACTION` only.

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

### P0 — Validate and merge Hearth Skill v1 branch — COMPLETE

Historical completed phase. Validation and merge evidence are preserved below.

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

This phase is complete; historical acceptance evidence is preserved below.

### P1 — Wire Skill Registry into X — COMPLETE

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

### P2 — Remote One-Click Updater — COMPLETE / VALIDATED

Canonical design: `docs/REMOTE-ONE-CLICK-UPDATER-V1.md`.

Validated P2 V1 includes:

- signed remote update manifests;
- Ed25519 trust verification;
- GitHub Releases public distribution authority;
- secure HTTPS delivery with bounded redirects;
- DNS/private-IP protection and DNS-rebinding-resistant pinned connections;
- DMG exact-size + SHA-256 verification;
- safe read-only DMG staging;
- staged application-tree verification;
- the existing local updater as the final install authority;
- explicit local Electron-main approval;
- runtime preflight blocking active X, Goal, queued/running durable jobs, and concurrent updater install;
- backup / restart flow;
- startup-success health marker;
- detached rollback watchdog;
- user-data isolation;
- remote manifest / GitHub / MCP / Goal / X cannot directly authorize final installation.

Validated production flow:

```text
GitHub Release
 -> signed manifest
 -> Ed25519 verification
 -> platform / architecture / version
 -> secure DMG download
 -> size + SHA verification
 -> safe read-only staging
 -> app-tree verification
 -> existing local updater inspection
 -> update_ready
 -> runtime preflight
 -> native local approval
 -> candidate revalidation
 -> late runtime preflight
 -> existing installUpdate()
 -> backup / restart
 -> startup-health marker
 -> rollback watchdog
```

#### Release distribution authority

```text
PRIVATE_SOURCE_REPOSITORY = seasonday41-bot/Hearth-Control
PUBLIC_RELEASE_REPOSITORY = seasonday41-bot/Hearth-Control-Releases
STABLE_MANIFEST_URL = https://github.com/seasonday41-bot/Hearth-Control-Releases/releases/latest/download/manifest.json
SIGNING_KEY_ID = hearth-release-2026-01
```

The production **public** signing key is embedded in the application main-process trust configuration. The production **private** signing key is stored outside the Git repository in owner-only local release-signing storage. Never place private signing material in source, README, logs, application bundles, or GitHub Release assets.

#### Validated P2 Final Gate baseline — 2026-09-19

```text
Remote integration        = 18/18 PASS
Startup Health            = 4/4 PASS
Runtime Preflight         = 8/8 PASS
Local updater             = 33/33 PASS
Remote updater P2A/B/C    = 94/94 PASS
Electron lifecycle        = 12/12 PASS
TypeScript --noEmit       = PASS
Syntax checks             = PASS
git diff --check          = PASS
```

Validated checkpoint:

```text
MAIN_COMMIT = 301e64fa216e10bb9a29566e3e3dff29a5620b91
TAG = hearth-p2-validated-20260919
FINAL_GATE = P2_MAIN_FINAL_GATE_PASS
```

### P3 — Hearth Connection Registry + Secure Credential Store — COMPLETE / VALIDATED / FROZEN

```text
VALIDATED_MAIN_COMMIT = 474a4f6f3994d13136d467bf6105a2a1486aad6b
TAG = hearth-p3-validated-0.4.7-20260919
FINAL_GATE = P3_MAIN_FINAL_GATE_PASS
NEXT_PHASE = P4_GITHUB_MULTI_CONNECTION
NEXT_EXACT_ACTION = Audit current GitHub integration/auth surfaces and design the smallest P4 implementation for two simultaneous GitHub connections using the P3 registry.
```

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

### P4 — GitHub multi-connection — COMPLETE / VALIDATED / FROZEN

Canonical design: `docs/HEARTH-GITHUB-MULTI-CONNECTION-V1.md`.

Use the frozen P3 Connection Registry foundation. Hearth must support at least **2 GitHub connections** simultaneously without disconnect/reconnect churn:

```text
github:personal
github:work
```

Locked P4 V1 rules:

- Hearth owns the connection credential; X never does.
- Use a locally entered fine-grained PAT per alias, stored only in the P3 Secure Credential Store.
- Do not import token material from GitHub CLI/keychain or switch the global `gh` active account.
- Use fixed `https://api.github.com` authority and explicit GitHub REST API versioning.
- Every GitHub MCP/data/action call requires an explicit connection alias.
- No cross-alias fallback.
- P2 public GitHub Releases updater remains credential-independent and unchanged.
- Read path is implemented before any GitHub mutation.
- Generic push/merge/delete/release/admin actions are out of P4 V1.
- The first mutation candidate is `github_pull_request_create`, gated by connection capability + Hearth Git permission + exact local approval.

```text
VALIDATED_MAIN_COMMIT = cf9e24dd4e3d0bd19e68c0ebf71a777e58056148
TAG = hearth-p4-validated-0.4.7-20260919
FINAL_GATE = P4_MAIN_FINAL_GATE_PASS
NEXT_PHASE = P5_SUPABASE_MULTI_PROJECT
NEXT_EXACT_ACTION = audit existing Supabase project/auth/client surfaces and design the smallest P5 multi-project foundation without collapsing supabase:hearth and supabase:xgen
```

### P5 — Supabase multi-project — COMPLETE / VALIDATED / FROZEN

Canonical design: `docs/HEARTH-SUPABASE-MULTI-PROJECT-V1.md`.

P5 keeps the two existing Supabase auth domains separate while moving runtime project/config authority behind explicit aliases:

```text
supabase:hearth
  -> HearthBridgeClient
  -> credential:supabase:hearth

supabase:xgen
  -> PublicTasksClient / ReviewItemsClient / GoalRequestsClient
  -> credential:supabase:xgen
```

Locked P5 V1 rules:

- hosted `https://<project-ref>.supabase.co` projects only;
- project URL + publishable/legacy-anon key are provider config;
- access/refresh sessions remain encrypted credentials;
- `sb_secret_...` and `service_role` are forbidden;
- every provider operation resolves an explicit alias; no fallback;
- existing Bridge and Project X named auth/UI/client flows remain separate;
- no arbitrary SQL/PostgREST passthrough or admin tooling;
- full Connections management UI remains P7.

```text
VALIDATED_MAIN_COMMIT = 034e34479e0f37866c264a694ba705caee5869d4
TAG = hearth-p5-validated-0.4.7-20260920
FINAL_GATE = P5_MAIN_FINAL_GATE_PASS
NEXT_PHASE = P6_VERCEL_CONNECTION
NEXT_EXACT_ACTION = audit existing Vercel/deploy/environment surfaces and design the smallest P6 connection on top of the frozen P3 registry
```

### P6 — Vercel connection — COMPLETE / VALIDATED / FROZEN

Canonical design: `docs/HEARTH-VERCEL-CONNECTION-V1.md`.

P6 adds one Hearth-owned Vercel alias:

```text
vercel:main
  -> credential:vercel:main
  -> project.read + deployment.read
```

Locked P6 V1 rules:

- fixed `https://api.vercel.com` authority;
- token enters only through local Electron IPC and is stored only in P3 SecureCredentialStore;
- Vercel CLI/global token state and `.vercel/project.json` are not authority;
- remote identity is validated before token persistence;
- every read uses explicit `vercel:main` plus optional explicit `teamId`;
- Hearth `Vercel` permission defaults to `Ask`;
- MCP is read-only for projects/deployments;
- deploy/promote/rollback/domain/env/project-admin mutation is absent from P6 V1;
- full Connections management UI remains P7.

```text
VALIDATED_MAIN_COMMIT = 6fc48dd876ebde72af2d49981dde16c0268b2e02
TAG = hearth-p6-validated-0.4.7-20260920
FINAL_GATE = P6_MAIN_FINAL_GATE_PASS
NEXT_PHASE = P7_CONSOLE_CONNECTION_HEALTH_APPROVALS_EVIDENCE
NEXT_EXACT_ACTION = audit current Overview/Permissions/Logs/connection surfaces and design the smallest P7 operational Console without expanding provider execution authority
```

### P7 — Console / connection health / approvals / evidence — COMPLETE / VALIDATED / FROZEN

Canonical design: `docs/HEARTH-OPERATIONAL-CONSOLE-V1.md`.

P7 adds a functional operational Console over existing trusted state rather than a new backend:

```text
Connections
  -> safe public snapshots + explicit health refresh
  -> local GitHub/Vercel connect/reconnect/disconnect via existing IPC

Approvals
  -> existing FIFO approval queue shown status-only
  -> existing modal remains the only allow/deny decision path

Evidence
  -> current-session logs + bounded approval history
  -> durable Goal checkpoints from existing Goal Runner persistence
```

Locked P7 V1 rules:

- no new execution authority or provider mutation tool;
- no new `console:` IPC namespace or durable Console database;
- stored provider secrets are never read back into renderer;
- token inputs are transient password fields and cleared after successful connect;
- Supabase keeps existing Bridge / Project X auth surfaces;
- current-session evidence is labeled as non-durable;
- durable evidence is read-only Goal checkpoint state already owned by Hearth;
- P9 full visual redesign remains deferred.

```text
VALIDATED_MAIN_COMMIT = 7865119f9e242099db9ba30b9215e0fd5dfd9a8d
TAG = hearth-p7-validated-0.4.7-20260920
FINAL_GATE = P7_MAIN_FINAL_GATE_PASS
NEXT_PHASE = P8_MULTI_AGENT_ROUTER_UNIVERSAL_INGRESS
NEXT_EXACT_ACTION = audit current task/job/Goal/X/specialist routing and design the smallest generic Hearth job ingress for user-facing ส่งงาน: commands without exposing x-task-v1 as the permanent user contract
```

### P8 — Multi-Agent Router + universal ingress — COMPLETE / VALIDATED / FROZEN

Canonical design: `docs/HEARTH-MULTI-AGENT-ROUTER-V1.md`.

User-facing intent remains agent-agnostic:

```text
ส่งงาน: <งานที่ต้องการ>
        |
        v
Supervisor authors hearth-job-v1
        |
        v
Hearth deterministic router
        ├─ code_change / code_inspect -> X
        └─ general                    -> Antigravity
```

Locked P8 V1 rules:

- `hearth-job-v1` is the universal contract; `x-task-v1` remains X-internal.
- Generic jobs contain semantic kind, objective, scope/evidence/criteria as needed — never worker/provider selection.
- Hearth/Electron owns workspace authority and worker resolution.
- X work reuses existing `ingestXTask`, X queue receipts, shared admission, and Result Gate.
- General work reuses Electron-owned Antigravity TaskStore/runtime and shared admission.
- `hearth_job_status` reads existing X receipt/TaskStore truth only.
- Same job ID is idempotent; changed payload or cross-route collision fails closed.
- Caller disconnect during approval cannot leave a stale approval that later starts work.
- Codex is not a fresh-job route; Codex remains behind the validated specialist handoff/authorization/result lifecycle.
- Future Search/Invest/GVideo workers extend semantic routing later; they do not require replacing this user contract.

```text
VALIDATED_MAIN_COMMIT = 016225615855f65e0c11cf048c6f8a654b481a88
TAG = hearth-p8-validated-0.4.7-20260920
FINAL_GATE = P8_MAIN_FINAL_GATE_PASS
NEXT_PHASE = P9_FULL_UI_REDESIGN
NEXT_EXACT_ACTION = audit the current App/UI information architecture and split the large App/styles into clear pages/components incrementally without changing frozen runtime/business behavior
```

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

---

## 0.4.9 Production One-Click Updater E2E Checkpoint — 2026-09-20

```text
SOURCE_MAIN_MERGE = 1de00f330bb60bc3e6faaf2399d4ef5d6c0cef51
RELEASE_VERSION = 0.4.9
BUILD_ID = 0.4.9-20260920153122-5186af
RELEASE_TAG = v0.4.9-20260920153122-5186af
RELEASE_ARTIFACT = Hearth.Control-0.4.9-arm64.dmg
DMG_SHA256 = ea73095ce90ff2a61c9d0085ba0dc3cd6c25b4f9ac94da2261f4c1548b076dcc
SIGNATURE = PASS
SIZE_SHA_MATCH = PASS
PRODUCTION_E2E = PASS

Validated runtime path:
0.4.8
 -> remote 0.4.9 detected
 -> download completed
 -> artifact size/SHA verified
 -> DMG mounted
 -> application staged
 -> local manifest validated
 -> UPDATE_READY persisted across app restart
 -> explicit local Install Update
 -> backup/install/restart completed
 -> installed app reports v0.4.9
 -> updater reports UP_TO_DATE

Installed bundle confirmation:
CFBundleShortVersionString = 0.4.9
CFBundleVersion = 0.4.9
```

Known UX follow-up:
- Download/Prepare works, but progress should later expose percentage/MB plus Verifying and Preparing states.
- This UX follow-up must not redesign the validated updater trust/install core.

