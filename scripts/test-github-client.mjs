import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  API_ORIGIN,
  API_VERSION,
  GitHubApiError,
  GitHubClient,
} = require('../electron/github/github-client.cjs');

const headers = (items = {}) => ({
  get(name) {
    const key = Object.keys(items).find((item) => item.toLowerCase() === String(name).toLowerCase());
    return key ? String(items[key]) : null;
  },
});

const response = ({ status = 200, data = {}, headers: responseHeaders = {} } = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: headers(responseHeaders),
  text: async () => data === null ? '' : JSON.stringify(data),
});

test('P4.1 uses the fixed GitHub API origin and required version/accept headers', async () => {
  const calls = [];
  const client = new GitHubClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({ data: { login: 'alice', id: 1, type: 'User', html_url: 'https://github.com/alice' } });
    },
  });

  const identity = await client.getIdentity('github_pat_12345678901234567890');
  assert.equal(identity.login, 'alice');
  assert.equal(new URL(calls[0].url).origin, API_ORIGIN);
  assert.equal(calls[0].options.headers['X-GitHub-Api-Version'], API_VERSION);
  assert.equal(calls[0].options.headers.Accept, 'application/vnd.github+json');
  assert.match(calls[0].options.headers.Authorization, /^Bearer /);
  assert.equal(calls[0].options.redirect, 'error');
});

test('P4.1 accepts fine-grained PATs only and rejects gh OAuth/classic token shapes', async () => {
  const client = new GitHubClient({ fetchImpl: async () => { throw new Error('must not fetch'); } });
  for (const token of [
    'gho_123456789012345678901234567890123456',
    'ghp_123456789012345678901234567890123456',
    'plain_123456789012345678901234567890123',
  ]) {
    await assert.rejects(() => client.getIdentity(token), { code: 'github_token_invalid' });
  }
});

test('P4.1 never accepts an arbitrary origin or protocol-relative path', async () => {
  const client = new GitHubClient({ fetchImpl: async () => { throw new Error('must not fetch'); } });
  await assert.rejects(
    () => client.request({ token: 'github_pat_12345678901234567890', path: 'https://evil.example/user' }),
    { code: 'github_path_invalid' },
  );
  await assert.rejects(
    () => client.request({ token: 'github_pat_12345678901234567890', path: '//evil.example/user' }),
    { code: 'github_path_invalid' },
  );
});

test('P4.1 sanitizes GitHub HTTP errors and never exposes bearer/token material', async () => {
  const token = 'github_pat_SUPER_SECRET_123456789012345';
  const client = new GitHubClient({
    fetchImpl: async () => response({
      status: 401,
      data: { message: `Bad credentials Authorization: Bearer ${token}` },
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '123' },
    }),
  });

  await assert.rejects(
    async () => {
      try { await client.getIdentity(token); }
      catch (error) {
        assert.equal(error.code, 'github_unauthorized');
        assert.equal(error.status, 401);
        assert.ok(!error.message.includes(token));
        assert.ok(!JSON.stringify(error.rateLimit).includes(token));
        throw error;
      }
    },
    GitHubApiError,
  );
});

test('P4.1 enforces response byte bounds', async () => {
  const client = new GitHubClient({
    maxResponseBytes: 20,
    fetchImpl: async () => response({
      data: { message: 'this response is intentionally too large' },
      headers: { 'content-length': '1000' },
    }),
  });
  await assert.rejects(
    () => client.getIdentity('github_pat_12345678901234567890'),
    { code: 'github_response_too_large' },
  );
});

test('P4.1 maps timeout/network failures to bounded errors', async () => {
  const client = new GitHubClient({
    timeoutMs: 5,
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  });
  await assert.rejects(
    () => client.getIdentity('github_pat_12345678901234567890'),
    { code: 'github_timeout', retryable: true },
  );
});

test('P4.1 repository and PR shapes are sanitized/minimal', async () => {
  const token = 'github_pat_12345678901234567890';
  const calls = [];
  const client = new GitHubClient({
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes('/pulls')) {
        return response({ data: [{
          number: 7, title: 'PR', state: 'open', draft: false, html_url: 'https://github.com/a/r/pull/7',
          user: { login: 'alice' }, head: { ref: 'feature' }, base: { ref: 'main' },
          secret_field: 'must-not-pass',
        }] });
      }
      return response({ data: [{
        id: 2, name: 'r', full_name: 'a/r', private: true, visibility: 'private',
        owner: { login: 'alice' }, default_branch: 'main', html_url: 'https://github.com/a/r',
        permissions: { pull: true, push: false, admin: false }, secret_field: 'must-not-pass',
      }] });
    },
  });

  const repos = await client.listRepositories(token);
  assert.deepEqual(repos.repositories[0].fullName, 'a/r');
  assert.equal(Object.hasOwn(repos.repositories[0], 'secret_field'), false);

  const prs = await client.listPullRequests(token, { owner: 'a', repo: 'r' });
  assert.equal(prs.pullRequests[0].number, 7);
  assert.equal(Object.hasOwn(prs.pullRequests[0], 'secret_field'), false);
  assert.equal(calls.every((url) => new URL(url).origin === API_ORIGIN), true);
});

test('P4.1 PR creation uses POST with bounded expected fields only', async () => {
  let captured = null;
  const client = new GitHubClient({
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return response({ status: 201, data: {
        number: 9, title: 'Add feature', state: 'open', draft: false,
        html_url: 'https://github.com/a/r/pull/9', user: { login: 'alice' },
        head: { ref: 'feature' }, base: { ref: 'main' },
      } });
    },
  });

  const result = await client.createPullRequest('github_pat_12345678901234567890', {
    owner: 'a', repo: 'r', title: 'Add feature', head: 'feature', base: 'main', body: 'body',
  });
  assert.equal(result.pullRequest.number, 9);
  assert.equal(captured.options.method, 'POST');
  assert.deepEqual(JSON.parse(captured.options.body), {
    title: 'Add feature', head: 'feature', base: 'main', body: 'body', draft: false,
  });
});
