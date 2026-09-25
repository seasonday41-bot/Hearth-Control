import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerWorkspaceTools, toolNames } from '../mcp/tools.mjs';

const fixtures = [];
const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-p4-mcp-'));
  const item = { root };
  fixtures.push(item);
  return item;
};
afterEach(() => {
  for (const item of fixtures.splice(0)) {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

const fakeServer = () => {
  const tools = new Map();
  return { tools, registerTool(name, config, handler) { tools.set(name, { config, handler }); } };
};
const jsonOf = (result) => JSON.parse(result.content[0].text);

const register = ({ permissions = { Git: 'Allow' }, githubTransport, requestApproval } = {}) => {
  const item = fixture();
  const server = fakeServer();
  registerWorkspaceTools(server, {
    workspace: item.root,
    permissions,
    requestApproval,
    githubTransport,
  });
  return { item, server };
};

test('P4.4 all GitHub tools are registered and no credential-management MCP tool exists', () => {
  const { server } = register();
  for (const name of [
    'github_connections_list',
    'github_repositories_list',
    'github_repository_get',
    'github_pull_requests_list',
    'github_pull_request_create',
  ]) {
    assert.equal(server.tools.has(name), true);
    assert.equal(toolNames.includes(name), true);
  }
  for (const forbidden of [
    'github_connect',
    'github_disconnect',
    'github_get_token',
    'github_set_token',
    'github_get_credential',
    'github_set_credential',
    'github_get_secret',
  ]) {
    assert.equal(toolNames.includes(forbidden), false, `forbidden credential MCP tool registered: ${forbidden}`);
  }
});

test('P4.4 read tool forwards only the explicit requested alias', async () => {
  const calls = [];
  const { server } = register({
    githubTransport: {
      listRepositories: async (input) => {
        calls.push(input);
        return { repositories: [{ fullName: 'work/repo' }] };
      },
    },
  });

  const result = jsonOf(await server.tools.get('github_repositories_list').handler({
    connection: 'github:work',
    page: 2,
    per_page: 20,
  }));
  assert.equal(result.repositories[0].fullName, 'work/repo');
  assert.deepEqual(calls, [{ connection: 'github:work', page: 2, perPage: 20 }]);
});

test('P4.4 missing transport fails closed without using process.send directly', async () => {
  const { server } = register();
  const result = jsonOf(await server.tools.get('github_repositories_list').handler({
    connection: 'github:personal',
    page: 1,
    per_page: 30,
  }));
  assert.equal(result.reason, 'transport_unavailable');
});

test('P4.5 PR create in Git=Ask mode requires exact approval before transport', async () => {
  const approvals = [];
  let transportCalls = 0;
  const { server } = register({
    permissions: { Git: 'Ask' },
    requestApproval: async (request) => {
      approvals.push(request);
      return false;
    },
    githubTransport: {
      createPullRequest: async () => {
        transportCalls += 1;
        return { pullRequest: { number: 1 } };
      },
    },
  });

  const result = await server.tools.get('github_pull_request_create').handler({
    connection: 'github:personal',
    owner: 'alice',
    repo: 'repo',
    title: 'Feature',
    head: 'feature',
    base: 'main',
    draft: false,
  });

  assert.equal(result.isError, true);
  assert.equal(transportCalls, 0);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].permission, 'Git');
  assert.match(approvals[0].action, /github:personal/);
  assert.match(approvals[0].action, /alice\/repo/);
  assert.match(approvals[0].action, /feature -> main/);
});

test('P4.5 approved PR create invokes the transport exactly once with the requested alias', async () => {
  const calls = [];
  const { server } = register({
    permissions: { Git: 'Ask' },
    requestApproval: async () => true,
    githubTransport: {
      createPullRequest: async (input) => {
        calls.push(input);
        return { pullRequest: { number: 9, htmlUrl: 'https://github.com/alice/repo/pull/9' } };
      },
    },
  });

  const result = jsonOf(await server.tools.get('github_pull_request_create').handler({
    connection: 'github:personal',
    owner: 'alice',
    repo: 'repo',
    title: 'Feature',
    head: 'feature',
    base: 'main',
    body: 'body',
    draft: false,
  }));
  assert.equal(result.pullRequest.number, 9);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].connection, 'github:personal');
});

test('P4.4 Git=Blocked stops read requests before transport', async () => {
  let calls = 0;
  const { server } = register({
    permissions: { Git: 'Blocked' },
    githubTransport: {
      getRepository: async () => {
        calls += 1;
        return { repository: { fullName: 'a/r' } };
      },
    },
  });
  const result = await server.tools.get('github_repository_get').handler({
    connection: 'github:personal',
    owner: 'a',
    repo: 'r',
  });
  assert.equal(result.isError, true);
  assert.equal(calls, 0);
});
