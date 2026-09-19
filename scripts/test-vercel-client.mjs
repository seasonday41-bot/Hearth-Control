import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { API_ORIGIN, VercelApiError, VercelClient } = require('../electron/vercel/vercel-client.cjs');

const headers = (items = {}) => ({
  get(name) {
    const key = Object.keys(items).find((item) => item.toLowerCase() === String(name).toLowerCase());
    return key ? String(items[key]) : null;
  },
});
const response = ({ status = 200, data = {}, responseHeaders = {} } = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: headers(responseHeaders),
  text: async () => data === null ? '' : JSON.stringify(data),
});

const TOKEN = 'vcp_personal_123456789012345678901234';

test('P6.1 uses fixed api.vercel.com authority and bearer auth only inside client', async () => {
  const calls = [];
  const client = new VercelClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({ data: { user: { id: 'user_1', username: 'geno', email: 'g@example.com' } } });
    },
  });
  const identity = await client.getIdentity(TOKEN);
  assert.equal(identity.id, 'user_1');
  assert.equal(identity.username, 'geno');
  assert.equal(new URL(calls[0].url).origin, API_ORIGIN);
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].options.redirect, 'error');
});

test('P6.1 accepts personal/legacy opaque tokens but rejects known non-personal prefixed credential types', async () => {
  const client = new VercelClient({ fetchImpl: async () => { throw new Error('must not fetch'); } });
  for (const token of [
    'vci_integration_12345678901234567890',
    'vca_app_access_12345678901234567890',
    'vcr_refresh_1234567890123456789012',
    'vck_api_key_123456789012345678901',
  ]) {
    await assert.rejects(() => client.getIdentity(token), { code: 'vercel_token_type_forbidden' });
  }
});

test('P6.1 arbitrary origins and protocol-relative paths are rejected', async () => {
  const client = new VercelClient({ fetchImpl: async () => { throw new Error('must not fetch'); } });
  await assert.rejects(() => client.request({ token: TOKEN, path: 'https://evil.example/v2/user' }), { code: 'vercel_path_invalid' });
  await assert.rejects(() => client.request({ token: TOKEN, path: '//evil.example/v2/user' }), { code: 'vercel_path_invalid' });
});

test('P6.1 sanitizes provider errors and does not expose token material', async () => {
  const client = new VercelClient({
    fetchImpl: async () => response({
      status: 401,
      data: { error: { message: `Bad Authorization: Bearer ${TOKEN}` } },
    }),
  });
  await assert.rejects(async () => {
    try { await client.getIdentity(TOKEN); }
    catch (error) {
      assert.equal(error.code, 'vercel_unauthorized');
      assert.ok(!error.message.includes(TOKEN));
      throw error;
    }
  }, VercelApiError);
});

test('P6.1 response size and timeout are bounded', async () => {
  const large = new VercelClient({
    maxResponseBytes: 10,
    fetchImpl: async () => response({ data: { message: 'too large' }, responseHeaders: { 'content-length': '1000' } }),
  });
  await assert.rejects(() => large.getIdentity(TOKEN), { code: 'vercel_response_too_large' });

  const slow = new VercelClient({
    timeoutMs: 5,
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  });
  await assert.rejects(() => slow.getIdentity(TOKEN), { code: 'vercel_timeout' });
});

test('P6.1 list/get projects apply explicit teamId and return bounded public shapes', async () => {
  const calls = [];
  const client = new VercelClient({
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes('/v9/projects/proj_1')) {
        return response({ data: { id: 'proj_1', name: 'app', framework: 'vite', secret: 'nope' } });
      }
      return response({ data: {
        projects: [{ id: 'proj_1', name: 'app', framework: 'vite', latestDeployments: [], secret: 'nope' }],
        pagination: { next: 123, count: 1 },
      } });
    },
  });
  const listed = await client.listProjects(TOKEN, { teamId: 'team_abc123', limit: 5 });
  assert.equal(listed.projects[0].id, 'proj_1');
  assert.equal(Object.hasOwn(listed.projects[0], 'secret'), false);
  assert.equal(new URL(calls[0]).searchParams.get('teamId'), 'team_abc123');

  const one = await client.getProject(TOKEN, { idOrName: 'proj_1', teamId: 'team_abc123' });
  assert.equal(one.project.name, 'app');
});

test('P6.1 deployment reads use v6 list and v13 get endpoints with sanitized shapes', async () => {
  const calls = [];
  const client = new VercelClient({
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes('/v13/deployments/')) {
        return response({ data: { uid: 'dpl_1', url: 'app.vercel.app', readyState: 'READY', target: 'production', secret: 'nope' } });
      }
      return response({ data: {
        deployments: [{ uid: 'dpl_1', url: 'app.vercel.app', state: 'READY', target: 'production', projectId: 'prj_1', secret: 'nope' }],
        pagination: { next: 1, count: 1 },
      } });
    },
  });

  const listed = await client.listDeployments(TOKEN, { projectId: 'prj_1', teamId: 'team_abc123', target: 'production' });
  assert.equal(listed.deployments[0].id, 'dpl_1');
  assert.equal(Object.hasOwn(listed.deployments[0], 'secret'), false);
  assert.match(calls[0], /\/v6\/deployments/);

  const one = await client.getDeployment(TOKEN, { idOrUrl: 'dpl_1', teamId: 'team_abc123' });
  assert.equal(one.deployment.state, 'READY');
  assert.match(calls[1], /\/v13\/deployments\/dpl_1/);
});
