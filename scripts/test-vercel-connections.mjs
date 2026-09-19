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
const { VercelApiError } = require('../electron/vercel/vercel-client.cjs');
const { VercelConnectionService } = require('../electron/vercel/vercel-connection-service.cjs');

const TOKEN = 'vcp_personal_123456789012345678901234';
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`enc:${Buffer.from(value).toString('base64')}`),
  decryptString: (buffer) => Buffer.from(buffer.toString().slice(4), 'base64').toString(),
};

const harness = ({ identityFailure = null } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-p6-vercel-'));
  const registry = new ConnectionRegistry({ storagePath: path.join(dir, 'connections.json') });
  registry.load();
  registry.ensure(builtinConnectionDefinitions());
  const secureStore = new SecureCredentialStore({ storagePath: path.join(dir, 'credentials.json'), safeStorage });
  const connectionService = new ConnectionService({ registry, secureStore });
  const calls = [];
  const vercelClient = {
    async getIdentity(token) {
      calls.push({ op: 'identity', token });
      if (identityFailure) throw identityFailure;
      return { id: 'user_1', username: 'geno' };
    },
    async listProjects(token, options) {
      calls.push({ op: 'projects', token, options });
      return { projects: [{ id: 'prj_1', name: 'app' }] };
    },
    async getProject(token, options) {
      calls.push({ op: 'project', token, options });
      return { project: { id: 'prj_1', name: options.idOrName } };
    },
    async listDeployments(token, options) {
      calls.push({ op: 'deployments', token, options });
      return { deployments: [{ id: 'dpl_1' }] };
    },
    async getDeployment(token, options) {
      calls.push({ op: 'deployment', token, options });
      return { deployment: { id: options.idOrUrl } };
    },
  };
  const service = new VercelConnectionService({
    registry,
    connectionService,
    vercelClient,
    now: () => '2026-09-20T00:00:00.000Z',
  });
  return { dir, registry, secureStore, connectionService, vercelClient, service, calls };
};

test('P6.2 invalid remote identity is checked before token persistence', async () => {
  const failure = new VercelApiError('vercel_unauthorized', 'bad credentials', { status: 401 });
  const h = harness({ identityFailure: failure });
  await assert.rejects(() => h.service.connect('vercel:main', TOKEN), { code: 'vercel_unauthorized' });
  assert.equal(h.connectionService.getCredential('vercel:main'), null);
  assert.equal(h.registry.get('vercel:main').status, 'DISCONNECTED');
});

test('P6.2 successful connect stores token only encrypted and grants read-only capabilities', async () => {
  const h = harness();
  const snapshot = await h.service.connect('vercel:main', TOKEN, { teamId: 'team_abc123' });
  assert.equal(snapshot.status, 'CONNECTED');
  assert.equal(snapshot.account, 'geno');
  assert.equal(snapshot.target.teamId, 'team_abc123');
  assert.deepEqual(snapshot.capabilities, ['deployment.read', 'project.read']);

  const credential = h.connectionService.getCredential('vercel:main');
  assert.equal(credential.token, TOKEN);

  const registryRaw = fs.readFileSync(path.join(h.dir, 'connections.json'), 'utf8');
  const credentialRaw = fs.readFileSync(path.join(h.dir, 'credentials.json'), 'utf8');
  assert.ok(!registryRaw.includes(TOKEN));
  assert.ok(!credentialRaw.includes(TOKEN));
  assert.ok(registryRaw.includes('team_abc123'));
  assert.ok(!snapshot.capabilities.includes('deployment.create'));
  assert.ok(!snapshot.capabilities.includes('environment.write'));
});

test('P6.2 reconnecting without teamId clears an old team scope instead of retaining stale metadata', async () => {
  const h = harness();
  await h.service.connect('vercel:main', TOKEN, { teamId: 'team_old123' });
  assert.equal(h.registry.get('vercel:main').target.teamId, 'team_old123');
  await h.service.connect('vercel:main', TOKEN);
  assert.equal(h.registry.get('vercel:main').target.teamId, null);
});

test('P6.2 disconnect clears only the Vercel credential and status', async () => {
  const h = harness();
  await h.service.connect('vercel:main', TOKEN);
  h.connectionService.setCredential('github:personal', { token: 'github_pat_unrelated_12345678901234567890' });
  const snapshot = h.service.disconnect('vercel:main');
  assert.equal(snapshot.status, 'DISCONNECTED');
  assert.equal(h.connectionService.getCredential('vercel:main'), null);
  assert.equal(h.connectionService.getCredential('github:personal').token, 'github_pat_unrelated_12345678901234567890');
});

test('P6.2 a 401 health failure marks NEEDS_REAUTH without deleting credential', async () => {
  const h = harness();
  await h.service.connect('vercel:main', TOKEN);
  h.vercelClient.getIdentity = async () => { throw new VercelApiError('vercel_unauthorized', 'bad', { status: 401 }); };
  const snapshot = await h.service.refresh('vercel:main');
  assert.equal(snapshot.status, 'NEEDS_REAUTH');
  assert.equal(h.connectionService.getCredential('vercel:main').token, TOKEN);
});

test('P6.3 read operations use stored teamId unless an explicit teamId is provided', async () => {
  const h = harness();
  await h.service.connect('vercel:main', TOKEN, { teamId: 'team_default123' });
  await h.service.listProjects('vercel:main', { limit: 5 });
  assert.equal(h.calls.at(-1).options.teamId, 'team_default123');
  await h.service.listProjects('vercel:main', { teamId: 'team_override123', limit: 5 });
  assert.equal(h.calls.at(-1).options.teamId, 'team_override123');
});

test('P6.3 explicit alias is mandatory and no fallback connection exists', async () => {
  const h = harness();
  await h.service.connect('vercel:main', TOKEN);
  assert.throws(() => h.service.listProjects(undefined), /vercel_connection_not_found/);
  assert.throws(() => h.service.listProjects('vercel:other'), /vercel_connection_not_found/);
  assert.equal(h.calls.some((call) => call.op === 'projects'), false);
});

test('P6.3 public snapshot contains no auth/credential/token material', async () => {
  const h = harness();
  const snapshot = await h.service.connect('vercel:main', TOKEN, { teamId: 'team_abc123' });
  const serialized = JSON.stringify(snapshot);
  assert.ok(!serialized.includes(TOKEN));
  assert.ok(!serialized.includes('credential:vercel:main'));
  assert.ok(!serialized.includes('ciphertext'));
  assert.equal(Object.hasOwn(snapshot, 'auth'), false);
});

test('P6.3 project/deployment reads pass the exact stored credential only', async () => {
  const h = harness();
  await h.service.connect('vercel:main', TOKEN);
  await h.service.getProject('vercel:main', { idOrName: 'app' });
  assert.equal(h.calls.at(-1).token, TOKEN);
  await h.service.listDeployments('vercel:main', { projectId: 'prj_1' });
  assert.equal(h.calls.at(-1).token, TOKEN);
  await h.service.getDeployment('vercel:main', { idOrUrl: 'dpl_1' });
  assert.equal(h.calls.at(-1).token, TOKEN);
});
