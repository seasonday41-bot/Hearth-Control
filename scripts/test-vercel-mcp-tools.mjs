import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerWorkspaceTools, toolNames } from '../mcp/tools.mjs';
import { XClaimStore } from '../mcp/x/claim-store.mjs';
import { XRunStore } from '../mcp/x/run-store.mjs';

const fixtures = [];
const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-p6-mcp-'));
  const dbPath = path.join(root, 'runtime.sqlite');
  const claimStore = new XClaimStore({ storagePath: dbPath });
  const runStore = new XRunStore({ storagePath: dbPath });
  const item = { root, claimStore, runStore };
  fixtures.push(item);
  return item;
};
afterEach(() => {
  for (const item of fixtures.splice(0)) {
    item.claimStore.close();
    item.runStore.close();
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

const fakeServer = () => {
  const registered = new Map();
  return { registered, registerTool(name, config, handler) { registered.set(name, { config, handler }); } };
};
const modelAdapter = { async generate() { return { ok: true, text: JSON.stringify({ actions: [] }) }; } };
const jsonOf = (result) => JSON.parse(result.content[0].text);

const register = ({ vercelTransport, permissions = { Vercel: 'Allow' }, requestApproval } = {}) => {
  const item = fixture();
  const server = fakeServer();
  registerWorkspaceTools(server, {
    workspace: item.root,
    permissions,
    requestApproval,
    vercelTransport,
    xRuntime: {
      claimStore: item.claimStore,
      runStore: item.runStore,
      modelAdapter,
      ownerId: 'p6-test-owner',
    },
  });
  return { item, server };
};

test('P6.4 read-only Vercel tools are registered and mutation/credential tools are absent', () => {
  const { server } = register();
  for (const name of [
    'vercel_projects_list',
    'vercel_project_get',
    'vercel_deployments_list',
    'vercel_deployment_get',
  ]) {
    assert.equal(server.registered.has(name), true);
    assert.equal(toolNames.includes(name), true);
  }
  for (const forbidden of [
    'vercel_connect',
    'vercel_disconnect',
    'vercel_get_token',
    'vercel_set_token',
    'vercel_deploy',
    'vercel_deployment_create',
    'vercel_deployment_promote',
    'vercel_deployment_rollback',
    'vercel_domain_add',
    'vercel_domain_remove',
    'vercel_environment_get',
    'vercel_environment_set',
    'vercel_environment_delete',
    'vercel_project_delete',
  ]) {
    assert.equal(toolNames.includes(forbidden), false, `forbidden P6 tool registered: ${forbidden}`);
  }
});

test('P6.4 project list forwards explicit alias/team scope only', async () => {
  const calls = [];
  const { server } = register({
    vercelTransport: {
      listProjects: async (input) => {
        calls.push(input);
        return { projects: [{ id: 'prj_1', name: 'app' }] };
      },
    },
  });
  const body = jsonOf(await server.registered.get('vercel_projects_list').handler({
    connection: 'vercel:main',
    team_id: 'team_abc123',
    limit: 10,
  }));
  assert.equal(body.projects[0].id, 'prj_1');
  assert.deepEqual(calls, [{ connection: 'vercel:main', teamId: 'team_abc123', limit: 10 }]);
});

test('P6.4 deployment list/get forward bounded read metadata only', async () => {
  const calls = [];
  const { server } = register({
    vercelTransport: {
      listDeployments: async (input) => {
        calls.push({ op: 'list', input });
        return { deployments: [{ id: 'dpl_1' }] };
      },
      getDeployment: async (input) => {
        calls.push({ op: 'get', input });
        return { deployment: { id: 'dpl_1' } };
      },
    },
  });

  const list = jsonOf(await server.registered.get('vercel_deployments_list').handler({
    connection: 'vercel:main',
    project_id: 'prj_1',
    team_id: 'team_abc123',
    target: 'production',
    limit: 5,
  }));
  assert.equal(list.deployments[0].id, 'dpl_1');

  const one = jsonOf(await server.registered.get('vercel_deployment_get').handler({
    connection: 'vercel:main',
    id_or_url: 'dpl_1',
    team_id: 'team_abc123',
  }));
  assert.equal(one.deployment.id, 'dpl_1');
  assert.equal(calls[0].input.connection, 'vercel:main');
  assert.equal(calls[1].input.connection, 'vercel:main');
});

test('P6.4 Vercel=Ask requires approval before any provider transport call', async () => {
  let transportCalls = 0;
  const approvals = [];
  const { server } = register({
    permissions: { Vercel: 'Ask' },
    requestApproval: async (request) => {
      approvals.push(request);
      return false;
    },
    vercelTransport: {
      listProjects: async () => {
        transportCalls += 1;
        return { projects: [] };
      },
    },
  });
  const result = await server.registered.get('vercel_projects_list').handler({
    connection: 'vercel:main',
    limit: 20,
  });
  assert.equal(result.isError, true);
  assert.equal(transportCalls, 0);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].permission, 'Vercel');
  assert.match(approvals[0].action, /vercel:main/);
});

test('P6.4 Vercel=Blocked prevents provider reads before transport', async () => {
  let transportCalls = 0;
  const { server } = register({
    permissions: { Vercel: 'Blocked' },
    vercelTransport: {
      getProject: async () => {
        transportCalls += 1;
        return { project: { id: 'prj_1' } };
      },
    },
  });
  const result = await server.registered.get('vercel_project_get').handler({
    connection: 'vercel:main',
    id_or_name: 'app',
  });
  assert.equal(result.isError, true);
  assert.equal(transportCalls, 0);
});

test('P6.4 missing Vercel transport fails closed', async () => {
  const { server } = register();
  const body = jsonOf(await server.registered.get('vercel_project_get').handler({
    connection: 'vercel:main',
    id_or_name: 'app',
  }));
  assert.equal(body.reason, 'transport_unavailable');
});

test('P6.4 schema requires the explicit vercel:main alias', () => {
  const { server } = register();
  const schema = server.registered.get('vercel_projects_list').config.inputSchema.connection;
  assert.throws(() => schema.parse('vercel:other'));
  assert.equal(schema.parse('vercel:main'), 'vercel:main');
});
