import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveHearthRuntimeDatabasePath, HEARTH_RUNTIME_DB_FILENAME } from '../mcp/x/runtime-paths.mjs';

const fakeHomedir = () => '/fake/home/user';

test('absolute HEARTH_RUNTIME_DIR override is used verbatim (joined with the fixed filename)', () => {
  const result = resolveHearthRuntimeDatabasePath({ env: { HEARTH_RUNTIME_DIR: '/custom/runtime/dir' }, homedir: fakeHomedir });
  assert.equal(result, path.join('/custom/runtime/dir', HEARTH_RUNTIME_DB_FILENAME));
});

test('whitespace around an absolute override is trimmed before use', () => {
  const result = resolveHearthRuntimeDatabasePath({ env: { HEARTH_RUNTIME_DIR: '  /custom/runtime/dir  ' }, homedir: fakeHomedir });
  assert.equal(result, path.join('/custom/runtime/dir', HEARTH_RUNTIME_DB_FILENAME));
});

test('an empty-string override falls back to the homedir default', () => {
  const result = resolveHearthRuntimeDatabasePath({ env: { HEARTH_RUNTIME_DIR: '' }, homedir: fakeHomedir });
  assert.equal(result, path.join('/fake/home/user', '.hearth-control', 'runtime', HEARTH_RUNTIME_DB_FILENAME));
});

test('a whitespace-only override falls back to the homedir default', () => {
  const result = resolveHearthRuntimeDatabasePath({ env: { HEARTH_RUNTIME_DIR: '   ' }, homedir: fakeHomedir });
  assert.equal(result, path.join('/fake/home/user', '.hearth-control', 'runtime', HEARTH_RUNTIME_DB_FILENAME));
});

test('an unset override falls back to the homedir default', () => {
  const result = resolveHearthRuntimeDatabasePath({ env: {}, homedir: fakeHomedir });
  assert.equal(result, path.join('/fake/home/user', '.hearth-control', 'runtime', HEARTH_RUNTIME_DB_FILENAME));
});

test('a relative HEARTH_RUNTIME_DIR override throws TypeError rather than silently resolving against cwd', () => {
  assert.throws(
    () => resolveHearthRuntimeDatabasePath({ env: { HEARTH_RUNTIME_DIR: 'relative/dir' }, homedir: fakeHomedir }),
    TypeError,
  );
  assert.throws(
    () => resolveHearthRuntimeDatabasePath({ env: { HEARTH_RUNTIME_DIR: './relative/dir' }, homedir: fakeHomedir }),
    TypeError,
  );
  assert.throws(
    () => resolveHearthRuntimeDatabasePath({ env: { HEARTH_RUNTIME_DIR: '  relative/dir  ' }, homedir: fakeHomedir }),
    TypeError,
    'a relative path padded with whitespace must still be rejected after trimming',
  );
});

test('the resolver is deterministic: identical inputs always produce the identical path', () => {
  const a = resolveHearthRuntimeDatabasePath({ env: { HEARTH_RUNTIME_DIR: '/custom/runtime/dir' }, homedir: fakeHomedir });
  const b = resolveHearthRuntimeDatabasePath({ env: { HEARTH_RUNTIME_DIR: '/custom/runtime/dir' }, homedir: fakeHomedir });
  assert.equal(a, b);
  const c = resolveHearthRuntimeDatabasePath({ env: {}, homedir: fakeHomedir });
  const d = resolveHearthRuntimeDatabasePath({ env: {}, homedir: fakeHomedir });
  assert.equal(c, d);
});

test('exact path shape matches the locked convention for both branches', () => {
  const overridden = resolveHearthRuntimeDatabasePath({ env: { HEARTH_RUNTIME_DIR: '/opt/hearth-data' }, homedir: fakeHomedir });
  assert.equal(overridden, path.join('/opt/hearth-data', 'hearth-runtime.sqlite'));

  const fallback = resolveHearthRuntimeDatabasePath({ env: {}, homedir: fakeHomedir });
  assert.equal(fallback, path.join('/fake/home/user', '.hearth-control', 'runtime', 'hearth-runtime.sqlite'));
});

test('the resolver never creates any directory or file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-runtime-paths-'));
  const result = resolveHearthRuntimeDatabasePath({ env: { HEARTH_RUNTIME_DIR: path.join(dir, 'does-not-exist-yet') }, homedir: fakeHomedir });
  assert.equal(fs.existsSync(path.join(dir, 'does-not-exist-yet')), false);
  assert.equal(fs.existsSync(result), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the module source has no real Electron import/require dependency (comments mentioning it are fine)', () => {
  const modulePath = fileURLToPath(new URL('../mcp/x/runtime-paths.mjs', import.meta.url));
  const source = fs.readFileSync(modulePath, 'utf8');
  const dependencyPattern = /\bimport\b[^;\n]*from\s+['"]electron['"]|\brequire\(\s*['"]electron['"]\s*\)|\bimport\(\s*['"]electron['"]\s*\)/;
  assert.ok(!dependencyPattern.test(source), 'runtime-paths.mjs must not import/require the electron module');
});
