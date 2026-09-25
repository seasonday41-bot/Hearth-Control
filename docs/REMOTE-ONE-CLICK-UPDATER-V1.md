# Hearth updater boundary

Hearth preserves its signed remote update and trusted local update modules. The renderer can check and prepare an update. Installation is available only from the local Electron window after the native confirmation dialog, manifest validation and runtime preflight. MCP tools and remote connection requests cannot invoke installation.

The Core MCP migration replaces the former X/Goal preflight with a strict generic-job boundary: the MCP server must be stopped, and the durable `generic-jobs.json` store must contain no queued, running or recovery-required jobs. If the store cannot be read, installation is blocked. A job that loses its owning process remains in recovery-required state until reviewed.

No release signing, publication, deployment, installation or merge is part of the MCP Core migration. See `RELEASE_PROCESS.md` for the existing release steps.
