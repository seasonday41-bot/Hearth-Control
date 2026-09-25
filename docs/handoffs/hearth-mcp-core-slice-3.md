# Hearth Control — Slice 3 handoff

Project / Slice / Objective: Hearth Control / 3 / Direct code editing and background jobs.

Work completed: Added atomic-context unified-diff `apply_patch` using `git apply --check`, workspace path validation, and Files permission. Added generic `job_start/status/output/stop` backed by the existing JobManager and Terminal approval, inherited command restrictions, output bounds/redaction and process ownership checks. Protected writes through symlinks and stored generic job metadata with restricted file mode, without raw command arguments.

Files changed: `mcp/tools.mjs`, `mcp/workspace.mjs`, `mcp/runtime/job-manager.mjs`, `mcp/http.mjs`, `scripts/test-core-coding-tools.mjs`, `scripts/test-core-electron-runtime.mjs`, this handoff.

Validation results: `npm run test:coding-tools` passed 5/5; `npm run test:jobs` passed 10/10; `npm run test:core-electron` passed 1/1; `npm run test:safety` passed 20/20; HTTP and stdio MCP discovery passed. Build/typecheck passed. No native visual verification in this slice.

Git state at handoff: `feature/hearth-mcp-core-v1`; HEAD `83f854eaeb1e78713c7a03dd642cfc6ed3ca5362` before final commit; 2 ahead/0 behind origin/main; dirty; not pushed.

Known issues / blockers: A job whose ownership cannot be verified after restart requires recovery; arbitrary PID cancellation is deliberately unavailable.

Exact next action: Verify optional LAYA advisory calls and unavailable behavior.

Status: READY_FOR_NEXT_SLICE
