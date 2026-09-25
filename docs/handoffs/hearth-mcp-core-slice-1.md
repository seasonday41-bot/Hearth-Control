# Hearth Control — Slice 1 handoff

Project / Slice / Objective: Hearth Control / 1 / Decouple exposed MCP Core from X and Market.

Work completed: Removed eager X runtime imports/initialization and removed X, old X/Market job router, Goal, Review Queue, and specialist MCP tool registrations. The Core Workspace, Files, Terminal, Git, GitHub, and Vercel registrations remain. Legacy code and Electron transports are still present for Slice 2.

Files changed: `mcp/tools.mjs`, this handoff.

Validation results: `npm run build` passed; `npm run test:mcp:stdio` passed and lists 19 Core tools; `npm run test:mcp` passed with the HTTP server launched in the same shell; `npm run test:safety` passed 20/20. No app visual verification in this slice. Git diff check passed.

Git state: branch `feature/hearth-mcp-core-v1`; baseline HEAD `c53b967354c0277c6ed23f9f14bf04bdc37d8268`; origin/main equal to baseline before edits; dirty pending commit; not pushed.

Known issues / blockers: Electron still wires old X, Market, Goal, Review Queue, and specialist runtimes/transports; old tests that assert those registrations may need removal only with corresponding feature removal. Live Mac state cannot be inspected through the terminated Hearth tunnel in this environment; reconcile before installation.

Exact next action: Inspect and decouple Electron/preload/UI dependencies, then remove unreferenced legacy features in Slice 2 without touching the separate X or X-Invest repositories.

Status: READY_FOR_NEXT_SLICE
