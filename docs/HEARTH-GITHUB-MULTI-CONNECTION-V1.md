# Hearth GitHub Multi-Connection V1

Status: P4 canonical design
Created: 2026-09-19
Baseline: main@99c2b91c4843e1268c472c31859966df9623ce2b
Implementation branch: feature/p4-github-multi-connection-v1

## Goal

P4 adds at least two simultaneous GitHub connections to Hearth:

```text
github:personal
github:work
```

Each connection must remain isolated by alias, credential, account identity, repository scope, capability policy, health state, and evidence. No GitHub credential is placed in X tasks, prompts, logs, renderer state, command lines, or generic environment variables.

P4 builds on the frozen P3 Connection Registry + Secure Credential Store. It must not create a second credential store or depend on global GitHub CLI account state.

## Audit findings

Current Hearth source has:

- P3 registry aliases `github:personal` and `github:work`.
- P3 credential refs `credential:github:personal` and `credential:github:work`.
- P3 GitHub capability vocabulary:
  - `repo.read`
  - `repo.write`
  - `pull_request.read`
  - `pull_request.create`
- Electron `safeStorage`-backed `SecureCredentialStore`.
- Renderer-safe `connections:list` / `connections:refresh`.
- No GitHub REST client.
- No GitHub auth/connect/disconnect IPC.
- No GitHub MCP tools.
- No GitHub token stored by Hearth.
- No Octokit dependency.
- P2 GitHub Releases updater uses public, fixed trust configuration and no user GitHub credential.

Machine audit also shows:

- GitHub CLI is installed.
- Two GitHub CLI accounts are already present in the macOS keyring.
- GitHub CLI still has one globally active account at a time.
- Git HTTPS operations currently use macOS `osxkeychain` credential helper.

P4 must not import, print, or copy tokens from GitHub CLI/keychain. Existing global Git/gh auth remains separate from Hearth-owned P4 credentials.

## Locked auth choice for P4 V1

Use a fine-grained personal access token entered locally by the user for each Hearth alias.

Reasons:

1. Fine-grained PATs can be constrained by resource owner, selected repositories, and permissions.
2. They map directly to the two alias model without a global active-account switch.
3. They reuse P3 Secure Credential Store.
4. They avoid introducing OAuth app registration, device-flow polling, callback state, refresh-token lifecycle, or GitHub App installation management in P4 V1.
5. OAuth/device flow or GitHub App auth may be added later without changing the alias contract.

P4 must never accept a token from remote MCP/Goal/X input. Token intake is local Electron renderer -> main process only.

## GitHub REST authority

P4 V1 uses the GitHub REST API with a fixed authority:

```text
API_ORIGIN = https://api.github.com
API_VERSION = 2026-03-10
ACCEPT = application/vnd.github+json
```

Do not accept an arbitrary API base URL in V1. This avoids introducing a new SSRF/host-trust surface.

## Provider architecture

```text
Renderer (local token entry only)
       |
       v
Electron main
       |
       +--> ConnectionService
       |       |
       |       +--> ConnectionRegistry
       |       +--> SecureCredentialStore
       |
       +--> GitHubConnectionService
               |
               +--> GitHubClient
                       |
                       +--> https://api.github.com
```

Recommended files:

```text
electron/github/
  github-client.cjs
  github-connection-service.cjs
  github-policy.cjs

scripts/
  test-github-client.mjs
  test-github-connections.mjs
  test-github-main-boundary.mjs
  test-github-mcp-tools.mjs
```

Do not put provider HTTP logic in `mcp/connections/registry.mjs`.

## Credential shape

Stored only under the P3 Secure Credential Store:

```js
{
  token: "...",
  tokenType: "fine_grained_pat"
}
```

Do not persist the token into `connections.json`, `settings.json`, Goal state, X run state, Review Queue state, logs, or renderer snapshots.

## Connection target metadata

After successful authentication, update only non-secret metadata:

```js
{
  alias: "github:personal",
  provider: "github",
  target: {
    host: "github.com",
    login: "example-user",
    accountType: "User"
  }
}
```

Do not use a global/default GitHub connection when an operation can be ambiguous.

## Connection health

P4 GitHub health must be remote, not merely "credential exists".

Use an authenticated GitHub API identity request to validate the token and resolve the account login.

Suggested state mapping:

```text
no credential                  -> DISCONNECTED
200 identity response          -> CONNECTED
401                            -> NEEDS_REAUTH
403 auth/rate/policy failure   -> ERROR with sanitized reason
network/timeout                -> ERROR
secure-store unavailable       -> ERROR / fail closed
```

A health check must not perform any GitHub mutation.

P4 may add a provider-specific health resolver to the P3 ConnectionService, but the extension must preserve existing Supabase behavior and P3 tests.

## Capability model

Connection capability is Hearth policy authority, not proof that the remote token definitely has that permission.

P4 V1 capabilities:

```text
repo.read
repo.write
pull_request.read
pull_request.create
```

Effective authority remains:

```text
connection alias
  ∩ connection capability
  ∩ Hearth permission
  ∩ task/Goal authority
  ∩ local approval policy
  ∩ GitHub remote authorization
```

A GitHub 403 never becomes permission expansion or fallback to another alias.

## Read operations — first implementation slice

P4 should first implement read-only operations that always require an explicit connection alias:

```text
github_connections_list
github_repositories_list
github_repository_get
github_pull_requests_list
```

No tool may silently choose the active `gh` account or first connected alias.

Repository listing uses the authenticated user's accessible repositories. Repository content inspection may require `Contents: read`; repository listing itself can work with fine-grained metadata read permission.

## Write boundary

P4 V1 does not implement generic Git push/merge/delete/release/admin actions.

The first allowed GitHub mutation may be:

```text
github_pull_request_create
```

Requirements:

- explicit connection alias;
- `pull_request.create` capability;
- Hearth `Git` permission;
- when permission is `Ask`, explicit local approval for the exact repository/base/head/title action;
- never auto-fallback to another GitHub connection;
- never expose the token to the MCP caller;
- no merge, delete, release publication, repository administration, secret mutation, workflow mutation, or force push in P4 V1.

Git transport push remains outside the P4 V1 token path. Existing local Git/macOS credential helper behavior is not redesigned in this phase.

## P2 updater isolation

The frozen P2 updater remains completely independent:

```text
GitHub Releases public delivery
  -> fixed RELEASE_OWNER / RELEASE_REPOSITORY
  -> signed manifest
  -> public verification key
  -> no P4 credential
```

P4 GitHub aliases must never alter:

- `electron/update-trust-config.cjs`
- P2 release repository authority
- updater manifest origin policy
- updater signature verification
- installer approval/preflight

## Renderer boundary

Minimal P4 functional UI is allowed only for connection setup, not a P7 console redesign.

Renderer may send:

```text
alias
token (only in the direct local IPC connect request)
```

Main process validates alias and consumes the token immediately into SecureCredentialStore.

Renderer receives only:

```js
{
  alias,
  provider,
  status,
  account,
  capabilities,
  target,
  lastCheckedAt,
  lastError
}
```

No token/ciphertext/credentialRef ever returns.

## MCP boundary

MCP receives only safe GitHub tools and public connection summaries. There is no MCP tool for setting/retrieving credentials.

Every GitHub data/action tool requires an explicit alias.

Examples:

```text
github_repositories_list(connection="github:personal")
github_repository_get(connection="github:work", owner="...", repo="...")
```

## Error and evidence rules

Errors must be sanitized and bounded. Never include:

- Authorization header;
- token;
- full request headers;
- keychain/credential-store payload;
- arbitrary GitHub response bodies when they can contain private content.

Useful safe evidence may include:

- alias;
- GitHub login;
- HTTP status;
- endpoint class, not full sensitive query/body;
- repository full_name when the caller already requested that repository;
- rate-limit metadata if safe;
- resulting PR number/URL after an approved create action.

## Implementation slices

### P4.0 — Audit + canonical design

- inspect existing GitHub/P2/P3 surfaces;
- verify machine-level global Git/gh state without reading tokens;
- lock PAT-based V1 design;
- preserve P2 updater isolation.

### P4.1 — GitHub client

Implement fixed-origin REST client with:

- bounded timeout;
- fixed GitHub API origin;
- API version header;
- accept header;
- Authorization header built only inside trusted main process;
- bounded response parsing;
- sanitized errors;
- injectable fetch for tests.

No registry mutation inside the low-level client.

### P4.2 — Connect / disconnect / remote health

Add trusted main-process service:

```text
connect(alias, token)
disconnect(alias)
refresh(alias)
```

Connect flow:

1. validate alias is GitHub provider;
2. validate token shape/bounds;
3. call GitHub identity API before persistence;
4. on success, persist token to P3 SecureCredentialStore;
5. update non-secret account metadata and status;
6. return public connection snapshot.

Invalid token must never be persisted as CONNECTED.

### P4.3 — Dual-account isolation

Prove:

- personal/work tokens are independent;
- account metadata does not cross;
- deleting one does not affect the other;
- 401 on one does not disconnect the other;
- no default alias fallback;
- no global `gh auth switch`.

### P4.4 — Read-only MCP tools

Add explicit-alias tools:

- list connections;
- list repositories;
- get repository;
- list pull requests.

Read tools must have no mutation path.

### P4.5 — First approved mutation

Optionally add `github_pull_request_create` only after read path is stable.

Require explicit Git approval and connection capability.

Do not add merge/push/delete/release/admin in this slice.

### P4.6 — Regression / freeze

Required:

- P4 focused tests;
- P3 connection tests;
- P2 updater regressions;
- Project X auth + Bridge regressions;
- Electron integration;
- Goal/Review regressions;
- production build / TypeScript;
- syntax checks;
- `git diff --check`;
- known X baseline EVT12 mismatch tracked separately unless intentionally fixed in its own scope.

## Acceptance gate

P4 V1 is complete only when:

```text
✓ github:personal and github:work can both remain CONNECTED simultaneously
✓ each alias resolves its own token/account only
✓ no global gh active-account dependency
✓ token never appears in registry/settings/renderer/MCP/logs
✓ invalid token is not persisted as a connected credential
✓ health performs no mutations
✓ every GitHub tool requires explicit alias
✓ no cross-alias fallback on 401/403/network failure
✓ repository read works for the intended connection
✓ P2 updater remains credential-independent
✓ frozen Supabase connection behavior remains unchanged
✓ sensitive GitHub mutations are absent or locally approved
✓ build/regressions pass
```

## Explicitly out of scope

- importing tokens from `gh auth token`;
- switching global `gh` active account;
- replacing macOS Git credential helper;
- generic Git push transport with Hearth PAT;
- merge PR;
- force push;
- release publication;
- repo deletion/rename/visibility changes;
- Actions secrets/environment secrets;
- GitHub App installation auth;
- OAuth/device flow;
- GitHub Enterprise Server arbitrary base URLs;
- P7 full Connections console redesign;
- X credential ownership.
