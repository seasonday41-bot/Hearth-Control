const API_ORIGIN = 'https://api.github.com';
const API_VERSION = '2026-03-10';
const ACCEPT = 'application/vnd.github+json';
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

const clampString = (value, max = 500) => String(value || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);

class GitHubApiError extends Error {
  constructor(code, message, { status = null, retryable = false, rateLimit = null } = {}) {
    super(clampString(message || code));
    this.name = 'GitHubApiError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.rateLimit = rateLimit;
  }
}

const safeMessage = (value, fallback) => {
  const text = clampString(value || fallback, 500)
    .replace(/Bearer\s+[A-Za-z0-9_\-.]+/gi, 'Bearer [REDACTED]')
    .replace(/(?:token|authorization|secret|password)\s*[:=]\s*\S+/gi, '[REDACTED]');
  return text || fallback;
};

const classifyStatus = (status) => {
  if (status === 401) return { code: 'github_unauthorized', retryable: false };
  if (status === 403) return { code: 'github_forbidden', retryable: false };
  if (status === 404) return { code: 'github_not_found', retryable: false };
  if (status === 409) return { code: 'github_conflict', retryable: false };
  if (status === 422) return { code: 'github_validation_failed', retryable: false };
  if (status === 429) return { code: 'github_rate_limited', retryable: true };
  if (status >= 500) return { code: 'github_server_error', retryable: true };
  return { code: 'github_request_failed', retryable: false };
};

const validateSegment = (value, name) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(value)) {
    throw new GitHubApiError('github_input_invalid', `${name} is invalid`);
  }
  return value;
};

const validateToken = (token) => {
  if (typeof token !== 'string') throw new GitHubApiError('github_token_invalid', 'GitHub token is required');
  const trimmed = token.trim();
  if (
    trimmed.length < 20 ||
    trimmed.length > 512 ||
    /\s/.test(trimmed) ||
    !trimmed.startsWith('github_pat_')
  ) {
    throw new GitHubApiError('github_token_invalid', 'GitHub fine-grained personal access token is invalid');
  }
  return trimmed;
};

const asRateLimit = (headers) => {
  if (!headers?.get) return null;
  const remaining = headers.get('x-ratelimit-remaining');
  const reset = headers.get('x-ratelimit-reset');
  if (remaining == null && reset == null) return null;
  return {
    remaining: remaining == null ? null : Number(remaining),
    resetAt: reset == null ? null : Number(reset) * 1000,
  };
};

const publicRepository = (repo) => ({
  id: repo?.id ?? null,
  name: typeof repo?.name === 'string' ? repo.name : null,
  fullName: typeof repo?.full_name === 'string' ? repo.full_name : null,
  private: repo?.private === true,
  visibility: typeof repo?.visibility === 'string' ? repo.visibility : null,
  archived: repo?.archived === true,
  disabled: repo?.disabled === true,
  defaultBranch: typeof repo?.default_branch === 'string' ? repo.default_branch : null,
  htmlUrl: typeof repo?.html_url === 'string' ? repo.html_url : null,
  description: typeof repo?.description === 'string' ? repo.description.slice(0, 2000) : null,
  owner: typeof repo?.owner?.login === 'string' ? repo.owner.login : null,
  permissions: repo?.permissions && typeof repo.permissions === 'object'
    ? {
        admin: repo.permissions.admin === true,
        maintain: repo.permissions.maintain === true,
        push: repo.permissions.push === true,
        triage: repo.permissions.triage === true,
        pull: repo.permissions.pull === true,
      }
    : null,
});

const publicPullRequest = (pr) => ({
  number: Number.isInteger(pr?.number) ? pr.number : null,
  title: typeof pr?.title === 'string' ? pr.title.slice(0, 2000) : null,
  state: typeof pr?.state === 'string' ? pr.state : null,
  draft: pr?.draft === true,
  htmlUrl: typeof pr?.html_url === 'string' ? pr.html_url : null,
  user: typeof pr?.user?.login === 'string' ? pr.user.login : null,
  head: typeof pr?.head?.ref === 'string' ? pr.head.ref : null,
  base: typeof pr?.base?.ref === 'string' ? pr.base.ref : null,
  createdAt: typeof pr?.created_at === 'string' ? pr.created_at : null,
  updatedAt: typeof pr?.updated_at === 'string' ? pr.updated_at : null,
});

class GitHubClient {
  constructor({
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('github_fetch_required');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
  }

  async request({ token, method = 'GET', path, query = null, body = undefined } = {}) {
    const authToken = validateToken(token);
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
      throw new GitHubApiError('github_path_invalid', 'GitHub API path must be repository-relative to api.github.com');
    }

    const url = new URL(path, API_ORIGIN);
    if (url.origin !== API_ORIGIN) throw new GitHubApiError('github_origin_invalid', 'GitHub API origin is invalid');

    if (query && typeof query === 'object') {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue;
        url.searchParams.set(key, String(value));
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = {
        Accept: ACCEPT,
        Authorization: `Bearer ${authToken}`,
        'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': 'Hearth-Control',
      };
      let requestBody;
      if (body !== undefined) {
        requestBody = JSON.stringify(body);
        if (Buffer.byteLength(requestBody, 'utf8') > 128 * 1024) {
          throw new GitHubApiError('github_request_too_large', 'GitHub request body is too large');
        }
        headers['Content-Type'] = 'application/json';
      }

      let response;
      try {
        response = await this.fetchImpl(url.toString(), {
          method,
          headers,
          body: requestBody,
          signal: controller.signal,
          redirect: 'error',
        });
      } catch (error) {
        if (controller.signal.aborted || error?.name === 'AbortError') {
          throw new GitHubApiError('github_timeout', 'GitHub request timed out', { retryable: true });
        }
        throw new GitHubApiError('github_network_error', 'GitHub request failed', { retryable: true });
      }

      const contentLength = Number(response.headers?.get?.('content-length'));
      if (Number.isFinite(contentLength) && contentLength > this.maxResponseBytes) {
        throw new GitHubApiError('github_response_too_large', 'GitHub response exceeded the configured size limit', {
          status: response.status,
        });
      }

      const raw = response.status === 204 ? '' : await response.text();
      if (Buffer.byteLength(raw, 'utf8') > this.maxResponseBytes) {
        throw new GitHubApiError('github_response_too_large', 'GitHub response exceeded the configured size limit', {
          status: response.status,
        });
      }

      let data = null;
      if (raw) {
        try { data = JSON.parse(raw); }
        catch {
          if (response.ok) throw new GitHubApiError('github_response_invalid', 'GitHub returned an invalid JSON response', { status: response.status });
        }
      }

      const rateLimit = asRateLimit(response.headers);
      if (!response.ok) {
        const classified = classifyStatus(response.status);
        throw new GitHubApiError(
          classified.code,
          safeMessage(data?.message, `GitHub request failed with status ${response.status}`),
          { status: response.status, retryable: classified.retryable, rateLimit },
        );
      }

      return { data, status: response.status, rateLimit };
    } finally {
      clearTimeout(timer);
    }
  }

  async getIdentity(token) {
    const { data, rateLimit } = await this.request({ token, path: '/user' });
    if (!data || typeof data.login !== 'string' || !data.login.trim()) {
      throw new GitHubApiError('github_identity_invalid', 'GitHub identity response was incomplete');
    }
    return {
      login: data.login,
      id: data.id ?? null,
      accountType: typeof data.type === 'string' ? data.type : null,
      htmlUrl: typeof data.html_url === 'string' ? data.html_url : null,
      rateLimit,
    };
  }

  async listRepositories(token, { page = 1, perPage = 30 } = {}) {
    const { data, rateLimit } = await this.request({
      token,
      path: '/user/repos',
      query: {
        visibility: 'all',
        affiliation: 'owner,collaborator,organization_member',
        sort: 'updated',
        direction: 'desc',
        per_page: Math.min(Math.max(Number(perPage) || 30, 1), 100),
        page: Math.max(Number(page) || 1, 1),
      },
    });
    if (!Array.isArray(data)) throw new GitHubApiError('github_response_invalid', 'GitHub repository list response was invalid');
    return { repositories: data.map(publicRepository), rateLimit };
  }

  async getRepository(token, { owner, repo } = {}) {
    const safeOwner = validateSegment(owner, 'owner');
    const safeRepo = validateSegment(repo, 'repo');
    const { data, rateLimit } = await this.request({
      token,
      path: `/repos/${encodeURIComponent(safeOwner)}/${encodeURIComponent(safeRepo)}`,
    });
    return { repository: publicRepository(data), rateLimit };
  }

  async listPullRequests(token, { owner, repo, state = 'open', page = 1, perPage = 30 } = {}) {
    const safeOwner = validateSegment(owner, 'owner');
    const safeRepo = validateSegment(repo, 'repo');
    if (!['open', 'closed', 'all'].includes(state)) throw new GitHubApiError('github_input_invalid', 'pull request state is invalid');
    const { data, rateLimit } = await this.request({
      token,
      path: `/repos/${encodeURIComponent(safeOwner)}/${encodeURIComponent(safeRepo)}/pulls`,
      query: {
        state,
        per_page: Math.min(Math.max(Number(perPage) || 30, 1), 100),
        page: Math.max(Number(page) || 1, 1),
      },
    });
    if (!Array.isArray(data)) throw new GitHubApiError('github_response_invalid', 'GitHub pull request list response was invalid');
    return { pullRequests: data.map(publicPullRequest), rateLimit };
  }

  async createPullRequest(token, { owner, repo, title, head, base, body = undefined, draft = false } = {}) {
    const safeOwner = validateSegment(owner, 'owner');
    const safeRepo = validateSegment(repo, 'repo');
    if (typeof title !== 'string' || !title.trim() || title.length > 256) throw new GitHubApiError('github_input_invalid', 'pull request title is invalid');
    if (typeof head !== 'string' || !head.trim() || head.length > 256) throw new GitHubApiError('github_input_invalid', 'pull request head is invalid');
    if (typeof base !== 'string' || !base.trim() || base.length > 256) throw new GitHubApiError('github_input_invalid', 'pull request base is invalid');
    if (body !== undefined && (typeof body !== 'string' || body.length > 64 * 1024)) throw new GitHubApiError('github_input_invalid', 'pull request body is invalid');

    const { data, rateLimit } = await this.request({
      token,
      method: 'POST',
      path: `/repos/${encodeURIComponent(safeOwner)}/${encodeURIComponent(safeRepo)}/pulls`,
      body: {
        title: title.trim(),
        head: head.trim(),
        base: base.trim(),
        ...(body !== undefined ? { body } : {}),
        draft: draft === true,
      },
    });
    return { pullRequest: publicPullRequest(data), rateLimit };
  }
}

module.exports = {
  API_ORIGIN,
  API_VERSION,
  ACCEPT,
  GitHubApiError,
  GitHubClient,
  validateToken,
};
