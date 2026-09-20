const { GitHubApiError, validateToken } = require('./github-client.cjs');

const GITHUB_CAPABILITIES = Object.freeze([
  'repo.read',
  'repo.write',
  'pull_request.read',
  'pull_request.create',
]);

const DEFAULT_GITHUB_CAPABILITIES = Object.freeze([
  'repo.read',
  'pull_request.read',
]);

const normalizeCapabilities = (values = DEFAULT_GITHUB_CAPABILITIES) => {
  if (!Array.isArray(values)) throw new Error('github_capabilities_invalid');
  const result = [...new Set(values)];
  if (result.some((item) => !GITHUB_CAPABILITIES.includes(item))) throw new Error('github_capabilities_invalid');
  return result.sort();
};

const sanitizeError = (error) => ({
  code: typeof error?.code === 'string' ? error.code : 'github_error',
  message: typeof error?.message === 'string' ? error.message.slice(0, 500) : 'GitHub operation failed',
  status: Number.isInteger(error?.status) ? error.status : null,
  retryable: error?.retryable === true,
});

class GitHubConnectionService {
  constructor({ registry, connectionService, githubClient, now = () => new Date().toISOString() } = {}) {
    if (!registry) throw new Error('github_registry_required');
    if (!connectionService) throw new Error('github_connection_service_required');
    if (!githubClient) throw new Error('github_client_required');
    this.registry = registry;
    this.connectionService = connectionService;
    this.githubClient = githubClient;
    this.now = now;
  }

  requireConnection(alias) {
    const connection = this.registry.get(alias);
    if (!connection || connection.provider !== 'github') throw new Error('github_connection_not_found');
    return connection;
  }

  publicSnapshot(connection) {
    return {
      id: connection.id,
      alias: connection.alias,
      provider: connection.provider,
      label: connection.label,
      target: structuredClone(connection.target || {}),
      capabilities: [...(connection.capabilities || [])],
      status: connection.status,
      account: typeof connection.target?.login === 'string' ? connection.target.login : null,
      defaultRepository: typeof connection.target?.defaultRepository === 'string' ? connection.target.defaultRepository : null,
      lastCheckedAt: connection.lastCheckedAt || null,
      lastError: connection.lastError || null,
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
    };
  }

  async connect(alias, token, { capabilities = DEFAULT_GITHUB_CAPABILITIES } = {}) {
    const existing = this.requireConnection(alias);
    const authToken = validateToken(token);
    const normalizedCapabilities = normalizeCapabilities(capabilities);

    // Validate remote identity BEFORE any credential persistence.
    const identity = await this.githubClient.getIdentity(authToken);

    let credentialWritten = false;
    try {
      this.connectionService.setCredential(alias, {
        token: authToken,
        tokenType: 'fine_grained_pat',
      });
      credentialWritten = true;

      const nextTarget = {
        ...(existing.target || {}),
        host: 'github.com',
        login: identity.login,
        accountType: identity.accountType,
      };
      delete nextTarget.defaultRepository;
      const updated = this.registry.upsert({
        ...this.requireConnection(alias),
        target: nextTarget,
        capabilities: normalizedCapabilities,
        status: 'CONNECTED',
        lastCheckedAt: this.now(),
        lastError: null,
      });
      return this.publicSnapshot(updated);
    } catch (error) {
      if (credentialWritten) {
        try { this.connectionService.clearCredential(alias); } catch {}
      }
      throw error;
    }
  }

  disconnect(alias) {
    const connection = this.requireConnection(alias);
    this.connectionService.clearCredential(alias);
    const updated = this.registry.upsert({
      ...connection,
      status: 'DISCONNECTED',
      lastCheckedAt: this.now(),
      lastError: null,
    });
    return this.publicSnapshot(updated);
  }

  getStoredCredential(alias) {
    this.requireConnection(alias);
    return this.connectionService.getCredential(alias);
  }

  requireToken(alias) {
    const credential = this.getStoredCredential(alias);
    const token = credential?.token;
    if (typeof token !== 'string' || !token) {
      throw Object.assign(new Error('github_connection_disconnected'), { code: 'github_connection_disconnected' });
    }
    return token;
  }

  async refresh(alias) {
    const connection = this.requireConnection(alias);
    let token;
    try {
      token = this.requireToken(alias);
    } catch {
      const updated = this.registry.updateStatus(alias, 'DISCONNECTED', { lastError: null, checkedAt: this.now() });
      return this.publicSnapshot(updated);
    }

    try {
      const identity = await this.githubClient.getIdentity(token);
      const updated = this.registry.upsert({
        ...connection,
        target: {
          ...(connection.target || {}),
          host: 'github.com',
          login: identity.login,
          accountType: identity.accountType,
        },
        status: 'CONNECTED',
        lastCheckedAt: this.now(),
        lastError: null,
      });
      return this.publicSnapshot(updated);
    } catch (error) {
      const safe = sanitizeError(error);
      const status = error instanceof GitHubApiError && error.status === 401 ? 'NEEDS_REAUTH' : 'ERROR';
      const updated = this.registry.upsert({
        ...connection,
        status,
        lastCheckedAt: this.now(),
        lastError: safe.code,
      });
      return this.publicSnapshot(updated);
    }
  }

  async listRepositories(alias, options = {}) {
    const connection = this.requireConnection(alias);
    const token = this.requireToken(alias);
    if (!connection.capabilities.includes('repo.read')) throw Object.assign(new Error('github_capability_denied'), { code: 'github_capability_denied' });
    return this.githubClient.listRepositories(token, options);
  }

  async getRepository(alias, options = {}) {
    const connection = this.requireConnection(alias);
    const token = this.requireToken(alias);
    if (!connection.capabilities.includes('repo.read')) throw Object.assign(new Error('github_capability_denied'), { code: 'github_capability_denied' });
    return this.githubClient.getRepository(token, options);
  }

  async setDefaultRepository(alias, fullName) {
    const connection = this.requireConnection(alias);
    if (fullName === null || fullName === '') {
      const target = { ...(connection.target || {}) };
      delete target.defaultRepository;
      const updated = this.registry.upsert({ ...connection, target });
      return this.publicSnapshot(updated);
    }
    if (typeof fullName !== 'string' || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(fullName)) {
      throw new Error('github_repository_invalid');
    }
    const [owner, repo] = fullName.split('/');
    const result = await this.getRepository(alias, { owner, repo });
    if (!result?.repository?.fullName) throw new Error('github_repository_invalid');
    const updated = this.registry.upsert({
      ...connection,
      target: {
        ...(connection.target || {}),
        defaultRepository: result.repository.fullName,
      },
    });
    return this.publicSnapshot(updated);
  }

  async listPullRequests(alias, options = {}) {
    const connection = this.requireConnection(alias);
    const token = this.requireToken(alias);
    if (!connection.capabilities.includes('pull_request.read')) throw Object.assign(new Error('github_capability_denied'), { code: 'github_capability_denied' });
    return this.githubClient.listPullRequests(token, options);
  }

  async createPullRequest(alias, options = {}) {
    const connection = this.requireConnection(alias);
    const token = this.requireToken(alias);
    if (!connection.capabilities.includes('pull_request.create')) throw Object.assign(new Error('github_capability_denied'), { code: 'github_capability_denied' });
    return this.githubClient.createPullRequest(token, options);
  }
}

module.exports = {
  GITHUB_CAPABILITIES,
  DEFAULT_GITHUB_CAPABILITIES,
  GitHubConnectionService,
  normalizeCapabilities,
  sanitizeError,
};
