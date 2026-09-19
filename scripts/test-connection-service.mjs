import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ConnectionRegistry } from '../mcp/connections/registry.mjs';
import { builtinConnectionDefinitions } from '../mcp/connections/model.mjs';

const require = createRequire(import.meta.url);
const { SecureCredentialStore } = require('../electron/security/secure-credential-store.cjs');
const { ConnectionService } = require('../electron/connections/connection-service.cjs');

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`enc:${Buffer.from(value).toString('base64')}`),
  decryptString: (buffer) => Buffer.from(buffer.toString().slice(4), 'base64').toString(),
};

const buildHarness = ({ now = 10_000 } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-p3-service-'));
  const registry = new ConnectionRegistry({ storagePath: path.join(dir, 'connections.json') });
  registry.load();
  registry.ensure(builtinConnectionDefinitions({
    supabaseUrl: 'https://hearth.test',
    publicTasksSupabaseUrl: 'https://xgen.test',
  }));
  const secureStore = new SecureCredentialStore({
    storagePath: path.join(dir, 'credentials.json'),
    safeStorage,
  });
  const service = new ConnectionService({ registry, secureStore, now: () => now });
  return { registry, secureStore, service };
};

test('health is deterministic for disconnected, connected, expired, and needs-reauth states', () => {
  const { service } = buildHarness({ now: 10_000 });

  assert.equal(service.refreshHealth('supabase:hearth').status, 'DISCONNECTED');

  service.setCredential('supabase:hearth', {
    accessToken: 'a',
    refreshToken: 'r',
    email: 'hearth@example.com',
    expiresAt: 20_000,
  });
  assert.equal(service.refreshHealth('supabase:hearth').status, 'CONNECTED');

  service.setCredential('supabase:hearth', {
    accessToken: 'a',
    refreshToken: 'r',
    email: 'hearth@example.com',
    expiresAt: 9_000,
  });
  assert.equal(service.refreshHealth('supabase:hearth').status, 'EXPIRED');

  service.setCredential('supabase:hearth', {
    accessToken: 'a',
    email: 'hearth@example.com',
    expiresAt: 9_000,
  });
  assert.equal(service.refreshHealth('supabase:hearth').status, 'NEEDS_REAUTH');
});

test('public snapshots expose no auth, credentialRef, ciphertext, access token, or refresh token', () => {
  const { service } = buildHarness();
  service.setCredential('supabase:xgen', {
    accessToken: 'ACCESS_SECRET_VALUE',
    refreshToken: 'REFRESH_SECRET_VALUE',
    email: 'xgen@example.com',
    expiresAt: 20_000,
  });

  const publicConnection = service.refreshHealth('supabase:xgen');
  const serialized = JSON.stringify(publicConnection);
  assert.equal(publicConnection.account, 'xgen@example.com');
  assert.equal(Object.hasOwn(publicConnection, 'auth'), false);
  assert.ok(!serialized.includes('credential:supabase:xgen'));
  assert.ok(!serialized.includes('ACCESS_SECRET_VALUE'));
  assert.ok(!serialized.includes('REFRESH_SECRET_VALUE'));
  assert.ok(!serialized.includes('ciphertext'));
});

test('Hearth and Project X credentials stay isolated', () => {
  const { service } = buildHarness();
  service.setCredential('supabase:hearth', {
    accessToken: 'hearth-token',
    refreshToken: 'hearth-refresh',
    expiresAt: 20_000,
  });
  service.setCredential('supabase:xgen', {
    accessToken: 'xgen-token',
    refreshToken: 'xgen-refresh',
    expiresAt: 20_000,
  });

  assert.equal(service.getCredential('supabase:hearth').accessToken, 'hearth-token');
  assert.equal(service.getCredential('supabase:xgen').accessToken, 'xgen-token');

  service.clearCredential('supabase:hearth');
  assert.equal(service.getCredential('supabase:hearth'), null);
  assert.equal(service.getCredential('supabase:xgen').accessToken, 'xgen-token');
});
