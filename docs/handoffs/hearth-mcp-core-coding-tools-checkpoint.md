# Hearth MCP migration — coding tools checkpoint

Project / Slice / Objective: Hearth Control / 3 and 4 implementation checkpoint / coding tools and optional advisory LAYA.

Work completed: Added guarded unified-diff `apply_patch`; generic JobManager-backed `job_start`, `job_status`, `job_output`, `job_stop`; optional loopback LAYA `laya_status`, `laya_consult`, `laya_review`. Removed obsolete X/Goal/Review IPC transport wiring in the HTTP MCP process.

Files changed: `mcp/tools.mjs`, `mcp/http.mjs`, `mcp/laya.mjs`, `scripts/test-core-coding-tools.mjs`, `scripts/test-laya-tools.mjs`, this handoff.

Validation: targeted tests 5/5; `npm run build` passed; `npm run test:mcp:stdio` passed with the new tools discovered; `npm run test:safety` passed 20/20. HTTP discovery after this checkpoint still needs repetition. No visual or Electron runtime check.

Git state: branch `feature/hearth-mcp-core-v1`, baseline origin/main `c53b967`, commit pending at checkpoint, not pushed.

Known issues: Slice 2 remains in progress because legacy Electron main and UI still start X/Invest/Goals subsystems; do not delete their modules until decoupled. LAYA endpoint protocol is configurable via `HEARTH_LAYA_ENDPOINT` and requires compatible loopback `/status`, `/consult`, `/review` responses; actual LAYA installation not available here. JobManager records persist while child ownership is process-local, so after a process restart a running record requires recovery and cannot be cancelled by PID alone.

Exact next action: Decouple legacy Electron startup and IPC while preserving updater and GitHub/Vercel, then replace UI and remove unreferenced code. Run final validation.

Status: READY_FOR_NEXT_SLICE (historical checkpoint; subsequent slices completed on this branch)
