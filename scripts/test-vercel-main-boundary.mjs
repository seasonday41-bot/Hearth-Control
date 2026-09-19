import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const main = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
const preload = fs.readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
const http = fs.readFileSync(new URL('../mcp/http.mjs', import.meta.url), 'utf8');
const tools = fs.readFileSync(new URL('../mcp/tools.mjs', import.meta.url), 'utf8');
const client = fs.readFileSync(new URL('../electron/vercel/vercel-client.cjs', import.meta.url), 'utf8');
const service = fs.readFileSync(new URL('../electron/vercel/vercel-connection-service.cjs', import.meta.url), 'utf8');

test('P6 defines a dedicated Hearth Vercel permission with Ask default', () => {
  assert.match(main, /Vercel: 'Ask'/);
  const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /name: 'Vercel'.*value: 'Ask'/);
  assert.match(tools, /requirePermission\('Vercel'/);
});

test('P6 local IPC exposes connect/disconnect but no credential getter', () => {
  assert.match(preload, /vercelConnect: \(request\) => ipcRenderer\.invoke\('vercel:connect', request\)/);
  assert.match(preload, /vercelDisconnect: \(alias\) => ipcRenderer\.invoke\('vercel:disconnect', alias\)/);
  assert.match(main, /ipcMain\.handle\('vercel:connect'/);
  assert.match(main, /ipcMain\.handle\('vercel:disconnect'/);
  assert.doesNotMatch(preload, /vercel.*(?:getToken|getCredential|getSecret|ciphertext)/i);
});

test('P6 never imports Vercel global CLI/environment auth', () => {
  const combined = [main, http, tools, client, service].join('\n');
  assert.doesNotMatch(combined, /process\.env\.VERCEL_TOKEN/);
  assert.doesNotMatch(combined, /\bvercel\s+(?:whoami|login|logout|switch|env|deploy)\b/i);
  assert.doesNotMatch(combined, /\.vercel\/project\.json/);
});

test('P6 MCP relay carries request metadata only; Electron main resolves credential', () => {
  assert.match(http, /vercel_projects_list_request/);
  assert.match(http, /vercel_deployment_get_request/);
  assert.match(main, /vercelConnectionService\.listProjects\(message\.connection/);
  assert.match(main, /vercelConnectionService\.getDeployment\(message\.connection/);
  assert.doesNotMatch(http, /Authorization.*Bearer/);
  assert.doesNotMatch(tools, /Authorization.*Bearer/);
  assert.doesNotMatch(http, /credential:vercel:/);
  assert.doesNotMatch(tools, /credential:vercel:/);
});

test('P6 uses fixed Vercel API origin and GET-only REST client', () => {
  assert.match(client, /const API_ORIGIN = 'https:\/\/api\.vercel\.com'/);
  assert.doesNotMatch(client, /baseUrl|apiBaseUrl|apiOrigin\s*=/i);
  assert.match(client, /method: 'GET'/);
  assert.doesNotMatch(client, /method:\s*'(?:POST|PATCH|PUT|DELETE)'/);
});

test('P6 default capabilities are strictly read-only', () => {
  assert.match(service, /DEFAULT_VERCEL_CAPABILITIES[\s\S]*'project\.read'[\s\S]*'deployment\.read'/);
  const defaultBlock = service.slice(
    service.indexOf('const DEFAULT_VERCEL_CAPABILITIES'),
    service.indexOf('const sanitizeError'),
  );
  assert.doesNotMatch(defaultBlock, /deployment\.create|environment\.write|environment\.read/);
});

test('P6 provider/MCP source contains no deployment/domain/environment mutation implementation', () => {
  for (const forbidden of [
    'vercel_deploy',
    'vercel_deployment_create',
    'vercel_deployment_promote',
    'vercel_deployment_rollback',
    'vercel_domain_add',
    'vercel_domain_remove',
    'vercel_environment_get',
    'vercel_environment_set',
    'vercel_environment_delete',
  ]) {
    assert.doesNotMatch(tools, new RegExp(`server\\.registerTool\\('${forbidden}'`));
  }
  assert.doesNotMatch(service, /createDeployment|promoteDeployment|rollbackDeployment|setEnvironment|deleteEnvironment|addDomain|removeDomain/);
});
