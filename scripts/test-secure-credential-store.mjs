import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SecureCredentialStore } = require('../electron/security/secure-credential-store.cjs');

const tempFile = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-p3-credentials-'));
  return path.join(dir, 'credentials.json');
};

const createSafeStorage = ({ available = true } = {}) => ({
  isEncryptionAvailable: () => available,
  encryptString: (value) => Buffer.from(`wrapped:${Buffer.from(value, 'utf8').toString('base64')}`, 'utf8'),
  decryptString: (buffer) => {
    const encoded = buffer.toString('utf8');
    if (!encoded.startsWith('wrapped:')) throw new Error('bad ciphertext');
    return Buffer.from(encoded.slice('wrapped:'.length), 'base64').toString('utf8');
  },
});

test('stores encrypted payloads and returns the original secret only through trusted API', () => {
  const storagePath = tempFile();
  const store = new SecureCredentialStore({
    storagePath,
    safeStorage: createSafeStorage(),
    now: () => '2026-09-19T00:00:00.000Z',
  });

  store.setSecret('credential:supabase:hearth', {
    accessToken: 'ACCESS_SECRET_VALUE',
    refreshToken: 'REFRESH_SECRET_VALUE',
    email: 'owner@example.com',
  });

  const raw = fs.readFileSync(storagePath, 'utf8');
  assert.ok(!raw.includes('ACCESS_SECRET_VALUE'));
  assert.ok(!raw.includes('REFRESH_SECRET_VALUE'));
  assert.equal(store.hasSecret('credential:supabase:hearth'), true);

  const secret = store.getSecret('credential:supabase:hearth');
  assert.equal(secret.accessToken, 'ACCESS_SECRET_VALUE');
  assert.equal(secret.refreshToken, 'REFRESH_SECRET_VALUE');
});

test('deleting one credential does not affect another', () => {
  const storagePath = tempFile();
  const store = new SecureCredentialStore({ storagePath, safeStorage: createSafeStorage() });

  store.setSecret('credential:supabase:hearth', { accessToken: 'one' });
  store.setSecret('credential:supabase:xgen', { accessToken: 'two' });

  assert.equal(store.deleteSecret('credential:supabase:hearth'), true);
  assert.equal(store.getSecret('credential:supabase:hearth'), null);
  assert.equal(store.getSecret('credential:supabase:xgen').accessToken, 'two');
});

test('safeStorage unavailable fails closed for every credential operation', () => {
  const storagePath = tempFile();
  const store = new SecureCredentialStore({
    storagePath,
    safeStorage: createSafeStorage({ available: false }),
  });

  assert.throws(() => store.hasSecret('credential:supabase:hearth'), /secure_storage_unavailable/);
  assert.throws(() => store.setSecret('credential:supabase:hearth', { token: 'x' }), /secure_storage_unavailable/);
  assert.throws(() => store.getSecret('credential:supabase:hearth'), /secure_storage_unavailable/);
  assert.throws(() => store.deleteSecret('credential:supabase:hearth'), /secure_storage_unavailable/);
  assert.equal(fs.existsSync(storagePath), false);
});
