# Hearth Vercel Connection V1

Status: P6 canonical design
Created: 2026-09-20
Baseline: main@8c561b7bef66a3d15e9bc26b3e85b731ee1b0e04
Implementation branch: feature/p6-vercel-connection-v1

## Goal

P6 adds one stable Hearth-owned Vercel connection:

```text
vercel:main
```

The P3 Connection Registry remains multi-connection capable, but P6 V1 intentionally implements one Vercel alias first.

Hearth owns the Vercel credential and API authority. X, Goals, MCP callers, prompts, logs, renderer snapshots, and child-process transport messages never receive the Vercel token.

## Existing truth

P3 already defines:

```text
alias = vercel:main
provider = vercel
auth.type = vercel_token
credentialRef = credential:vercel:main
```

P3 capability vocabulary already includes:

```text
project.read
deployment.read
deployment.create
environment.read
environment.write
```

P6 V1 grants only:

```text
project.read
deployment.read
```

Mutation capabilities remain ungranted and their tools do not exist.

The Mac has Vercel CLI installed and authenticated globally, but the Hearth repository is not linked through `.vercel/project.json`. P6 must not import, print, switch, or depend on Vercel CLI token/global auth state.

## Authentication

P6 V1 accepts a Vercel Personal Access Token entered locally by the user.

The token is stored only in the P3 SecureCredentialStore under:

```text
credential:vercel:main
```

The token is validated remotely before persistence.

Vercel access tokens are treated as opaque credentials. Modern personal tokens may use the `vcp` prefix, while older opaque access tokens may still exist. P6 therefore:

- accepts bounded non-whitespace personal/legacy opaque access tokens;
- explicitly rejects known non-personal token prefixes such as app/integration/refresh/API-key forms when identifiable;
- never reads `VERCEL_TOKEN` or Vercel CLI credential files;
- never returns the token to renderer/MCP.

## REST authority

Fixed authority:

```text
https://api.vercel.com
```

No arbitrary base URL in P6 V1.

Supported read endpoints:

```text
GET /v2/user
GET /v2/teams
GET /v9/projects
GET /v9/projects/{idOrName}
GET /v6/deployments
GET /v13/deployments/{idOrUrl}
```

Team-owned resources use an explicit `teamId` query parameter when configured/requested.

## Connection target metadata

Non-secret target metadata may contain:

```js
{
  teamId: "team_...",
  accountId: "user_...",
  username: "..."
}
```

A missing `teamId` means the token's personal/default scope is used.

## Provider architecture

```text
Renderer local connect request
       |
       v
Electron main
       |
       +--> ConnectionRegistry
       +--> ConnectionService
       +--> SecureCredentialStore
       |
       +--> VercelConnectionService
               |
               +--> VercelClient
                       |
                       +--> https://api.vercel.com
```

Recommended files:

```text
electron/vercel/
  vercel-client.cjs
  vercel-connection-service.cjs

scripts/
  test-vercel-client.mjs
  test-vercel-connections.mjs
  test-vercel-main-boundary.mjs
  test-vercel-mcp-tools.mjs
  test-vercel-http-transport.mjs
```

## Connection service

Required operations:

```text
connect("vercel:main", token, { teamId? })
disconnect("vercel:main")
refresh("vercel:main")
listProjects(...)
getProject(...)
listDeployments(...)
getDeployment(...)
```

Connect flow:

1. validate alias/provider;
2. validate bounded token shape;
3. call `GET /v2/user` before persistence;
4. if teamId is provided, validate bounded teamId shape;
5. persist token only after identity succeeds;
6. update non-secret target metadata;
7. grant read-only capabilities only;
8. return renderer-safe snapshot.

No fallback alias exists.

## Health

Remote health uses `GET /v2/user`.

Suggested mapping:

```text
no credential        -> DISCONNECTED
200 identity          -> CONNECTED
401                   -> NEEDS_REAUTH
403/429/network/5xx   -> ERROR
secure-store failure  -> ERROR / fail closed
```

Health performs no mutation and does not deploy.

## Renderer IPC

Minimal P6 IPC:

```text
vercel:connect
vercel:disconnect
```

Connect input:

```js
{
  alias: "vercel:main",
  token: "...",
  teamId?: "team_..."
}
```

Renderer receives only safe connection summary metadata.

Full Connections management UI remains P7.

## MCP read tools

Every Vercel tool requires explicit alias:

```text
vercel_projects_list
vercel_project_get
vercel_deployments_list
vercel_deployment_get
```

Read tools rely on the connection's explicit read capability. They do not expose credentials and do not silently use Vercel CLI/global auth.

No MCP credential-management tool exists.

## Mutation boundary

P6 V1 intentionally contains no mutation tool.

Absent:

```text
deployment.create
production deploy/promote
rollback
domain add/remove
environment read of decrypted values
environment write/delete
project create/delete/rename
team/admin mutation
```

This is deliberate. A later approved slice may add narrowly-scoped mutations with exact local approval, but P6 V1 closes only the safe read connection foundation.

## Error/evidence rules

Safe evidence may include:

- connection alias;
- Vercel username/account ID;
- teamId when explicitly configured;
- project id/name;
- deployment id/url/state;
- HTTP status;
- bounded rate-limit/provider status metadata.

Never include:

- bearer token;
- Authorization header;
- raw request headers;
- full arbitrary provider error body;
- environment values/secrets;
- CLI credential state.

## Acceptance gate

P6 V1 is complete only when:

```text
✓ vercel:main validates identity before storing credential
✓ token is encrypted only in P3 SecureCredentialStore
✓ no Vercel CLI/global token dependency
✓ fixed https://api.vercel.com origin only
✓ optional teamId is explicit metadata, never guessed
✓ default capabilities are project.read + deployment.read only
✓ renderer/MCP/child transport contain no token
✓ projects/deployments can be read through explicit alias
✓ 401 marks NEEDS_REAUTH without fallback
✓ deploy/domain/env/project-admin mutation tools are absent
✓ P3/P4/P5/P2/X regressions remain within validated baselines
✓ build/TypeScript/syntax/git diff checks pass
```

## Out of scope

- Vercel CLI auth import;
- `.vercel/project.json` dependency;
- production deployment creation;
- promote/rollback;
- domain mutation;
- environment variable mutation or secret retrieval;
- project/team administration;
- arbitrary Vercel REST passthrough;
- P7 full Connections Console UI;
- X credential ownership.
