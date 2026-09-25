# Hearth Control — Slice 5 handoff

Project / Slice / Objective: Hearth Control / 5 / Compact Core MCP Dashboard.

Work completed: Replaced X/Invest/Goals/Review Queue pages with Dashboard, Tools, Connections, Activity, Settings. Added workspace/git state, real tool discovery and connection count, permission controls, recent JobManager jobs with output preview, server controls, LAYA consult/review, updater controls, keyboard focus, dark mode, and responsive one-column layout. No fake metrics.

Files changed: `src/App.tsx`, `src/control-center.css`, `src/main.tsx`, `src/electron.d.ts`, `electron/preload.cjs`, `electron/main.cjs`; removed obsolete `src/pages/`, components, and CSS; this handoff.

Validation results: `npm run build` passed (TypeScript and Vite). `npm run test:core-electron` passed 1/1 with live MCP child. Source-level responsive/focus/layout review done. **Rendered visual runtime verification NOT VERIFIED:** environment has no display/Xvfb/Chromium, headless Electron fails GTK display, and hosted browser blocks localhost.

Git state at handoff: `feature/hearth-mcp-core-v1`; HEAD `83f854eaeb1e78713c7a03dd642cfc6ed3ca5362` before final commit; 2 ahead/0 behind origin/main; dirty; not pushed.

Known issues / blockers: Visual appearance on macOS at desktop and narrow widths requires a real viewport review before claiming visual acceptance.

Exact next action: Run final suite and review branch diff; preserve missing visual verification in Slice 6 handoff.

Status: READY_FOR_NEXT_SLICE
