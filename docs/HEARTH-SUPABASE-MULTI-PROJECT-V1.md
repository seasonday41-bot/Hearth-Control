# Hearth Supabase Multi-Project V1

Status: P5 canonical design
Created: 2026-09-19
Baseline: main@2299ce6deff8070fb4e4d73faf51c0ae697e8342
Implementation branch: feature/p5-supabase-multi-project-v1

## Goal

P5 turns the two already-existing Supabase integrations into an explicit Hearth-owned multi-project provider layer without collapsing their separate auth domains.

Canonical aliases:

```text
supabase:hearth
supabase:xgen
```

P5 does not replace the existing table-specific clients. It makes project configuration and auth resolution alias-driven so future Hearth/agent code does not need hard-coded settings names.

## Existing truth

The repository already runs two independent Supabase projects:

```text
supabase:hearth
  -> legacy Hearth Bridge
  -> HearthBridgeClient
  -> device-scoped hearth_tasks / hearth_devices
  -> own user session

supabase:xgen
  -> Project X
  -> PublicTasksClient
  -> ReviewItemsClient
  -> GoalRequestsClient
  -> owner-scoped tasks / review_items / goal_requests
  -> own user session
```

The two sessions are already isolated in P3 SecureCredentialStore:

```text
credential:supabase:hearth
credential:supabase:xgen
```

P5 must preserve this isolation.

## API key model

For P5 V1:

- project URL + publishable/legacy-anon API key = provider configuration;
- access token + refresh token + user/owner identity = credential/session;
- secret/service-role keys are forbidden.

Preferred key format:

```text
sb_publishable_...
```

Legacy anon JWT-like keys may be accepted only for backward compatibility.

Explicitly reject:

```text
sb_secret_...
service_role material
```

No secret/service-role key belongs in registry metadata, renderer state, MCP, Goal/X task, logs, or client-side provider configuration.

## Provider architecture

```text
Electron main
   |
   +--> ConnectionRegistry
   |      supabase:hearth
   |      supabase:xgen
   |
   +--> ConnectionService
   |      session credentials (P3)
   |
   +--> SupabaseProjectService
          |
          +--> strict alias -> project config
          +--> Auth REST requests
          +--> session health
          |
          +--> existing clients remain separate
                 HearthBridgeClient
                 PublicTasksClient
                 ReviewItemsClient
                 GoalRequestsClient
```

Recommended new files:

```text
electron/supabase/
  supabase-project-service.cjs

scripts/
  test-supabase-project-service.mjs
  test-supabase-multi-project-boundary.mjs
```

Do not merge the existing table-specific clients into one generic client.

## Project configuration

Canonical project target metadata may contain:

```js
{
  url: "https://<project-ref>.supabase.co",
  publishableKey: "sb_publishable_..."
}
```

The publishable key is deliberately low privilege and is configuration, not a user/session credential. Runtime session credentials remain encrypted in P3 SecureCredentialStore.

For public snapshots, P5 should prefer returning safe derived project metadata rather than echoing the full key:

```js
{
  url,
  projectRef,
  publishableKeyConfigured: true
}
```

## Source compatibility / migration

P5 starts from the existing settings fields:

```text
supabaseUrl
supabaseAnonKey
publicTasksSupabaseUrl
publicTasksSupabaseAnonKey
```

At startup:

1. P3 built-in registry seeding imports their current values into the two alias targets.
2. P5 runtime uses alias-resolved registry configuration as authority.
3. Existing named IPC and UI state may remain for compatibility during P5.
4. Updating Project X publishable key must update the canonical alias target and legacy compatibility setting atomically enough that restart cannot cross-wire projects.
5. Do not delete old settings fields in P5 unless every existing UI/client path has been migrated and regression-tested.

This is intentionally a compatibility migration, not a wholesale settings rewrite.

## SupabaseProjectService responsibilities

Required methods:

```text
requireProject(alias)
getProjectConfig(alias)
updateProjectConfig(alias, config)
signUp(alias, email, password)
signIn(alias, email, password)
refreshSession(alias, refreshToken)
getRemoteUser(alias, accessToken)
refreshHealth(alias)
publicSnapshot(alias)
```

Every method requires an explicit Supabase alias. No default alias and no fallback.

## URL authority

P5 V1 supports hosted Supabase project URLs only:

```text
https://<project-ref>.supabase.co
```

No arbitrary origin, HTTP downgrade, URL credentials, fragments, or path-bearing project base URL.

A future phase can explicitly add custom domains/self-hosted Supabase if needed.

## Auth requests

Use native fetch against the alias-resolved project URL:

```text
POST /auth/v1/signup
POST /auth/v1/token?grant_type=password
POST /auth/v1/token?grant_type=refresh_token
GET  /auth/v1/user
```

Requests use the project publishable key in the `apikey` header.

User access tokens are used only where the endpoint requires the authenticated user.

Bound:

- request timeout;
- response byte size;
- JSON parsing;
- error text;
- redirects (reject unexpected redirect behavior).

Never include password, refresh token, access token, or API key in errors/logs.

## Existing auth-domain mapping

Existing named flows remain explicit wrappers:

```text
bridge:sign-up / bridge:sign-in
  -> supabase:hearth

publicTasks:sign-up / publicTasks:sign-in
  -> supabase:xgen
```

Refresh mapping:

```text
ensureBridgeSession
  -> refreshSession("supabase:hearth", ...)

ensurePublicTasksSession
  -> refreshSession("supabase:xgen", ...)
```

Session application remains separate because each flow has different side effects and client fan-out.

P5 must not create a generic "apply any Supabase session everywhere" function.

## Client initialization

Existing clients must receive configuration from their explicit alias:

```text
HearthBridgeClient
  <- getProjectConfig("supabase:hearth")

PublicTasksClient
ReviewItemsClient
GoalRequestsClient
  <- getProjectConfig("supabase:xgen")
```

No client may receive the other alias's URL/key as fallback.

## Health

P5 provider health is remote and project-specific.

Suggested mapping:

```text
project config absent                     -> DISCONNECTED
session absent                            -> DISCONNECTED
GET /auth/v1/user succeeds                -> CONNECTED
401                                       -> NEEDS_REAUTH
network/timeout/other provider error      -> ERROR
secure-store unavailable                  -> ERROR / fail closed
```

A health check performs no mutation and never refreshes automatically.

Existing normal auth paths may refresh a near-expiry session when they actually need it.

## Renderer / MCP boundary

P5 does not add arbitrary table/query tools.

No MCP tool may:

- set/read Supabase session tokens;
- accept a service-role/secret key;
- accept arbitrary SQL;
- accept arbitrary REST paths;
- choose a project implicitly.

P7 remains the full Connections management UI phase.

Existing renderer auth surfaces remain named and project-specific in P5.

## Multi-project isolation acceptance

P5 must prove:

```text
✓ supabase:hearth and supabase:xgen resolve different project config
✓ each alias uses only its own publishable key
✓ each alias uses only its own session credential
✓ sign-in/refresh on one alias never mutates the other
✓ sign-out on one alias never clears the other
✓ HearthBridgeClient receives hearth config only
✓ Project X clients receive xgen config only
✓ 401/health failure on one alias does not affect the other
✓ no default/fallback alias exists
✓ no secret/service-role key accepted
✓ no raw session credential exposed to renderer/MCP/logs
✓ existing Bridge/PublicTasks/Review/Goal behavior remains unchanged
```

## Implementation slices

### P5.0 — Audit + design

- inventory current settings/auth/client paths;
- verify existing two-project isolation;
- lock publishable-vs-session model;
- lock secret/service-role rejection;
- preserve existing table-specific clients.

### P5.1 — Registry project metadata

- extend built-in Supabase alias targets with publishable-key config from existing settings;
- derive safe public target metadata;
- preserve stable aliases and current URLs.

### P5.2 — SupabaseProjectService

- strict alias resolver;
- hosted-project URL validation;
- publishable-key validation;
- bounded auth REST client;
- remote user health;
- sanitized errors.

### P5.3 — Existing auth wrappers migrate to alias authority

- bridge auth -> supabase:hearth;
- Project X auth -> supabase:xgen;
- preserve separate apply/session side effects;
- preserve sign-out semantics.

### P5.4 — Existing clients initialize from alias config

- Bridge client gets Hearth project config;
- PublicTasks/Review/Goal clients get XGEN config;
- save-publishable-key updates xgen alias config;
- no cross-project fallback.

### P5.5 — Isolation / regression gate

- focused provider tests;
- Bridge;
- Project X auth;
- PublicTasks client;
- Review/Goal remote sync;
- P3 connection tests;
- P4 GitHub tests;
- Electron/server;
- Goal/Review;
- P2 updater;
- X baseline;
- TypeScript/build;
- syntax;
- git diff --check.

## Out of scope

- Supabase service-role / secret keys;
- arbitrary SQL;
- database admin;
- arbitrary schema/table browser;
- generic PostgREST passthrough;
- custom domains/self-hosted instances;
- merging Hearth/XGEN sessions;
- replacing existing table-specific clients;
- P7 full Connections UI;
- P8 agent router integration.
