import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const mainSource = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
const preloadSource = fs.readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');

const extract = (startText, endText) => {
  const start = mainSource.indexOf(startText);
  const end = mainSource.indexOf(endText, start);
  assert.ok(start >= 0 && end > start, `could not extract ${startText}`);
  return mainSource.slice(start, end);
};

test('core saveSettings rejects any future *Encrypted write, not just current legacy keys', () => {
  const source = extract('const saveSettings = (next) => {', 'const removeSettingsKeys =');
  const factory = new Function(
    'readSettings',
    'writeSettingsDocument',
    `${source}; return saveSettings;`,
  );
  const saveSettings = factory(
    () => ({ theme: 'light', workspace: '/repo' }),
    (value) => value,
  );

  assert.throws(
    () => saveSettings({ futureCredentialEncrypted: 'ciphertext' }),
    /secret_settings_write_forbidden/,
  );
  assert.deepEqual(saveSettings({ theme: 'dark' }), { theme: 'dark', workspace: '/repo' });
});

test('settings:get strips every legacy encrypted field and renderer writes are allowlisted', () => {
  const snapshotSource = extract('const publicSettingsSnapshot = () => {', 'const sanitizeRendererSettingsInput =');
  const sanitizeSource = extract('const sanitizeRendererSettingsInput = (settings = {}) => {', '// Legacy decrypt-only helper');

  const snapshotFactory = new Function('readSettings', `${snapshotSource}; return publicSettingsSnapshot;`);
  const snapshot = snapshotFactory(() => ({
    workspace: '/repo',
    theme: 'dark',
    bridgeSessionEncrypted: 'cipher-a',
    publicTasksSessionEncrypted: 'cipher-b',
    bridgePairingEncrypted: 'cipher-c',
  }))();

  assert.deepEqual(snapshot, { workspace: '/repo', theme: 'dark' });

  const sanitizeFactory = new Function(`${sanitizeSource}; return sanitizeRendererSettingsInput;`);
  const sanitize = sanitizeFactory();
  assert.deepEqual(
    sanitize({
      workspace: '/repo',
      port: 3001,
      theme: 'dark',
      permissions: { Files: 'Allow' },
      bridgeSessionEncrypted: 'malicious-cipher',
      publicTasksSupabaseAnonKey: 'should-not-enter-through-settings-save',
    }),
    {
      workspace: '/repo',
      port: 3001,
      theme: 'dark',
      permissions: { Files: 'Allow' },
    },
  );
});

test('verified legacy migration writes canonical secret before deleting old settings field', () => {
  const source = extract('const migrateLegacyCredentialSetting = ({ settingKey, credentialRef }) => {', 'const migrateLegacyCredentials = () => {');
  const removals = [];
  const stored = new Map();
  const credentialStore = {
    hasSecret: (ref) => stored.has(ref),
    setSecret: (ref, value) => stored.set(ref, structuredClone(value)),
  };
  const readSettings = () => ({ publicTasksSessionEncrypted: 'legacy-cipher' });
  const decryptLocalSecret = (encoded) => encoded === 'legacy-cipher'
    ? { accessToken: 'x-token', refreshToken: 'x-refresh' }
    : null;
  const removeSettingsKeys = (keys) => removals.push(...keys);
  const factory = new Function(
    'credentialStore',
    'readSettings',
    'decryptLocalSecret',
    'removeSettingsKeys',
    'console',
    `${source}; return migrateLegacyCredentialSetting;`,
  );
  const migrate = factory(credentialStore, readSettings, decryptLocalSecret, removeSettingsKeys, { warn() {} });

  assert.equal(migrate({
    settingKey: 'publicTasksSessionEncrypted',
    credentialRef: 'credential:supabase:xgen',
  }), true);
  assert.equal(stored.get('credential:supabase:xgen').accessToken, 'x-token');
  assert.deepEqual(removals, ['publicTasksSessionEncrypted']);
});

test('failed secure migration preserves the legacy encrypted field', () => {
  const source = extract('const migrateLegacyCredentialSetting = ({ settingKey, credentialRef }) => {', 'const migrateLegacyCredentials = () => {');
  const removals = [];
  const credentialStore = {
    hasSecret: () => { throw new Error('secure_storage_unavailable'); },
    setSecret: () => { throw new Error('must not write'); },
  };
  const factory = new Function(
    'credentialStore',
    'readSettings',
    'decryptLocalSecret',
    'removeSettingsKeys',
    'console',
    `${source}; return migrateLegacyCredentialSetting;`,
  );
  const migrate = factory(
    credentialStore,
    () => ({ bridgeSessionEncrypted: 'legacy-cipher' }),
    () => ({ accessToken: 'legacy' }),
    (keys) => removals.push(...keys),
    { warn() {} },
  );

  assert.equal(migrate({
    settingKey: 'bridgeSessionEncrypted',
    credentialRef: 'credential:supabase:hearth',
  }), false);
  assert.deepEqual(removals, []);
});

test('existing canonical credential allows safe cleanup without overwriting it', () => {
  const source = extract('const migrateLegacyCredentialSetting = ({ settingKey, credentialRef }) => {', 'const migrateLegacyCredentials = () => {');
  const removals = [];
  let writes = 0;
  const credentialStore = {
    hasSecret: () => true,
    setSecret: () => { writes += 1; },
  };
  const factory = new Function(
    'credentialStore',
    'readSettings',
    'decryptLocalSecret',
    'removeSettingsKeys',
    'console',
    `${source}; return migrateLegacyCredentialSetting;`,
  );
  const migrate = factory(
    credentialStore,
    () => ({ bridgeSessionEncrypted: 'old-cipher' }),
    () => ({ accessToken: 'old' }),
    (keys) => removals.push(...keys),
    { warn() {} },
  );

  assert.equal(migrate({
    settingKey: 'bridgeSessionEncrypted',
    credentialRef: 'credential:supabase:hearth',
  }), true);
  assert.equal(writes, 0);
  assert.deepEqual(removals, ['bridgeSessionEncrypted']);
});

test('renderer connection IPC exposes read/refresh only and no credential operation', () => {
  assert.match(preloadSource, /connectionsList: \(\) => ipcRenderer\.invoke\('connections:list'\)/);
  assert.match(preloadSource, /connectionsRefresh: \(alias\) => ipcRenderer\.invoke\('connections:refresh', alias\)/);
  assert.doesNotMatch(preloadSource, /getCredential|setCredential|deleteSecret|getSecret|ciphertext/);
  assert.match(mainSource, /ipcMain\.handle\('connections:list'/);
  assert.match(mainSource, /ipcMain\.handle\('connections:refresh'/);
});

test('legacy encrypted settings are migration inputs only, never new write targets', () => {
  const matches = [...mainSource.matchAll(/bridgeSessionEncrypted|publicTasksSessionEncrypted|bridgePairingEncrypted/g)];
  assert.equal(matches.length, 3, 'each legacy encrypted key should appear only once in the migration map');
  assert.doesNotMatch(mainSource, /saveSettings\(\{\s*(bridgeSessionEncrypted|publicTasksSessionEncrypted|bridgePairingEncrypted)/);
});
