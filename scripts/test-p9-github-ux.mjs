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
const { GitHubConnectionService } = require('../electron/github/github-connection-service.cjs');

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from('enc:' + Buffer.from(value).toString('base64')),
  decryptString: (buffer) => Buffer.from(buffer.toString().slice(4), 'base64').toString(),
};

const TOKEN = 'github_pat_P9_REPOSITORY_12345678901234567890';

const harness = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-p9-github-'));
  const registry = new ConnectionRegistry({ storagePath: path.join(dir, 'connections.json') });
  registry.load();
  registry.ensure(builtinConnectionDefinitions());
  const secureStore = new SecureCredentialStore({ storagePath: path.join(dir, 'credentials.json'), safeStorage });
  const connectionService = new ConnectionService({ registry, secureStore });
  const calls = [];
  const githubClient = {
    async getIdentity(token) {
      calls.push({ op: 'identity', token });
      return { login: 'seasonday41-bot', accountType: 'User' };
    },
    async listRepositories(token) {
      calls.push({ op: 'list', token });
      return {
        repositories: [
          { id: 1, fullName: 'seasonday41-bot/Hearth-Control', name: 'Hearth-Control', private: true, archived: false },
          { id: 2, fullName: 'seasonday41-bot/Expense-Checkpoint', name: 'Expense-Checkpoint', private: false, archived: false },
        ],
      };
    },
    async getRepository(token, options) {
      calls.push({ op: 'get', token, options });
      return { repository: { fullName: options.owner + '/' + options.repo } };
    },
  };
  const service = new GitHubConnectionService({ registry, connectionService, githubClient });
  return { dir, registry, connectionService, service, calls };
};

test('P9 GitHub UX stores only a validated default repository after one-time connect', async () => {
  const h = harness();
  const connected = await h.service.connect('github:personal', TOKEN);
  assert.equal(connected.account, 'seasonday41-bot');
  assert.equal(connected.defaultRepository, null);

  const repos = await h.service.listRepositories('github:personal');
  assert.equal(repos.repositories.length, 2);

  const updated = await h.service.setDefaultRepository('github:personal', 'seasonday41-bot/Hearth-Control');
  assert.equal(updated.defaultRepository, 'seasonday41-bot/Hearth-Control');
  assert.equal(h.registry.get('github:personal').target.defaultRepository, 'seasonday41-bot/Hearth-Control');
  assert.equal(h.connectionService.getCredential('github:personal').token, TOKEN);

  const raw = fs.readFileSync(path.join(h.dir, 'connections.json'), 'utf8');
  assert.match(raw, /seasonday41-bot\/Hearth-Control/);
  assert.doesNotMatch(raw, new RegExp(TOKEN));
  fs.rmSync(h.dir, { recursive: true, force: true });
});

test('P9 GitHub reconnect clears a stale default repository before new selection', async () => {
  const h = harness();
  await h.service.connect('github:personal', TOKEN);
  await h.service.setDefaultRepository('github:personal', 'seasonday41-bot/Hearth-Control');
  assert.equal(h.registry.get('github:personal').target.defaultRepository, 'seasonday41-bot/Hearth-Control');

  const reconnected = await h.service.connect('github:personal', TOKEN);
  assert.equal(reconnected.defaultRepository, null);
  assert.equal(h.registry.get('github:personal').target.defaultRepository, undefined);
  fs.rmSync(h.dir, { recursive: true, force: true });
});

test('P9 GitHub UX validates repository selection through the authenticated GitHub client', async () => {
  const h = harness();
  await h.service.connect('github:personal', TOKEN);
  await assert.rejects(() => h.service.setDefaultRepository('github:personal', '../bad/repo'), /github_repository_invalid/);
  assert.equal(h.registry.get('github:personal').target.defaultRepository, undefined);
  assert.equal(h.calls.some((call) => call.op === 'get'), false);
  fs.rmSync(h.dir, { recursive: true, force: true });
});

test('P9 GitHub card keeps PAT in first-connect UI and switches to repository-first connected UI', () => {
  const component = fs.readFileSync(new URL('../src/components/GitHubConnectionCard.tsx', import.meta.url), 'utf8');
  const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(component, /const connected = connection\.status === 'CONNECTED'/);
  assert.match(component, /Select repository/);
  assert.match(component, /Fine-grained PAT · first connection only/);
  assert.match(component, /type="password"/);
  assert.match(component, /Connect GitHub once/);
  assert.match(app, /connection\.provider === 'github' \? \(/);
  assert.match(app, /<GitHubConnectionCard/);
  assert.doesNotMatch(component, /connection\.target|credentialRef|accessToken|refreshToken|Authorization|Bearer/);
});

test('P9 GitHub renderer gets repo metadata only; no credential getter is exposed', () => {
  const preload = fs.readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
  const main = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  assert.match(preload, /githubRepositories: \(alias\) => ipcRenderer\.invoke\('github:repositories', alias\)/);
  assert.match(preload, /githubSetDefaultRepository/);
  assert.match(main, /ipcMain\.handle\('github:repositories'/);
  assert.match(main, /ipcMain\.handle\('github:set-default-repository'/);
  assert.doesNotMatch(preload, /github.*(?:credential|token).*get/i);
});
