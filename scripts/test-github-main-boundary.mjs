import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const main = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
const preload = fs.readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
const http = fs.readFileSync(new URL('../mcp/http.mjs', import.meta.url), 'utf8');
const tools = fs.readFileSync(new URL('../mcp/tools.mjs', import.meta.url), 'utf8');
const updaterTrust = fs.readFileSync(new URL('../electron/update-trust-config.cjs', import.meta.url), 'utf8');
const remoteUpdater = fs.readFileSync(new URL('../electron/remote-updater.cjs', import.meta.url), 'utf8');
const githubClient = fs.readFileSync(new URL('../electron/github/github-client.cjs', import.meta.url), 'utf8');
const githubService = fs.readFileSync(new URL('../electron/github/github-connection-service.cjs', import.meta.url), 'utf8');

test('P4 boundary exposes local connect/disconnect but no renderer credential getter', () => {
  assert.match(preload, /githubConnect: \(request\) => ipcRenderer\.invoke\('github:connect', request\)/);
  assert.match(preload, /githubDisconnect: \(alias\) => ipcRenderer\.invoke\('github:disconnect', alias\)/);
  assert.doesNotMatch(preload, /github.*(?:getToken|getCredential|getSecret|ciphertext)/i);
  assert.match(main, /ipcMain\.handle\('github:connect'/);
  assert.match(main, /ipcMain\.handle\('github:disconnect'/);
});

test('P4 boundary never consumes GH_TOKEN/GITHUB_TOKEN or global gh auth state', () => {
  const combined = [main, http, tools, githubClient, githubService].join('\n');
  assert.doesNotMatch(combined, /process\.env\.(?:GH_TOKEN|GITHUB_TOKEN)/);
  assert.doesNotMatch(combined, /gh\s+auth\s+(?:token|switch)/i);
  assert.doesNotMatch(combined, /execFile.*\bgh\b/);
});

test('P4 MCP relay messages contain request metadata only and main owns credential resolution', () => {
  assert.match(http, /github_repositories_list_request/);
  assert.match(http, /github_pull_request_create_request/);
  assert.match(main, /githubConnectionService\.listRepositories\(message\.connection/);
  assert.match(main, /githubConnectionService\.createPullRequest\(message\.connection/);
  assert.doesNotMatch(http, /Authorization.*Bearer/);
  assert.doesNotMatch(tools, /Authorization.*Bearer/);
  assert.doesNotMatch(http, /credential:github:/);
  assert.doesNotMatch(tools, /credential:github:/);
});

test('P4 fixed GitHub API authority has no arbitrary base URL option', () => {
  assert.match(githubClient, /const API_ORIGIN = 'https:\/\/api\.github\.com'/);
  assert.match(githubClient, /const API_VERSION = '2026-03-10'/);
  assert.doesNotMatch(githubClient, /baseUrl|apiBaseUrl|apiOrigin\s*=/i);
});

test('P4 does not couple credentials into frozen P2 updater trust path', () => {
  assert.match(updaterTrust, /Hearth-Control-Releases/);
  assert.doesNotMatch(updaterTrust, /github:personal|github:work|credential:github|GitHubConnectionService/);
  assert.doesNotMatch(remoteUpdater, /github:personal|github:work|credential:github|GitHubConnectionService/);
});

test('P4 generic push/merge/release/admin operations are absent from GitHub provider and MCP tools', () => {
  const combined = [githubClient, githubService, tools].join('\n');
  assert.doesNotMatch(combined, /github_(?:push|merge|release|delete_repository|admin)/i);
  assert.doesNotMatch(githubClient, /\/merges(?:['`/])/);
  assert.doesNotMatch(githubClient, /\/releases(?:['`/])/);
});
