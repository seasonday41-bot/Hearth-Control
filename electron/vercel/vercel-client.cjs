const API_ORIGIN = 'https://api.vercel.com';
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

class VercelApiError extends Error {
  constructor(code, message, { status = null, retryable = false } = {}) {
    super(String(message || code).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 500));
    this.name = 'VercelApiError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

const validateToken = (value) => {
  if (typeof value !== 'string') throw new VercelApiError('vercel_token_invalid', 'Vercel personal access token is required');
  const token = value.trim();
  if (token.length < 20 || token.length > 1024 || /\s/.test(token)) {
    throw new VercelApiError('vercel_token_invalid', 'Vercel personal access token is invalid');
  }
  if (/^(?:vci|vca|vcr|vck)(?:_|\b)/i.test(token)) {
    throw new VercelApiError('vercel_token_type_forbidden', 'P6 accepts Vercel personal access tokens only');
  }
  return token;
};

const validateTeamId = (value) => {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^team_[A-Za-z0-9_-]{3,200}$/.test(value.trim())) {
    throw new VercelApiError('vercel_team_id_invalid', 'Vercel teamId is invalid');
  }
  return value.trim();
};

const validateIdentifier = (value, name, max = 256) => {
  if (typeof value !== 'string') throw new VercelApiError('vercel_input_invalid', `${name} is invalid`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || /[\s/?#]/.test(trimmed)) {
    throw new VercelApiError('vercel_input_invalid', `${name} is invalid`);
  }
  return trimmed;
};

const sanitizeMessage = (value, fallback) =>
  String(value || fallback)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/(?:token|authorization|secret|password)\s*[:=]\s*\S+/gi, '[REDACTED]')
    .trim()
    .slice(0, 500) || fallback;

const publicProject = (project) => ({
  id: typeof project?.id === 'string' ? project.id : null,
  name: typeof project?.name === 'string' ? project.name : null,
  framework: typeof project?.framework === 'string' ? project.framework : null,
  accountId: typeof project?.accountId === 'string' ? project.accountId : null,
  createdAt: Number.isFinite(project?.createdAt) ? project.createdAt : null,
  updatedAt: Number.isFinite(project?.updatedAt) ? project.updatedAt : null,
  latestDeployments: Array.isArray(project?.latestDeployments)
    ? project.latestDeployments.slice(0, 10).map((item) => ({
        id: typeof item?.id === 'string' ? item.id : null,
        url: typeof item?.url === 'string' ? item.url : null,
        state: typeof item?.state === 'string' ? item.state : null,
        target: typeof item?.target === 'string' ? item.target : null,
        createdAt: Number.isFinite(item?.createdAt) ? item.createdAt : null,
      }))
    : [],
});

const publicDeployment = (deployment) => ({
  id: typeof deployment?.uid === 'string' ? deployment.uid : (typeof deployment?.id === 'string' ? deployment.id : null),
  name: typeof deployment?.name === 'string' ? deployment.name : null,
  url: typeof deployment?.url === 'string' ? deployment.url : null,
  state: typeof deployment?.state === 'string'
    ? deployment.state
    : (typeof deployment?.readyState === 'string' ? deployment.readyState : null),
  target: typeof deployment?.target === 'string' ? deployment.target : null,
  projectId: typeof deployment?.projectId === 'string'
    ? deployment.projectId
    : (typeof deployment?.project?.id === 'string' ? deployment.project.id : null),
  createdAt: Number.isFinite(deployment?.createdAt) ? deployment.createdAt : null,
  ready: Number.isFinite(deployment?.ready) ? deployment.ready : null,
  meta: deployment?.meta && typeof deployment.meta === 'object'
    ? {
        githubCommitRef: typeof deployment.meta.githubCommitRef === 'string' ? deployment.meta.githubCommitRef : null,
        githubCommitSha: typeof deployment.meta.githubCommitSha === 'string' ? deployment.meta.githubCommitSha : null,
      }
    : null,
});

class VercelClient {
  constructor({
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('vercel_fetch_required');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
  }

  async request({ token, path, query = null } = {}) {
    const authToken = validateToken(token);
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
      throw new VercelApiError('vercel_path_invalid', 'Vercel API path must be relative to api.vercel.com');
    }

    const url = new URL(path, API_ORIGIN);
    if (url.origin !== API_ORIGIN) throw new VercelApiError('vercel_origin_invalid', 'Vercel API origin is invalid');
    if (query && typeof query === 'object') {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue;
        url.searchParams.set(key, String(value));
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response;
      try {
        response = await this.fetchImpl(url.toString(), {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${authToken}`,
            Accept: 'application/json',
            'User-Agent': 'Hearth-Control',
          },
          signal: controller.signal,
          redirect: 'error',
        });
      } catch (error) {
        if (controller.signal.aborted || error?.name === 'AbortError') {
          throw new VercelApiError('vercel_timeout', 'Vercel request timed out', { retryable: true });
        }
        throw new VercelApiError('vercel_network_error', 'Vercel request failed', { retryable: true });
      }

      const contentLength = Number(response.headers?.get?.('content-length'));
      if (Number.isFinite(contentLength) && contentLength > this.maxResponseBytes) {
        throw new VercelApiError('vercel_response_too_large', 'Vercel response exceeded the configured size limit', { status: response.status });
      }
      const raw = response.status === 204 ? '' : await response.text();
      if (Buffer.byteLength(raw, 'utf8') > this.maxResponseBytes) {
        throw new VercelApiError('vercel_response_too_large', 'Vercel response exceeded the configured size limit', { status: response.status });
      }

      let data = {};
      if (raw) {
        try { data = JSON.parse(raw); }
        catch {
          if (response.ok) throw new VercelApiError('vercel_response_invalid', 'Vercel returned invalid JSON', { status: response.status });
        }
      }

      if (!response.ok) {
        const status = response.status;
        const code = status === 401 ? 'vercel_unauthorized'
          : status === 403 ? 'vercel_forbidden'
            : status === 404 ? 'vercel_not_found'
              : status === 429 ? 'vercel_rate_limited'
                : status >= 500 ? 'vercel_server_error'
                  : 'vercel_request_failed';
        throw new VercelApiError(
          code,
          sanitizeMessage(data?.error?.message || data?.message, `Vercel request failed with status ${status}`),
          { status, retryable: status === 429 || status >= 500 },
        );
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  async getIdentity(token) {
    const data = await this.request({ token, path: '/v2/user' });
    const user = data?.user && typeof data.user === 'object' ? data.user : data;
    if (!user || (typeof user.id !== 'string' && typeof user.uid !== 'string')) {
      throw new VercelApiError('vercel_identity_invalid', 'Vercel identity response was incomplete');
    }
    return {
      id: typeof user.id === 'string' ? user.id : user.uid,
      username: typeof user.username === 'string' ? user.username : null,
      name: typeof user.name === 'string' ? user.name : null,
      email: typeof user.email === 'string' ? user.email : null,
    };
  }

  async listTeams(token) {
    const data = await this.request({ token, path: '/v2/teams' });
    const teams = Array.isArray(data?.teams) ? data.teams : [];
    return {
      teams: teams.map((team) => ({
        id: typeof team?.id === 'string' ? team.id : null,
        slug: typeof team?.slug === 'string' ? team.slug : null,
        name: typeof team?.name === 'string' ? team.name : null,
      })),
      pagination: data?.pagination && typeof data.pagination === 'object'
        ? { next: data.pagination.next ?? null, count: data.pagination.count ?? null }
        : null,
    };
  }

  async listProjects(token, { teamId = null, limit = 20 } = {}) {
    const data = await this.request({
      token,
      path: '/v9/projects',
      query: {
        ...(validateTeamId(teamId) ? { teamId: validateTeamId(teamId) } : {}),
        limit: Math.min(Math.max(Number(limit) || 20, 1), 100),
      },
    });
    return {
      projects: Array.isArray(data?.projects) ? data.projects.map(publicProject) : [],
      pagination: data?.pagination && typeof data.pagination === 'object'
        ? { next: data.pagination.next ?? null, count: data.pagination.count ?? null }
        : null,
    };
  }

  async getProject(token, { idOrName, teamId = null } = {}) {
    const id = validateIdentifier(idOrName, 'project id/name');
    const resolvedTeamId = validateTeamId(teamId);
    const data = await this.request({
      token,
      path: `/v9/projects/${encodeURIComponent(id)}`,
      query: resolvedTeamId ? { teamId: resolvedTeamId } : null,
    });
    return { project: publicProject(data) };
  }

  async listDeployments(token, { projectId = null, teamId = null, limit = 20, target = null } = {}) {
    const resolvedTeamId = validateTeamId(teamId);
    const query = {
      ...(resolvedTeamId ? { teamId: resolvedTeamId } : {}),
      limit: Math.min(Math.max(Number(limit) || 20, 1), 100),
    };
    if (projectId) query.projectId = validateIdentifier(projectId, 'project id');
    if (target != null) {
      if (!['production', 'preview'].includes(target)) throw new VercelApiError('vercel_input_invalid', 'deployment target is invalid');
      query.target = target;
    }
    const data = await this.request({ token, path: '/v6/deployments', query });
    return {
      deployments: Array.isArray(data?.deployments) ? data.deployments.map(publicDeployment) : [],
      pagination: data?.pagination && typeof data.pagination === 'object'
        ? { next: data.pagination.next ?? null, count: data.pagination.count ?? null }
        : null,
    };
  }

  async getDeployment(token, { idOrUrl, teamId = null } = {}) {
    const id = validateIdentifier(idOrUrl, 'deployment id/url', 512);
    const resolvedTeamId = validateTeamId(teamId);
    const data = await this.request({
      token,
      path: `/v13/deployments/${encodeURIComponent(id)}`,
      query: resolvedTeamId ? { teamId: resolvedTeamId } : null,
    });
    return { deployment: publicDeployment(data) };
  }
}

module.exports = {
  API_ORIGIN,
  VercelApiError,
  VercelClient,
  validateToken,
  validateTeamId,
};
