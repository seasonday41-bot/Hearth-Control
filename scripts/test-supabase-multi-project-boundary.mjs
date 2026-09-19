import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const main = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
const model = fs.readFileSync(new URL('../mcp/connections/model.mjs', import.meta.url), 'utf8');
const service = fs.readFileSync(new URL('../electron/supabase/supabase-project-service.cjs', import.meta.url), 'utf8');

const slice = (startText, endText) => {
  const start = main.indexOf(startText);
  const end = main.indexOf(endText, start);
  assert.ok(start >= 0 && end > start, `could not extract ${startText}`);
  return main.slice(start, end);
};

test('P5 main auth wrappers bind Hearth and XGEN to explicit different aliases', () => {
  const hearth = slice(
    'const supabaseAuthRequest = async (pathName, body) => {',
    '\nconst applyBridgeSession =',
  );
  const xgen = slice(
    'const supabasePublicTasksAuthRequest = async (pathName, body) => {',
    '\nconst applyPublicTasksSession =',
  );

  assert.match(hearth, /BRIDGE_CONNECTION_ALIAS/);
  assert.doesNotMatch(hearth, /PUBLIC_TASKS_CONNECTION_ALIAS/);
  assert.match(xgen, /PUBLIC_TASKS_CONNECTION_ALIAS/);
  assert.doesNotMatch(xgen, /BRIDGE_CONNECTION_ALIAS/);
  assert.doesNotMatch(hearth, /readSettings\(\)/);
  assert.doesNotMatch(xgen, /readSettings\(\)/);
});

test('P5 existing clients initialize from alias-resolved project configs only', () => {
  const startup = slice(
    "const { ReviewItemsClient, resyncPendingReviewItems, syncReviewItemToRemote }",
    'const registerBridgeDevice = async () => {',
  );

  assert.match(startup, /getProjectConfig\(BRIDGE_CONNECTION_ALIAS/);
  assert.match(startup, /getProjectConfig\(PUBLIC_TASKS_CONNECTION_ALIAS/);

  const bridgeCtor = startup.slice(
    startup.indexOf('bridgeClientInstance = new HearthBridgeClient'),
    startup.indexOf('bridgeClientInstance.setSession'),
  );
  assert.match(bridgeCtor, /hearthProject\.url/);
  assert.match(bridgeCtor, /hearthProject\.publishableKey/);
  assert.doesNotMatch(bridgeCtor, /xgenProject/);

  for (const clientName of ['PublicTasksClient', 'ReviewItemsClient', 'GoalRequestsClient']) {
    const start = startup.indexOf(`new ${clientName}`);
    assert.ok(start >= 0, `${clientName} constructor missing`);
    const block = startup.slice(start, startup.indexOf('});', start) + 3);
    assert.match(block, /xgenProject\.url/);
    assert.match(block, /xgenProject\.publishableKey/);
    assert.doesNotMatch(block, /hearthProject/);
  }
});

test('P5 Project X publishable-key update synchronizes registry plus all three XGEN clients', () => {
  const handler = slice(
    "ipcMain.handle('publicTasks:save-anon-key'",
    "ipcMain.handle('publicTasks:sign-up'",
  );

  assert.match(handler, /supabaseProjectService\.updateProjectConfig\(PUBLIC_TASKS_CONNECTION_ALIAS/);
  assert.match(handler, /publicTasksClientInstance\?\.setSession\(\{ supabaseAnonKey: publishableKey \}\)/);
  assert.match(handler, /reviewItemsClientInstance\?\.setSession\(\{ supabaseAnonKey: publishableKey \}\)/);
  assert.match(handler, /goalRequestsClientInstance\?\.setSession\(\{ supabaseAnonKey: publishableKey \}\)/);
  assert.match(handler, /saveSettings\(\{ publicTasksSupabaseAnonKey: publishableKey \}\)/);
});

test('P5 renderer-safe connection list and refresh dispatch Supabase through provider service', () => {
  const block = slice(
    'const listPublicConnections = () => {',
    "ipcMain.handle('github:connect'",
  );
  assert.match(block, /connection\.provider === 'supabase'/);
  assert.match(block, /supabaseProjectService\.publicSnapshot\(connection\.alias\)/);
  assert.match(block, /supabaseProjectService\.refreshHealth\(connectionAlias\)/);
});

test('P5 runtime device REST operations use Hearth alias config, not raw Supabase settings', () => {
  const block = slice(
    'const registerBridgeDevice = async () => {',
    'let publicXTaskRowsById = new Map()',
  );
  assert.match(block, /getProjectConfig\(BRIDGE_CONNECTION_ALIAS\)/);
  assert.match(block, /hearthProjectConfig\.url/);
  assert.match(block, /hearthProjectConfig\.publishableKey/);
  assert.doesNotMatch(block, /currentSettings\.supabaseUrl/);
  assert.doesNotMatch(block, /currentSettings\.supabaseAnonKey/);
});

test('P5 connection registry seeds publishable config under the correct Supabase aliases', () => {
  const hearth = model.slice(
    model.indexOf("alias: 'supabase:hearth'"),
    model.indexOf("alias: 'supabase:xgen'"),
  );
  const xgen = model.slice(
    model.indexOf("alias: 'supabase:xgen'"),
    model.indexOf("alias: 'vercel:main'"),
  );
  assert.match(hearth, /settings\.supabaseUrl/);
  assert.match(hearth, /settings\.supabaseAnonKey/);
  assert.doesNotMatch(hearth, /publicTasksSupabase/);
  assert.match(xgen, /settings\.publicTasksSupabaseUrl/);
  assert.match(xgen, /settings\.publicTasksSupabaseAnonKey/);
});

test('P5 provider forbids secret/service-role keys and never exposes publishable key in public snapshot', () => {
  assert.match(service, /sb_secret_/);
  assert.match(service, /service_role/);
  const publicSnapshot = service.slice(
    service.indexOf('publicSnapshot(alias) {'),
    service.indexOf('async refreshHealth(alias) {'),
  );
  assert.match(publicSnapshot, /publishableKeyConfigured/);
  assert.doesNotMatch(publicSnapshot, /publishableKey:\s*connection/);
  assert.doesNotMatch(publicSnapshot, /publishableKey:\s*config/);
});

test('P5 runtime no longer reads raw Supabase project URL/key settings outside compatibility/default surfaces', () => {
  // Direct runtime auth/client/device behavior must use alias authority.
  const runtimeStart = main.indexOf('const supabaseAuthRequest = async');
  const runtime = main.slice(runtimeStart);
  assert.doesNotMatch(runtime, /settings\.supabaseUrl/);
  assert.doesNotMatch(runtime, /settings\.supabaseAnonKey/);
  assert.doesNotMatch(runtime, /settings\.publicTasksSupabaseUrl/);
  assert.doesNotMatch(runtime, /settings\.publicTasksSupabaseAnonKey/);
  assert.doesNotMatch(runtime, /currentSettings\.supabaseUrl/);
  assert.doesNotMatch(runtime, /currentSettings\.supabaseAnonKey/);
});
