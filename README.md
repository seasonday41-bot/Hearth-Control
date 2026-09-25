# Hearth Control

Hearth is a local MCP control center for ChatGPT on macOS. ChatGPT directs the work; Hearth provides workspace, file editing, command, job, Git, GitHub and Vercel tools. LAYA is an optional advice and review endpoint. Hearth does not run an autonomous coding or investment agent.

## Development

```bash
npm ci
npm run build
npm run test:mcp:stdio
npm run test:safety
npm run test:coding-tools
npm run test:laya
node --test scripts/test-core-electron-runtime.mjs
```

`npm run dev` opens the Electron dashboard on macOS. Set a workspace in Settings, review access levels under Tools, then start the MCP server. The server listens on `127.0.0.1` and the dashboard never displays stored credentials.

For direct stdio MCP, set `HEARTH_WORKSPACE` to an existing folder and `HEARTH_PERMISSIONS` to a JSON object mapping access names to `Allow`, `Ask` or `Blocked`. See `mcp-config.example.json`. Stdio has no approval UI, so `Ask` denies without an approval transport.

## MCP tools

| Area | Tools | Permission |
| --- | --- | --- |
| Workspace and files | `workspace_info`, `list_files`, `search_files`, `read_file`, `write_file`, `apply_patch` | Files |
| Terminal and jobs | `run_command`, `job_start`, `job_status`, `job_output`, `job_stop` | Terminal |
| Git | `git_status`, `git_diff` | Git |
| GitHub | `github_connections_list`, `github_repositories_list`, `github_repository_get`, `github_pull_requests_list`, `github_pull_request_create` | Git |
| Vercel | `vercel_projects_list`, `vercel_project_get`, `vercel_deployments_list`, `vercel_deployment_get` | Vercel |
| Optional specialist | `laya_status`, `laya_consult`, `laya_review` | LAYA for consult/review |

`apply_patch` accepts a standard unified `git diff` patch against existing files. It checks every path through the workspace guard and rejects a patch whose context does not match. Jobs use the existing JobManager with bounded, redacted output. `job_stop` can stop only a child owned by the current MCP process; persisted jobs that lose ownership after restart require manual recovery.

GitHub and Vercel tokens stay in Electron's encrypted credential store. MCP receives connection aliases and results, never token material. GitHub pull request creation still requires its configured Git access level.

## Optional LAYA

Set `HEARTH_LAYA_ENDPOINT` to a credential-free loopback HTTP base URL, for example `http://127.0.0.1:8765/`. The adapter calls `GET /status`, `POST /consult` and `POST /review` with JSON. The remote service must return JSON. When unset, status reports unavailable; no work routes through LAYA. Consult and review send user-supplied text only and have no Hearth file or shell authority.

## Updater

The existing signed release and local update modules remain in `electron/`. Installation is initiated only by the local Electron window after native approval and update validation. It is blocked while the MCP server is running or a persisted generic job is pending/requires recovery. This branch does not install, release, merge or deploy anything.

See [release process](docs/RELEASE_PROCESS.md) for the separate release workflow.
