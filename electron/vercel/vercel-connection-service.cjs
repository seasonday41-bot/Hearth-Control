const { VercelApiError, validateTeamId, validateToken } = require('./vercel-client.cjs');

const VERCEL_CAPABILITIES = Object.freeze([
  'project.read',
  'deployment.read',
  'deployment.create',
  'environment.read',
  'environment.write',
]);

const DEFAULT_VERCEL_CAPABILITIES = Object.freeze([
  'project.read',
  'deployment.read',
]);

const sanitizeError = (error) => ({
  code: typeof error?.code === 'string' ? error.code : 'vercel_error',
  status: Number.isInteger(error?.status) ? error.status : null,
  retryable: error?.retryable === true,
});

class VercelConnectionService {
  constructor({ registry, connectionService, vercelClient, now = () => new Date().toISOString() } = {}) {
    if (!registry) throw new Error('vercel_registry_required');
    if (!connectionService) throw new Error('vercel_connection_service_required');
    if (!vercelClient) throw new Error('vercel_client_required');
    this.registry = registry;
    this.connectionService = connectionService;
    this.vercelClient = vercelClient;
    this.now = now;
  }

  requireConnection(alias) {
    const connection = this.registry.get(alias);
    if (!connection || connection.provider !== 'vercel') throw new Error('vercel_connection_not_found');
    return connection;
  }

  publicSnapshot(connection) {
    return {
      id: connection.id,
      alias: connection.alias,
      provider: connection.provider,
      label: connection.label,
      target: {
        teamId: typeof connection.target?.teamId === 'string' ? connection.target.teamId : null,
        accountId: typeof connection.target?.accountId === 'string' ? connection.target.accountId : null,
        username: typeof connection.target?.username === 'string' ? connection.target.username : null,
      },
      capabilities: [...(connection.capabilities || [])],
      status: connection.status,
      account: typeof connection.target?.username === 'string'
        ? connection.target.username
        : (typeof connection.target?.accountId === 'string' ? connection.target.accountId : null),
      lastCheckedAt: connection.lastCheckedAt || null,
      lastError: connection.lastError || null,
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
    };
  }

  async connect(alias, token, { teamId = null } = {}) {
    const existing = this.requireConnection(alias);
    const authToken = validateToken(token);
    const resolvedTeamId = validateTeamId(teamId);

    // Remote identity must succeed before the token is persisted.
    const identity = await this.vercelClient.getIdentity(authToken);

    let credentialWritten = false;
    try {
      this.connectionService.setCredential(alias, {
        token: authToken,
        tokenType: 'vercel_personal_access_token',
      });
      credentialWritten = true;

      const updated = this.registry.upsert({
        ...this.requireConnection(alias),
        target: {
          ...(existing.target || {}),
          teamId: resolvedTeamId,
          accountId: identity.id,
          username: identity.username || null,
        },
        capabilities: [...DEFAULT_VERCEL_CAPABILITIES],
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

  requireToken(alias) {
    this.requireConnection(alias);
    const credential = this.connectionService.getCredential(alias);
    const token = credential?.token;
    if (typeof token !== 'string' || !token) {
      throw Object.assign(new Error('vercel_connection_disconnected'), { code: 'vercel_connection_disconnected' });
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
      const identity = await this.vercelClient.getIdentity(token);
      const updated = this.registry.upsert({
        ...connection,
        target: {
          ...(connection.target || {}),
          accountId: identity.id,
          username: identity.username || null,
        },
        status: 'CONNECTED',
        lastCheckedAt: this.now(),
        lastError: null,
      });
      return this.publicSnapshot(updated);
    } catch (error) {
      const safe = sanitizeError(error);
      const status = error instanceof VercelApiError && error.status === 401 ? 'NEEDS_REAUTH' : 'ERROR';
      const updated = this.registry.upsert({
        ...connection,
        status,
        lastCheckedAt: this.now(),
        lastError: safe.code,
      });
      return this.publicSnapshot(updated);
    }
  }

  requireCapability(alias, capability) {
    const connection = this.requireConnection(alias);
    const token = this.requireToken(alias);
    if (!connection.capabilities.includes(capability)) {
      throw Object.assign(new Error('vercel_capability_denied'), { code: 'vercel_capability_denied' });
    }
    return { connection, token };
  }

  listProjects(alias, options = {}) {
    const { connection, token } = this.requireCapability(alias, 'project.read');
    return this.vercelClient.listProjects(token, {
      ...options,
      teamId: options.teamId ?? connection.target?.teamId ?? null,
    });
  }

  getProject(alias, options = {}) {
    const { connection, token } = this.requireCapability(alias, 'project.read');
    return this.vercelClient.getProject(token, {
      ...options,
      teamId: options.teamId ?? connection.target?.teamId ?? null,
    });
  }

  listDeployments(alias, options = {}) {
    const { connection, token } = this.requireCapability(alias, 'deployment.read');
    return this.vercelClient.listDeployments(token, {
      ...options,
      teamId: options.teamId ?? connection.target?.teamId ?? null,
    });
  }

  getDeployment(alias, options = {}) {
    const { connection, token } = this.requireCapability(alias, 'deployment.read');
    return this.vercelClient.getDeployment(token, {
      ...options,
      teamId: options.teamId ?? connection.target?.teamId ?? null,
    });
  }
}

module.exports = {
  VERCEL_CAPABILITIES,
  DEFAULT_VERCEL_CAPABILITIES,
  VercelConnectionService,
  sanitizeError,
};
