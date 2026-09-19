# Hearth Connection Registry + Secure Credential Store V1

Status: P3 canonical design
Created: 2026-09-19
Baseline: main@4f261b2f4ba51722ea18968e22cdde631c28bed0
Implementation branch: feature/p3-connection-registry-v1

## Goal

P3 makes Hearth the single authority for provider connection metadata, credential ownership, connection health, and renderer-safe connection state. It must preserve frozen X v0.1 and P2 updater behavior.

## Trust boundary

```text
ChatGPT / X / Skills / Renderer
            |
            | alias only
            v
          Hearth
     Connection Registry
            |
       Connection Service
        /          \
 metadata       Secure Store
                    |
              Electron safeStorage
                    |
             Provider clients
```

Agents, tasks, prompts, MCP responses, renderer IPC, logs, and connection metadata must never receive plaintext credentials, refresh/access tokens, passwords, private keys, encrypted credential blobs, or internal credential references.

## Storage split

- `connections.json`: non-secret connection metadata only.
- `credentials.json`: encrypted payloads only, encrypted/decrypted in Electron main via `safeStorage`.
- `settings.json`: application configuration and publishable configuration only. Legacy encrypted session fields are migrated out and removed after successful migration.

The Supabase publishable/anon key is provider configuration, not a private credential. User sessions, passwords, pairing secrets, private signing material, service-role keys, personal access tokens, and equivalent material are credentials.

## Built-in aliases

```text
github:personal
github:work
supabase:hearth
supabase:xgen
vercel:main
```

P3 implements the registry foundation and the two existing Supabase connection mappings. GitHub and Vercel authentication remain P4/P6 work.

## Connection record

A registry record contains only non-secret metadata:

```js
{
  id,
  alias,
  provider,
  label,
  target,
  auth: {
    type,
    credentialRef
  },
  capabilities,
  status,
  lastCheckedAt,
  lastError,
  createdAt,
  updatedAt
}
```

`credentialRef` is an internal reference and is never exposed to renderer/MCP consumers.

Allowed states:

```text
UNKNOWN
CONNECTED
DISCONNECTED
EXPIRED
NEEDS_REAUTH
ERROR
```

## Credential store

The Electron-main credential store supports only:

```text
setSecret(ref, value)
getSecret(ref)
hasSecret(ref)
deleteSecret(ref)
```

Rules:

1. Fail closed when `safeStorage.isEncryptionAvailable()` is false.
2. Never persist plaintext.
3. Use atomic file replacement and owner-only file mode where supported.
4. Never log payloads.
5. Deleting one credential must not affect any other credential.
6. Renderer gets no raw/encrypted credential material.

## Existing Supabase isolation

The current authentication domains remain separate:

```text
supabase:hearth
  -> existing legacy Hearth Bridge session

supabase:xgen
  -> existing Project X/public.tasks session
```

They must never share or fall back to each other's session.

Existing bridge/public-tasks clients remain in place during P3; only their credential source moves behind Hearth's credential boundary.

## Health semantics

Health inspection may update connection status metadata but may not silently sign in, refresh credentials, mutate remote provider state, or authorize work.

Default local health rules:

- no credential -> DISCONNECTED
- valid non-expired session -> CONNECTED
- expired session with refresh token -> EXPIRED
- expired/invalid session without refresh path -> NEEDS_REAUTH
- secure-store/decryption/inspection failure -> ERROR

Normal existing auth flows may still refresh a session when they actually need it; a successful refresh persists the new session and marks the connection CONNECTED.

## Capability boundary

Connection capabilities do not grant execution authority by themselves. Effective authority remains the intersection of:

```text
task constraints
  ∩ skill authority
  ∩ connection capabilities
  ∩ Hearth permissions
  ∩ approval policy
```

## Renderer IPC

P3 may expose renderer-safe read operations:

```text
connections:list
connections:refresh
```

A public connection snapshot may contain alias/provider/label/target/capabilities/status/account/health timestamps only.

## Migration

At startup, when secure storage is available:

1. Seed/update built-in registry metadata.
2. If a canonical credential does not exist, decrypt the matching legacy `settings.json` field and store it in `credentials.json`.
3. Verify the canonical credential exists.
4. Remove only the successfully migrated legacy encrypted field.
5. Never delete legacy data when migration cannot be verified.

Legacy keys covered by P3:

```text
bridgeSessionEncrypted
publicTasksSessionEncrypted
bridgePairingEncrypted
```

## Explicitly out of scope

- GitHub authentication or OAuth
- Vercel authentication
- adding a new Supabase project
- multi-agent router
- full Connections UI
- changes to X execution core, X Result Gate, Goal lifecycle, JobManager, continuation/recovery, or P2 updater behavior

## Validation gate

P3 is not complete until focused tests and relevant regressions prove:

- alias uniqueness and durable registry reload
- no credential plaintext in registry/settings
- safeStorage-unavailable fail closed
- renderer snapshots contain no secret/ciphertext/credentialRef
- Supabase Hearth/X credentials remain isolated
- deletion isolation
- health states are deterministic
- Bridge and Project X auth behavior is preserved
- X/Goal/P2 updater regressions pass
- TypeScript/build/syntax checks pass
- `git diff --check` passes
