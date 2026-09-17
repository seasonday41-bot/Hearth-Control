# Hearth Remote One-Click Updater v1

Status: **DESIGN LOCKED — IMPLEMENT ONLY AFTER CURRENT SKILL V1 BRANCH IS VALIDATED/MERGED**

This document is the canonical implementation path for adding remote one-click updates to Hearth Control. It **extends** the existing local updater; it does not replace or redesign it.

## Goal

A packaged Hearth install should be able to:

```text
check remote release
  -> show update available
  -> user clicks Update & Restart
  -> download
  -> verify
  -> stage Hearth Control.app
  -> existing updater installs it
  -> restart
  -> startup health marker
  -> keep new build or rollback automatically
```

The user must no longer need to mount a DMG, drag the app into Applications, or click Replace manually.

## Existing components to preserve

Do not redesign these unless new failing evidence proves a defect:

- `electron/updater.cjs` — trusted local validation/install logic
- `electron/updater-helper.cjs` — detached rollback watchdog
- `scripts/generate-update-manifest.cjs` — local update bundle generation
- current local updater IPC and local manual update path
- explicit local user approval before install
- backup to `Hearth Control.previous.app`
- restart and rollback semantics

Remote updating is a **delivery layer in front of** the existing updater.

## Locked architecture

```text
Remote release origin
  -> signed remote manifest
  -> remote-updater.cjs
       - fetch manifest
       - verify signature
       - compare version/build recency
       - download DMG
       - verify DMG byte size + SHA-256
       - mount DMG read-only
       - stage exact Hearth Control.app
       - write local trusted-folder manifest
  -> updater.cjs (existing)
       - verify platform/arch/version
       - verify app tree SHA-256
       - require local user approval
       - backup current app
       - install staged app
  -> app.relaunch()
  -> updater-helper.cjs (existing)
       - startup marker -> cleanup
       - no marker -> rollback previous app
```

## Remote manifest v2

Use a signed JSON manifest with at least:

```json
{
  "schema": "hearth-update-v2",
  "version": "0.4.4",
  "buildId": "0.4.4-YYYYMMDDHHMMSS-abcdef",
  "builtAt": "2026-09-17T08:00:00.000Z",
  "channel": "stable",
  "platform": "darwin",
  "arch": "arm64",
  "appPath": "Hearth Control.app",
  "sha256": "APP_TREE_SHA256",
  "artifact": {
    "kind": "dmg",
    "path": "releases/0.4.4/<build-id>/Hearth-Control-0.4.4-arm64.dmg",
    "size": 123456789,
    "sha256": "DMG_FILE_SHA256"
  },
  "releaseNotes": "Short release notes",
  "signature": {
    "algorithm": "ed25519",
    "keyId": "hearth-release-2026-01",
    "value": "BASE64_SIGNATURE"
  }
}
```

`sha256` at the top remains the existing application-tree hash. `artifact.sha256` is the downloaded DMG file hash. Both must pass.

## Signature model

Checksum alone is not enough for a remote manifest because an attacker who can replace both the artifact and manifest can replace the checksum too.

- Sign the canonical unsigned manifest payload with Ed25519.
- Private signing keys must never be committed to the repository or embedded in Hearth.
- Hearth embeds only trusted public keys, keyed by `keyId` for rotation.
- Signature verification happens before the artifact is downloaded or mounted.
- Unknown `keyId`, malformed signature, or invalid signature fails closed.

## Remote origin rules

The manifest must not be allowed to choose an arbitrary absolute download URL.

- Hearth owns a configured/embedded HTTPS update origin.
- Manifest artifact location is a relative path under that origin.
- HTTPS only.
- Redirects must be bounded and every destination must be allowlisted.
- Reject local/private-network destinations unless an explicit future design authorizes them.
- Bound manifest size, artifact size, redirects, and request timeouts.

## State machine

Preserve existing updater states and add only the remote-delivery states needed:

```text
idle
 -> checking
    -> up_to_date
    -> update_available
       -> downloading
          -> verifying
             -> update_ready
                -> installing
                   -> restarting
                      -> healthy / rollback
error is reachable from any non-terminal remote phase
```

New remote states:

- `update_available`
- `downloading`
- `verifying`

Do not overload `update_ready`: it means the artifact has already been downloaded, verified, and staged for the existing local updater.

## Check behavior

- Manual `Check for Updates` is always supported.
- Packaged builds may perform a delayed startup check.
- Update-server failure must never block normal Hearth startup.
- Development mode must not present a packaged remote build as installable.
- Existing version comparison behavior remains authoritative; do not reimplement separate version logic in the renderer.

## User approval boundary

Install remains a local-user-only action.

The following must never be able to install an update directly:

- remote tasks
- Goals
- X
- Codex/specialists
- MCP tools
- Supabase payloads
- remote manifests

Only the visible local Hearth renderer may initiate the final update action, and the Electron main process must perform its own confirmation/validation again.

Renderer input must not be trusted for URL, hash, application path, or approval state. The main process resolves them from the already verified manifest/session.

## Download and staging

Suggested storage:

```text
~/Library/Application Support/Hearth Control/updates/remote/<buildId>/
  update-manifest.json
  Hearth-Control.dmg.part
  Hearth-Control.dmg
  staged/
    Hearth Control.app
```

Rules:

1. Stream the artifact to `.part`; do not buffer the whole file in memory.
2. Enforce maximum expected size while streaming.
3. Verify exact downloaded size.
4. Verify SHA-256 before mounting.
5. Atomically rename `.part` only after verification.
6. Mount the DMG read-only and no-browse via fixed executable `/usr/bin/hdiutil` with `shell:false`.
7. Require exact top-level `Hearth Control.app` directory; reject symlink aliases or arbitrary names.
8. Copy into the staged directory while preserving executable permissions and relative framework symlinks.
9. Always detach the DMG in cleanup/finally.
10. Generate the local trusted-folder layout expected by `updater.cjs` and then hand off to the existing updater.

## Runtime preflight before install

Do not intentionally restart Hearth while execution is active.

Install is blocked while any of these are active:

- X task/run
- Goal run
- durable worker/job
- another updater install

For v1, blocking with a clear message is sufficient. Automatic "install when current task finishes" is a future enhancement, not part of v1.

## Existing install/restart/rollback flow

After remote staging succeeds, return to the current updater path:

```text
readAndValidateManifest()
 -> inspectUpdate()
 -> installUpdate({ userApproved: true, ... })
 -> app.relaunch()
 -> app.exit()
```

`installUpdate()` remains responsible for:

- verifying the staged app again
- rechecking that the candidate is actually newer
- staging the copy into `/Applications`
- archiving/replacing the previous app
- writing `update-pending.json`
- starting rollback watchdog

Do not duplicate this install logic in `remote-updater.cjs`.

## Startup health marker

Do not mark the new build healthy immediately when Electron starts.

Record startup success only after essential local initialization is complete, at minimum:

- Electron app ready
- settings readable
- durable local stores initialized sufficiently for normal operation
- X runtime initialized or its initialization failure is surfaced according to current startup policy
- Goal runtime initialized or its initialization failure is surfaced according to current startup policy
- main window created

The exact health boundary must be tested before changing current marker timing.

## Rollback

Keep the detached `updater-helper.cjs` design.

- If startup success marker appears before timeout: delete previous backup/pending marker and exit helper.
- If no success marker: restore `Hearth Control.previous.app`, preserve enough evidence for troubleshooting, and reopen the previous Hearth build.
- If rollback itself cannot complete, preserve the backup rather than deleting it.

## Publishing order

Release publication must be atomic from the client's perspective:

```text
validated main
 -> build/package
 -> generate local manifest/bundle
 -> calculate DMG hash + size
 -> generate remote manifest
 -> sign remote manifest
 -> upload immutable DMG
 -> upload immutable versioned manifest
 -> verify remote objects
 -> publish/update the stable-channel pointer LAST
```

Never publish the channel pointer before the immutable artifact and manifest are available.

## Expected files

Implementation should prefer this layout unless inspection proves an existing nearby abstraction should be reused:

```text
electron/
  updater.cjs                    # preserve
  updater-helper.cjs             # preserve
  remote-updater.cjs             # new delivery layer
  main.cjs                       # small IPC/preflight wiring only
  preload.cjs                    # narrow renderer API only
scripts/
  generate-update-manifest.cjs   # extend, do not replace
  sign-update-manifest.cjs       # new
  publish-update.cjs             # new
  test-updater.mjs               # preserve existing regression suite
  test-remote-updater.mjs        # new
```

## Required validation before merge

At minimum prove:

1. valid signed newer manifest is accepted;
2. invalid/unknown signature fails closed;
3. wrong platform/arch fails closed;
4. older build is rejected;
5. interrupted download does not touch installed app;
6. size mismatch is rejected;
7. DMG SHA mismatch is rejected before mount;
8. redirect outside allowlist is rejected;
9. mount/copy failure cleans temporary state;
10. app-tree checksum mismatch is rejected by existing updater;
11. install cannot happen without local user approval;
12. active X/Goal/durable job blocks install;
13. successful install produces backup and restart state;
14. startup success cleans backup/pending state;
15. missing startup success rolls back;
16. user data remains intact;
17. all existing updater regression tests still pass;
18. no Remote Task/MCP/Goal/X route can directly trigger install.

## Explicit non-goals for v1

Do not add unless separately approved:

- delta/patch updates
- background silent install
- remote-triggered install
- automatic install immediately after task completion
- multi-platform support beyond current macOS arm64 path
- download resume
- replacing the existing updater with Electron autoUpdater

This spec is intentionally narrow: **secure remote delivery into the already validated local updater.**
