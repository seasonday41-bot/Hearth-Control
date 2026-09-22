import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('PC1 the electron-builder config unpacks mcp/** so it exists as real files, not only inside app.asar', () => {
  assert.equal(pkg.build.asar, true, 'the app must still ship asar-archived for everything else');
  assert.ok(Array.isArray(pkg.build.asarUnpack), 'build.asarUnpack must be configured');
  assert.ok(
    pkg.build.asarUnpack.some((pattern) => pattern === 'mcp/**/*' || pattern === 'mcp/**'),
    'mcp/** must be unpacked so fs.cpSync can stage it as an ordinary directory, not an asar virtual path',
  );
  assert.ok(pkg.build.files.includes('mcp/**/*'), 'mcp/**/* must still be part of the packaged files');
});
