import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const main = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
const preload = fs.readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');

test('renderer settings are allowlisted and legacy encrypted settings are never returned', () => {
  assert.match(main, /Object\.entries\(request \|\| \{\}\)\.filter\(\(\[key\]\) => \['workspace', 'port', 'theme', 'permissions'\]/);
  assert.match(main, /secret_settings_write_forbidden/);
  assert.match(main, /const readSettings = \(\) => \{[\s\S]*?workspace:[\s\S]*?permissions:/);
  assert.doesNotMatch(preload, /getSecret|setSecret|ciphertext|credentialRef/);
});

test('existing encrypted settings are preserved on save without being sent to renderer', () => {
  assert.match(main, /JSON\.stringify\(\{ \.\.\.readRawSettings\(\), \.\.\.next \}/);
  assert.doesNotMatch(main, /publicTasksSessionEncrypted|bridgeSessionEncrypted|bridgePairingEncrypted/);
});

test('only GitHub and Vercel connection metadata is displayed and credentials stay in SecureCredentialStore', () => {
  assert.match(main, /new SecureCredentialStore/);
  assert.match(main, /\['github', 'vercel'\]\.includes\(record\.provider\)/);
  assert.match(preload, /connectionsList: \(\) => ipcRenderer\.invoke\('connections:list'\)/);
  assert.match(preload, /connectionsRefresh: \(alias\) => ipcRenderer\.invoke\('connections:refresh', alias\)/);
  assert.doesNotMatch(preload, /getCredential|setCredential|deleteSecret|getSecret/);
});
