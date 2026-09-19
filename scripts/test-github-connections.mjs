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
const { GitHubApiError } = require('../electron/github/github-client.cjs');
const {
  GitHubConnectionService,
} = require('../electron/github/github-connection-service.cjs');

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`enc:${Buffer.from(value).toString('base64')}`),
  decryptString: (buffer) => Buffer.from(buffer.toString().slice(4), 'base64').toString(),
};

const harness = ({ identities = {}, failures = {} } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-p4-github-'));
  const registry = new ConnectionRegistry({ storagePath: path.join(dir, 'connections.json'), now: () => '2026-09-19T10:00:00.000Z' });
  registry.load();
  registry.ensure(builtinConnectionDefinitions());
  const secureStore = new SecureCredentialStore({ storagePath: path.join(dir, 'credentials.json'), safeStorage });
  const connectionService = new ConnectionService({ registry, secureStore });
  const calls = [];
  const githubClient = {
    async getIdentity(token) {
      calls.push({ op: 'identity', token });
      if (failures[token]) throw failures[token];
      return identities[token] || { login: 'unknown', accountType: 'User' };
    },
    async listRepositories(token, options) {
      calls.push({ op: 'repos', token, options });
      return { repositories: [{ fullName: identities[token]?.login + '/repo' }] };
    },
    async getRepository(token, options) {
      calls.push({ op: 'repo', token, options });
      return { repository: { fullName: `${options.owner}/${options.repo}` } };
    },
    async listPullRequests(token, options) {
      calls.push({ op: 'prs', token, options });
      return { pullRequests: [{ number: 1 }] };
    },
    async createPullRequest(token, options) {
      calls.push({ op: 'create-pr', token, options });
      return { pullRequest: { number: 2, htmlUrl: 'https://github.com/a/r/pull/2' } };
    },
  };
  const service = new GitHubConnectionService({
    registry,
    connectionService,
    githubClient,
    now: () => '2026-09-19T10:30:00.000Z',
  });
  return { dir, registry, secureStore, connectionService, githubClient, service, calls };
};

const PERSONAL = 'github_pat_PERSONAL_12345678901234567890';
const WORK = 'github_pat_WORK_123456789012345678901234';

test('P4.2 invalid token is checked remotely before persistence', async () => {
  const failure = new GitHubApiError('github_unauthorized', 'Bad credentials', { status: 401 });
  const h = harness({ failures: { [PERSONAL]: failure } });

  await assert.rejects(
    () => h.service.connect('github:personal', PERSONAL),
    { code: 'github_unauthorized' },
  );
  assert.equal(h.connectionService.getCredential('github:personal'), null);
  assert.equal(h.registry.get('github:personal').status, 'DISCONNECTED');
});

test('P4.2 successful connect persists token only in secure store and public metadata only in registry', async () => {
  const h = harness({ identities: { [PERSONAL]: { login: 'alice', accountType: 'User' } } });
  const snapshot = await h.service.connect('github:personal', PERSONAL);

  assert.equal(snapshot.status, 'CONNECTED');
  assert.equal(snapshot.account, 'alice');
  assert.deepEqual(snapshot.capabilities, ['pull_request.read', 'repo.read']);
  assert.equal(h.connectionService.getCredential('github:personal').token, PERSONAL);

  const registryRaw = fs.readFileSync(path.join(h.dir, 'connections.json'), 'utf8');
  const credentialRaw = fs.readFileSync(path.join(h.dir, 'credentials.json'), 'utf8');
  assert.ok(!registryRaw.includes(PERSONAL));
  assert.ok(!credentialRaw.includes(PERSONAL));
  assert.ok(registryRaw.includes('alice'));
});

test('P4.3 personal and work stay connected simultaneously with isolated credentials and identities', async () => {
  const h = harness({
    identities: {
      [PERSONAL]: { login: 'alice', accountType: 'User' },
      [WORK]: { login: 'acme-bot', accountType: 'User' },
    },
  });

  await h.service.connect('github:personal', PERSONAL);
  await h.service.connect('github:work', WORK);

  assert.equal(h.registry.get('github:personal').status, 'CONNECTED');
  assert.equal(h.registry.get('github:work').status, 'CONNECTED');
  assert.equal(h.registry.get('github:personal').target.login, 'alice');
  assert.equal(h.registry.get('github:work').target.login, 'acme-bot');
  assert.equal(h.connectionService.getCredential('github:personal').token, PERSONAL);
  assert.equal(h.connectionService.getCredential('github:work').token, WORK);
});

test('P4.3 disconnecting one alias never affects the other', async () => {
  const h = harness({
    identities: {
      [PERSONAL]: { login: 'alice', accountType: 'User' },
      [WORK]: { login: 'work', accountType: 'User' },
    },
  });
  await h.service.connect('github:personal', PERSONAL);
  await h.service.connect('github:work', WORK);

  h.service.disconnect('github:personal');
  assert.equal(h.connectionService.getCredential('github:personal'), null);
  assert.equal(h.connectionService.getCredential('github:work').token, WORK);
  assert.equal(h.registry.get('github:personal').status, 'DISCONNECTED');
  assert.equal(h.registry.get('github:work').status, 'CONNECTED');
});

test('P4.3 a 401 on one alias marks only that alias NEEDS_REAUTH with no fallback', async () => {
  const h = harness({
    identities: {
      [PERSONAL]: { login: 'alice', accountType: 'User' },
      [WORK]: { login: 'work', accountType: 'User' },
    },
  });
  await h.service.connect('github:personal', PERSONAL);
  await h.service.connect('github:work', WORK);

  h.githubClient.getIdentity = async (token) => {
    h.calls.push({ op: 'identity-refresh', token });
    if (token === PERSONAL) throw new GitHubApiError('github_unauthorized', 'Bad credentials', { status: 401 });
    return { login: 'work', accountType: 'User' };
  };

  const personal = await h.service.refresh('github:personal');
  assert.equal(personal.status, 'NEEDS_REAUTH');
  assert.equal(h.registry.get('github:work').status, 'CONNECTED');
  assert.equal(h.calls.at(-1).token, PERSONAL);
  assert.equal(h.calls.some((call) => call.op === 'identity-refresh' && call.token === WORK), false);
});

test('P4.3 operations require an explicit valid GitHub alias and never select another connection', async () => {
  const h = harness({ identities: { [PERSONAL]: { login: 'alice', accountType: 'User' } } });
  await h.service.connect('github:personal', PERSONAL);

  await assert.rejects(() => h.service.listRepositories(undefined), /github_connection_not_found/);
  await assert.rejects(() => h.service.listRepositories('github:work'), { code: 'github_connection_disconnected' });
  assert.equal(h.calls.some((call) => call.op === 'repos'), false);
});

test('P4.3 read calls use the credential bound to the requested alias only', async () => {
  const h = harness({
    identities: {
      [PERSONAL]: { login: 'alice', accountType: 'User' },
      [WORK]: { login: 'work', accountType: 'User' },
    },
  });
  await h.service.connect('github:personal', PERSONAL);
  await h.service.connect('github:work', WORK);

  await h.service.listRepositories('github:work', { perPage: 10 });
  assert.equal(h.calls.at(-1).op, 'repos');
  assert.equal(h.calls.at(-1).token, WORK);
});

test('P4.5 PR creation is denied without the explicit pull_request.create capability', async () => {
  const h = harness({ identities: { [PERSONAL]: { login: 'alice', accountType: 'User' } } });
  await h.service.connect('github:personal', PERSONAL);

  await assert.rejects(
    () => h.service.createPullRequest('github:personal', { owner: 'a', repo: 'r', title: 'x', head: 'h', base: 'main' }),
    { code: 'github_capability_denied' },
  );
  assert.equal(h.calls.some((call) => call.op === 'create-pr'), false);
});

test('P4.5 PR creation uses the exact requested alias after local capability grant', async () => {
  const h = harness({ identities: { [PERSONAL]: { login: 'alice', accountType: 'User' } } });
  await h.service.connect('github:personal', PERSONAL, {
    capabilities: ['repo.read', 'pull_request.read', 'pull_request.create'],
  });

  const result = await h.service.createPullRequest('github:personal', {
    owner: 'a', repo: 'r', title: 'x', head: 'h', base: 'main',
  });
  assert.equal(result.pullRequest.number, 2);
  assert.equal(h.calls.at(-1).token, PERSONAL);
});
