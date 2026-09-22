# Hearth Control — Release Process

**Build once → verify that exact artifact → publish that exact artifact.**

Nothing between verification and publication may rebuild the application binary.

## Why this exists

The previous pipeline could produce an installed app whose version did not match
its source, and gave no way to tell which source an artifact came from:

- The version lived in four files (`package.json`, `package-lock.json`,
  `electron/build-meta.json`, `electron/stable-build-meta.json`) with no check
  that they agreed.
- Two of those files carried a **hand-edited regex pinning the current release
  series** (`/^0\.4\.22-\d{14}-[0-9a-f]{6}$/`), in `restore-stable-build-meta.cjs`
  and in the build metadata test. Every release meant editing both by hand.
  Forgetting either left a green tree that shipped the wrong version.
- The build ID ended in **three random bytes**, so every rebuild invented a new
  identity. There was no way to tell whether an installed artifact was the one
  that had been verified.
- **No commit was recorded anywhere.** An installed app could report a version
  but not the source it was built from.

## The canonical version

`package.json` is the **single source of truth**. Everything else is derived:

| Derived from it | How |
|---|---|
| `package-lock.json` | written by `set-version` |
| `electron/stable-build-meta.json` | derived from version + commit |
| `electron/build-meta.json` | written by each build |
| artifact filename | `Hearth Control-<version>-arm64.dmg` |
| update manifest | built from `build-meta.json` |

Never edit these by hand. `npm run set-version` writes all of them together.
`electron/build-meta.json` is an untracked generated artifact because its
commit-derived identity changes after the source commit is made. The release
gate checks all tracked changes; it does not exempt metadata from dirty-tree
checks. Keep the generated file available for packaging and provenance checks.

## Build identity

```
<version>-<short commit>[-dirty]
```

For example `0.4.22-fc9a60c`. It is **deterministic**: the same version at the
same commit always produces the same build ID, so building twice cannot yield
two artifacts claiming to be different things. A build from a tree with modified
tracked files is marked `-dirty` — such a build cannot be reproduced from its
commit and must not be published.

`electron/build-meta.json` carries `version`, `buildId`, `commit`, `dirty`,
`builtAt`, `platform`, `arch`. The commit is the full SHA.

## Normal release

```bash
npm run release:status              # what would be built, and is it ready
npm run set-version -- 0.4.23       # one command, writes every derived file
npm run test:version                # the identity gate
npm run release:prepare -- 0.4.23   # gate + targeted tests + readiness report
```

`release:prepare` **does not** push, tag, build, publish or deploy. It reports
whether the tree is ready and stops.

Then, after committing the version change:

```bash
npm run dist:mac                    # build the artifact ONCE
npm run release:provenance          # hash it and record what it is
```

`release:provenance` writes `release/provenance-<version>.json` and
`release/SHA256SUMS.txt`, and **refuses** when:

- the version state is inconsistent
- `build-meta.json` names a different commit from `HEAD`
- `build-meta.json` was written *after* the artifact was built (so it no longer
  describes it — the "published something other than what was verified" case)
- the artifact is missing or empty

Publishing then uses **those exact files**. Do not run `dist:mac` again.

## Who does what

| Step | Where | Notes |
|---|---|---|
| version + gates | local, `npm run release:prepare` | no side effects |
| build artifact | local, `npm run dist:mac` | once, from a clean tree |
| hash + provenance | local, `npm run release:provenance` | reads the artifact, never rebuilds |
| signing | local, `scripts/sign-update-manifest.cjs` | key path passed in, never in the repo |
| tag | manual, on the exact built commit | must equal `provenance.commit` |
| publish | manual | upload the exact artifact that provenance recorded |

There are currently **no GitHub Actions workflows** in this repository; releases
are produced locally. If CI is added later, the release workflow must download
the verified artifact from the build workflow rather than rebuilding it.

## Signing

The production key lives outside the repository, under
`~/Library/Application Support/Hearth Control/release-signing/`. It is passed to
the signer by path (`--key-file` or `HEARTH_UPDATE_SIGNING_KEY_PATH`); raw key
text via environment variable is refused, and no key content is ever logged.

`npm run release:status` reports only whether a key is **present** and its file
mode. It never reads the key.

Signed production releases must not silently fall back to unsigned.

## How the updater learns about a new version

The updater reads the remote manifest (schema v2, see
`docs/REMOTE-ONE-CLICK-UPDATER-V1.md`), which carries `version`, `buildId`,
`builtAt`, `platform`, `arch`, the app-tree `sha256`, and the artifact's `path`,
`size` and `sha256`. It compares versions and verifies the hash before staging.

Because build IDs are now commit-derived, a manifest can be matched back to the
exact source that produced the artifact it points at.

## Verifying what is installed

In the app: **System → Updates** shows

```
Current version   0.4.23
Current build     0.4.23-abc1234
Commit            abc1234
```

A build made from a dirty tree is labelled `(dirty tree)` there.

From a terminal:

```bash
npm run release:status
cat release/provenance-<version>.json
(cd release && shasum -a 256 -c SHA256SUMS.txt)
```

## Rollback

Previous artifacts stay in `release/` (`Hearth Control-<version>-arm64.dmg`) with
their provenance files. To roll back, install the earlier DMG directly. Verify
first:

```bash
shasum -a 256 "release/Hearth Control-<version>-arm64.dmg"
```

and compare it against that version's `provenance-<version>.json`.

## Rules

- Never rebuild the application binary between verification and publication.
- Never publish an artifact built from a dirty tree.
- Never hand-edit a derived version; use `npm run set-version`.
- Never weaken signing or verification to make a release pass.
