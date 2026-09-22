import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const mainSource = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');

test('MB1 app startup invokes the X Coder Service packaged lifecycle before the window is created', () => {
  const whenReadyStart = mainSource.indexOf('app.whenReady().then(async () => {');
  assert.ok(whenReadyStart >= 0, 'app.whenReady() block not found');

  const createWindowCall = mainSource.indexOf('createWindow();', whenReadyStart);
  assert.ok(createWindowCall > whenReadyStart, 'createWindow() call not found after whenReady()');

  const startupBlock = mainSource.slice(whenReadyStart, createWindowCall);

  assert.match(startupBlock, /mcp\/x-coder-service\/packaged-lifecycle\.mjs/, 'packaged-lifecycle module must be imported during startup');
  assert.match(startupBlock, /ensureXCoderServiceInstalled/, 'ensureXCoderServiceInstalled must be invoked during startup');
  assert.match(startupBlock, /isPackaged:\s*app\.isPackaged/, 'must gate on the real Electron packaged flag, not a hardcoded value');
  assert.match(startupBlock, /resourcesPath:\s*process\.resourcesPath/, 'must resolve from the real installed app resources path');
  assert.match(startupBlock, /appVersion:\s*app\.getVersion\(\)/, 'must resolve from the real running app version, so an update moves the LaunchAgent');
});

test('MB2 the lifecycle call is wrapped so a failure cannot abort app startup', () => {
  const whenReadyStart = mainSource.indexOf('app.whenReady().then(async () => {');
  const lifecycleImport = mainSource.indexOf('packaged-lifecycle.mjs', whenReadyStart);
  assert.ok(lifecycleImport > whenReadyStart, 'packaged-lifecycle import not found in startup block');

  const precedingTry = mainSource.lastIndexOf('try {', lifecycleImport);
  const followingCatch = mainSource.indexOf('} catch (err) {', lifecycleImport);
  assert.ok(precedingTry >= 0 && precedingTry < lifecycleImport, 'lifecycle call must be inside a try block');
  assert.ok(followingCatch > lifecycleImport, 'lifecycle call must be inside a matching catch block');

  const createWindowCall = mainSource.indexOf('createWindow();', whenReadyStart);
  assert.ok(followingCatch < createWindowCall, 'the try/catch must resolve before createWindow() runs');
});
