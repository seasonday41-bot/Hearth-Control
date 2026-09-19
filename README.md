# Hearth Control

A local macOS desktop control center, built with Electron, React, TypeScript, and Vite.

## 🚨 READ FIRST — Canonical continuation path

**Last updated: 2026-09-19**

This section is the project handoff/source of truth for any new ChatGPT/Codex/AI session. **Do not start a fresh architecture plan, choose a different next feature, or rediscover the roadmap from scratch.** Read this section first, verify Git state, and continue only the canonical next action below.

## CURRENT STATUS

```text
PHASE = P4_GITHUB_MULTI_CONNECTION — COMPLETE / VALIDATED / FROZEN
CURRENT_BRANCH = main
VALIDATED_MAIN_COMMIT = cf9e24dd4e3d0bd19e68c0ebf71a777e58056148
VALIDATED_TAG = hearth-p4-validated-0.4.7-20260919
FINAL_GATE = P4_MAIN_FINAL_GATE_PASS
STATUS = P4_COMPLETE_VALIDATED
BLOCKED_BY = none
LAST_COMPLETED_STEP = P4 GitHub multi-connection V1 validated on main, tagged, and frozen
NEXT_PHASE = P5_SUPABASE_MULTI_PROJECT
NEXT_EXACT_ACTION = audit the existing supabase:hearth and supabase:xgen provider/client/auth surfaces and design the smallest P5 multi-project foundation on the frozen P3 registry without collapsing their existing auth boundaries
DO_NOT_MODIFY_FROZEN = X v0.1, P2, P3, or P4 unless an actual regression/security issue or an explicitly approved later phase requires a targeted change
```

**Continuation rule:** Git/source is authoritative over chat history. Verify branch, HEAD, tag, and worktree before editing. Do not modify frozen X/P2/P3 behavior unless a regression/security issue or the approved P4 design requires a targeted extension. Continue only `NEXT_EXACT_ACTION`.

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

`main` is the canonical branch and now contains the validated P4 implementation checkpoint:

```text
P4_VALIDATED_IMPLEMENTATION_COMMIT = cf9e24dd4e3d0bd19e68c0ebf71a777e58056148
P4_TAG = hearth-p4-validated-0.4.7-20260919
P4_FINAL_GATE = P4_MAIN_FINAL_GATE_PASS
P3_TAG = hearth-p3-validated-0.4.7-20260919
P2_TAG = hearth-p2-validated-0.4.7-20260919
```

P0, P1, X v0.1, P2, P3, and P4 histories are preserved in Git. X/P2/P3/P4 are frozen unless a real regression/security issue or an explicitly approved later phase requires a targeted change.

---

## ✅ Canonical progress checklist — MUST be maintained

This checklist is the handoff ledger for every future chat/agent. **A phase is not complete until its evidence is recorded here.** When a phase finishes, mark its checkbox, add the completion record, update `CURRENT_PHASE`, `NEXT_PHASE`, `ACTIVE_BRANCH`, and the exact next action before doing later work.

### Overall roadmap

- [x] **P0 — Validate and merge Hearth Skill v1**
- [x] **P1 — Wire Skill Registry into X**
- [x] **P2 — Remote One-Click Updater** — VALIDATED / FROZEN
- [x] **P3 — Connection Registry + Secure Credential Store** — VALIDATED / FROZEN
- [x] **P4 — GitHub multi-connection (2+)** — VALIDATED / FROZEN
- [ ] **P5 — Supabase multi-project (2+)**
- [ ] **P6 — Vercel connection**
- [ ] **P7 — Console / connection health / approvals / evidence**
- [ ] **P8 — Multi-Agent Router + universal `ส่งงาน:` ingress**
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
```

Do not modify frozen X/P2/P3/P4 implementation unless an actual regression, security issue, or explicitly approved new phase requires it.

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
4. Do not modify frozen X/P2/P3/P4 unless a regression or security issue is proven.
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