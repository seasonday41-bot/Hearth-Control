# Control App V1

A local macOS desktop control center, built with Electron, React, TypeScript, and Vite.

## Run it

```bash
npm install
npm run dev
```

`npm run build` creates the production renderer bundle in `dist/`.

## Functional V1

- Uses the native macOS folder picker for workspace selection.
- Persists workspace, port, theme, and permission choices in Electron's app data directory.
- Starts and stops a dedicated local Node.js server process.
- Streams process state and logs from Electron to the React interface over a restricted preload bridge.
- Exposes Streamable HTTP MCP at `POST /mcp`, plus `GET /health` and `GET /tools`, on `127.0.0.1:3001` by default.
- Provides a local stdio transport with `npm run mcp:stdio`.
- Sends one-time approval requests back to the desktop app when a permission is set to `Ask`.

## MCP tools

- `workspace_info`
- `list_files`
- `search_files`
- `read_file`
- `write_file`
- `git_status`
- `git_diff`
- `run_command`

Every filesystem path is resolved against the selected workspace. Parent traversal and symlink escapes are rejected. `Allow` runs the request, `Ask` opens a one-time approval dialog in the app for HTTP connections, and `Blocked` rejects it. Stdio runs without a desktop approval channel, so `Ask` is rejected safely.

Run `npm run test:mcp` while the desktop server is active to verify Streamable HTTP, or `npm run test:mcp:stdio` to verify the local stdio launcher. See `mcp-config.example.json` for a client configuration example.
