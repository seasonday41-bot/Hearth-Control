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
const {
  SupabaseProjectService,
  SupabaseProviderError,
  validatePublishableKey,
} = require('../electron/supabase/supabase-project-service.cjs');

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`enc:${Buffer.from(value).toString('base64')}`),
  decryptString: (buffer) => Buffer.from(buffer.toString().slice(4), 'base64').toString(),
};

const HKEY = 'sb_publishable_hearth_12345678901234567890';
const XKEY = 'sb_publishable_xgen_1234567890123456789012';

const response = ({ status = 200, data = {}, headers = {} } = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
  text: async () => data === null ? '' : JSON.stringify(data),
});

const harness = ({ fetchImpl } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-p5-supabase-'));
  const registry = new ConnectionRegistry({ storagePath: path.join(dir, 'connections.json') });
  registry.load();
  registry.ensure(builtinConnectionDefinitions({
    supabaseUrl: 'https://hearthref.supabase.co',
    supabaseAnonKey: HKEY,
    publicTasksSupabaseUrl: 'https://xgenref.supabase.co',
    publicTasksSupabaseAnonKey: XKEY,
  }));
  const secureStore = new SecureCredentialStore({ storagePath: path.join(dir, 'credentials.json'), safeStorage });
  const connectionService = new ConnectionService({ registry, secureStore });
  const calls = [];
  const service = new SupabaseProjectService({
    registry,
    connectionService,
    fetchImpl: fetchImpl || (async (url, options) => {
      calls.push({ url, options });
      return response({ data: { id: 'user-1', email: 'owner@example.com' } });
    }),
  });
  return { dir, registry, secureStore, connectionService, service, calls };
};

test('P5.1 resolves both projects by explicit alias with isolated URLs/keys', () => {
  const h = harness();
  const hearth = h.service.getProjectConfig('supabase:hearth');
  const xgen = h.service.getProjectConfig('supabase:xgen');
  assert.equal(hearth.url, 'https://hearthref.supabase.co');
  assert.equal(hearth.publishableKey, HKEY);
  assert.equal(xgen.url, 'https://xgenref.supabase.co');
  assert.equal(xgen.publishableKey, XKEY);
  assert.notEqual(hearth.publishableKey, xgen.publishableKey);
});

test('P5.1 rejects secret/service-role keys while accepting publishable keys', () => {
  assert.equal(validatePublishableKey(HKEY), HKEY);
  assert.throws(() => validatePublishableKey('sb_secret_super_secret_value_123456789'), { code: 'supabase_secret_key_forbidden' });
  const payload = Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url');
  assert.throws(() => validatePublishableKey(`eyJhbGciOiJIUzI1NiJ9.${payload}.signature`), { code: 'supabase_secret_key_forbidden' });
});

test('P5.2 auth request uses only the requested alias project origin/key', async () => {
  const h = harness({
    fetchImpl: async (url, options) => {
      h?.calls?.push?.({ url, options });
      return response({ data: { access_token: 'a', refresh_token: 'r', user: { id: 'u' } } });
    },
  });
  // Replace with deterministic recorder because the closure above is created before h exists.
  const calls = [];
  h.service.fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return response({ data: { access_token: 'a', refresh_token: 'r', user: { id: 'u' } } });
  };
  await h.service.signIn('supabase:xgen', 'u@example.com', 'password123');
  assert.equal(new URL(calls[0].url).origin, 'https://xgenref.supabase.co');
  assert.equal(calls[0].options.headers.apikey, XKEY);
  assert.notEqual(calls[0].options.headers.apikey, HKEY);
});

test('P5.2 health 401 affects one alias only and never falls back', async () => {
  const h = harness();
  h.connectionService.setCredential('supabase:hearth', { accessToken: 'hearth-token', email: 'h@example.com' });
  h.connectionService.setCredential('supabase:xgen', { accessToken: 'xgen-token', email: 'x@example.com' });

  h.service.fetchImpl = async (url, options) => {
    if (new URL(url).origin === 'https://hearthref.supabase.co') {
      return response({ status: 401, data: { message: 'invalid jwt' } });
    }
    return response({ data: { id: 'x', email: 'x@example.com' } });
  };

  const hearth = await h.service.refreshHealth('supabase:hearth');
  assert.equal(hearth.status, 'NEEDS_REAUTH');
  assert.equal(h.registry.get('supabase:xgen').status, 'CONNECTED');
  assert.equal(h.connectionService.getCredential('supabase:xgen').accessToken, 'xgen-token');
});

test('P5.2 public snapshot hides the publishable key value but reports configured state', () => {
  const h = harness();
  const snapshot = h.service.publicSnapshot('supabase:hearth');
  const serialized = JSON.stringify(snapshot);
  assert.equal(snapshot.target.publishableKeyConfigured, true);
  assert.equal(snapshot.target.projectRef, 'hearthref');
  assert.ok(!serialized.includes(HKEY));
  assert.ok(!serialized.includes('credential:supabase:hearth'));
});

test('P5.2 arbitrary/custom origins are rejected in V1', () => {
  const h = harness();
  assert.throws(
    () => h.service.updateProjectConfig('supabase:hearth', { url: 'https://evil.example', publishableKey: HKEY }),
    { code: 'supabase_project_url_invalid' },
  );
});

test('P5.3 missing alias/default fallback is rejected', async () => {
  const h = harness();
  assert.throws(() => h.service.getProjectConfig(undefined), { code: 'supabase_connection_not_found' });
  await assert.rejects(() => h.service.signIn('supabase:missing', 'a@b.com', 'password123'), { code: 'supabase_connection_not_found' });
});
