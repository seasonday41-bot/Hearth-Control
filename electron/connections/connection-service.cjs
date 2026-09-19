class ConnectionService {
  constructor({ registry, secureStore, now = () => Date.now() } = {}) {
    if (!registry) throw new Error('connection_service_registry_required');
    if (!secureStore) throw new Error('connection_service_secure_store_required');
    this.registry = registry;
    this.secureStore = secureStore;
    this.now = now;
  }

  requireConnection(alias) {
    const connection = this.registry.get(alias);
    if (!connection) throw new Error('connection_not_found');
    return connection;
  }

  credentialRef(alias) {
    const connection = this.requireConnection(alias);
    const ref = connection.auth?.credentialRef;
    if (!ref) throw new Error('connection_credential_ref_missing');
    return ref;
  }

  getCredential(alias) {
    return this.secureStore.getSecret(this.credentialRef(alias));
  }

  setCredential(alias, value) {
    this.secureStore.setSecret(this.credentialRef(alias), value);
    this.registry.updateStatus(alias, 'CONNECTED', { lastError: null });
    return true;
  }

  clearCredential(alias) {
    const deleted = this.secureStore.deleteSecret(this.credentialRef(alias));
    this.registry.updateStatus(alias, 'DISCONNECTED', { lastError: null });
    return deleted;
  }

  markConnected(alias) {
    return this.registry.updateStatus(alias, 'CONNECTED', { lastError: null });
  }

  markError(alias, error) {
    return this.registry.updateStatus(alias, 'ERROR', {
      lastError: error?.message || String(error || 'Connection error'),
    });
  }

  inspectHealth(alias) {
    const connection = this.requireConnection(alias);
    const ref = connection.auth?.credentialRef;
    if (!ref) return { status: 'DISCONNECTED', account: null, error: null };

    try {
      if (!this.secureStore.hasSecret(ref)) {
        return { status: 'DISCONNECTED', account: null, error: null };
      }

      const secret = this.secureStore.getSecret(ref);
      const account = typeof secret?.email === 'string' ? secret.email : null;
      const expiresAt = Number(secret?.expiresAt);

      if (Number.isFinite(expiresAt) && expiresAt <= this.now()) {
        return {
          status: secret?.refreshToken ? 'EXPIRED' : 'NEEDS_REAUTH',
          account,
          error: null,
        };
      }

      return { status: 'CONNECTED', account, error: null };
    } catch (error) {
      return {
        status: 'ERROR',
        account: null,
        error: error?.message || 'Connection health inspection failed',
      };
    }
  }

  refreshHealth(alias) {
    const health = this.inspectHealth(alias);
    const updated = this.registry.updateStatus(alias, health.status, { lastError: health.error });
    return this.toPublic(updated, { account: health.account });
  }

  refreshAllHealth() {
    return this.registry.list().map((connection) => this.refreshHealth(connection.alias));
  }

  toPublic(connection, { account = undefined } = {}) {
    let resolvedAccount = account;
    if (resolvedAccount === undefined) {
      const health = this.inspectHealth(connection.alias);
      resolvedAccount = health.account;
    }
    return {
      id: connection.id,
      alias: connection.alias,
      provider: connection.provider,
      label: connection.label,
      target: structuredClone(connection.target || {}),
      capabilities: [...(connection.capabilities || [])],
      status: connection.status,
      account: resolvedAccount || null,
      lastCheckedAt: connection.lastCheckedAt || null,
      lastError: connection.lastError || null,
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
    };
  }

  listPublic() {
    return this.registry.list().map((connection) => this.toPublic(connection));
  }
}

module.exports = { ConnectionService };
