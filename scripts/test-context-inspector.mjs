import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { rendererSource } from './lib/renderer-source.mjs';

const app = rendererSource();
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
// Guards that no secret VALUE is read or rendered. Matching the bare words
// would also fire on the safety copy that tells the operator credentials are
// never shown, so this targets the two ways a value could actually escape:
// reading it off an object, or interpolating it into the rendered tree.
test('INSPECTOR5 does not render private values', () => {
  assert.doesNotMatch(app, /process\.env/, 'the renderer must not read the environment');
  assert.doesNotMatch(
    app,
    /\.\s*(credentials|refreshToken|accessToken|clientSecret|apiKey|token)\b/i,
    'the renderer must not read a secret off any object',
  );
  assert.doesNotMatch(
    app,
    /\{[^{}]*\b(credentials|refreshToken|accessToken|clientSecret|apiKey)\b[^{}]*\}/i,
    'the renderer must not interpolate a secret into the rendered tree',
  );
});
test('INSPECTOR6 stream path remains fenced and stoppable', () => { assert.match(app, /chatRequestIdRef/); assert.match(app, /localChatStreamStop\(requestId\)/); });
test('INSPECTOR7 Context and existing updater UI share the authoritative runtime build metadata', async () => {
  const builder = await fs.readFile(new URL('../mcp/context/builder.mjs', import.meta.url), 'utf8');
  assert.match(main, /currentBuildId:\s*buildMetadata\.buildId/);
  assert.match(main, /ipcMain\.handle\('local-chat:context'[\s\S]*?buildId:\s*buildMetadata\.buildId/);
  assert.doesNotMatch(builder, /build-meta\.json|generate-build-meta|randomBytes/);
});

console.log('Context Inspector tests: 7 passed');
