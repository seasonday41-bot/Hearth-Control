# Hearth Control — Slice 2 handoff

Project / Slice / Objective: Hearth Control / 2 / Remove embedded X, Market, MT5, Goal, Review Queue, and specialist runtimes after decoupling.

Work completed: Replaced Electron startup and preload with Core MCP, workspace, connection, settings, and updater handlers. Removed unreferenced X and Invest runtimes, MT5, Goal/Review/Specialist orchestration, their UI, IPC, scripts and documentation. Preserved the existing credential, GitHub, Vercel, JobManager, workspace, and updater modules. Removed obsolete package scripts and packaging paths. Separate repositories untouched.

Files changed: `electron/main.cjs`, `electron/preload.cjs`, `src/electron.d.ts`, `package.json`, `mcp/http.mjs`, removed legacy directories under `mcp/`, `mql5/`, `scripts/`, `src/`, `supabase/`, and obsolete docs; this handoff. The full branch diff records the individual deletions.

Validation results: `npm run build` passed; `npm run test:mcp` with live local HTTP process passed; `npm run test:mcp:stdio` passed with 25 tools and no X/Market; `npm run test:safety` passed 20/20; connection, GitHub, Vercel, updater and Electron Core boundary suites passed. Visual GUI not applicable to this removal slice.

Git state at handoff: `feature/hearth-mcp-core-v1`; HEAD `83f854eaeb1e78713c7a03dd642cfc6ed3ca5362` before final changes; origin/main `c53b967354c0277c6ed23f9f14bf04bdc37d8268`; 2 ahead/0 behind; dirty awaiting migration commit; not pushed.

Known issues / blockers: Native Mac application state remains unavailable through the terminated Hearth tunnel. Reconcile Mac workspace before local installation. No release or installation performed.

Exact next action: Verify the direct editing and background job MCP wrappers and their workspace/permission boundaries.

Status: READY_FOR_NEXT_SLICE
