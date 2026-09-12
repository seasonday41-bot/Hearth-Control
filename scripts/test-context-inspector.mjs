import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';

const app = await fs.readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
const preload = await fs.readFile(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
const main = await fs.readFile(new URL('../electron/main.cjs', import.meta.url), 'utf8');

test('INSPECTOR1 Context button opens and toggles the inspector', () => {
  assert.match(app, /aria-expanded=\{showChatContext\}/);
  assert.match(app, /onClick=\{\(\) => void toggleChatContext\(\)\}/);
  assert.match(app, /setShowChatContext\(false\)/);
});
test('INSPECTOR2 Close dismisses the inspector', () => assert.match(app, /Context supplied to Local AI[\s\S]*?onClick=\{\(\) => setShowChatContext\(false\)\}/));
test('INSPECTOR3 all readable sections render', () => { for (const section of ['Runtime', 'Capabilities', 'Project', 'Safety', 'Response Style']) assert.match(app, new RegExp(`<h3>${section}<\\/h3>`)); });
test('INSPECTOR4 uses the narrow IPC context path', () => { assert.match(app, /localChatContext\(/); assert.match(preload, /localChatContext: \(request\) => ipcRenderer\.invoke\('local-chat:context', request\)/); assert.match(main, /ipcMain\.handle\('local-chat:context'/); });
test('INSPECTOR5 does not render private values', () => { assert.doesNotMatch(app, /credentials|OAuth|refreshToken|accessToken|process\.env/); });
test('INSPECTOR6 stream path remains fenced and stoppable', () => { assert.match(app, /chatRequestIdRef/); assert.match(app, /localChatStreamStop\(requestId\)/); });
test('INSPECTOR7 Context and existing updater UI share the authoritative runtime build metadata', async () => {
  const builder = await fs.readFile(new URL('../mcp/context/builder.mjs', import.meta.url), 'utf8');
  assert.match(main, /currentBuildId:\s*buildMetadata\.buildId/);
  assert.match(main, /ipcMain\.handle\('local-chat:context'[\s\S]*?buildId:\s*buildMetadata\.buildId/);
  assert.doesNotMatch(builder, /build-meta\.json|generate-build-meta|randomBytes/);
});

console.log('Context Inspector tests: 7 passed');
