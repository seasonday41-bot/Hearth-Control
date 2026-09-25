# Hearth Control — Mac review continuation

Project / Slice / Objective: Hearth Control / 6 review / Verify the pushed MCP Core branch on Mac before installation.

Work completed: Reviewed screenshots of the Dashboard running under `npm run dev` in a separate Mac worktree at `44385610f0cc9ec8ba8a3c438773e7c6d9daa98f`. Light and dark desktop views rendered with real workspace, tool, connection and job state. A narrower screenshot revealed that the 680px single-column breakpoint was unreachable with Electron's 740px minimum window width. Moved the card stacking breakpoint to 900px and corrected the native page title to Hearth Control. No installation performed.

Files changed: `src/control-center.css`, `index.html`, this handoff.

Validation results: Mac `npm run build` passed; MCP stdio discovered 25 tools; safety 20/20, coding tools 5/5, jobs 10/10, LAYA 3/3, Electron Core 1/1, connections 14/14, GitHub 30/30, Vercel 31/31 all passed according to Mac Terminal transcript supplied by the user. Linux `npm run build` passed after breakpoint/title edits. Mac desktop visual runtime passed for the preceding commit; the revised 900px stacking behavior still needs one screenshot after updating the Mac review worktree. Real LAYA provider remains unconfigured.

Git state at handoff: branch `feature/hearth-mcp-core-v1`; base remote feature HEAD `4438561` before this follow-up commit; original Mac checkout remains `chore/system-ui-consolidation` with its three pre-existing local changes; review worktree is detached and has an untracked `node_modules` symlink used for tests; follow-up commit not pushed yet.

Known issues / blockers: Hearth tunnel returned internal errors during Mac testing; manual Terminal output and screenshots supplied evidence instead. No narrow-width screenshot of the fixed revision yet. Verify the latest commit on Mac before considering installation; do not use the dirty original checkout as a build source.

Packaging continuation: The Mac electron-builder run in the review worktree reported unresolved dependencies while `node_modules` was a symlink to the original checkout. Inspection also found `mcp/http.mjs` imports `express` directly while the manifest omitted it; the follow-up explicitly declares `express` in `package.json` and `package-lock.json`. Build and stdio MCP discovery passed after the manifest change on Linux. Before attempting installation, replace only the review worktree's `node_modules` symlink with a real `npm ci`, rebuild the Mac DMG, and inspect the packaged runtime. An earlier DMG is not validated for installation.

Exact next action: Transfer and push the follow-up commit, update the isolated Mac review worktree, verify a narrow window stacks cards, and inspect runtime before any installation.

Status: READY_FOR_REVIEW
