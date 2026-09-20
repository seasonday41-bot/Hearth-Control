type GitHubRepoOption = {
  id: number | null;
  fullName: string | null;
  private: boolean;
  archived: boolean;
};

type GitHubConnectionView = {
  alias: string;
  label: string;
  status: string;
  account: string | null;
  defaultRepository?: string | null;
  capabilities: string[];
  lastCheckedAt: string | null;
  lastError: string | null;
};

type Props = {
  connection: GitHubConnectionView;
  repositories: GitHubRepoOption[];
  repositoryBusy: boolean;
  repositoryError: string;
  setupOpen: boolean;
  actionBusy: boolean;
  connectionsBusy: boolean;
  tokenValue: string;
  allowPullRequestCreate: boolean;
  onOpenSetup: () => void;
  onCloseSetup: () => void;
  onTokenChange: (value: string) => void;
  onAllowPullRequestCreateChange: (value: boolean) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onRefreshHealth: () => void;
  onRefreshRepositories: () => void;
  onSelectRepository: (fullName: string) => void;
};

export default function GitHubConnectionCard({
  connection,
  repositories,
  repositoryBusy,
  repositoryError,
  setupOpen,
  actionBusy,
  connectionsBusy,
  tokenValue,
  allowPullRequestCreate,
  onOpenSetup,
  onCloseSetup,
  onTokenChange,
  onAllowPullRequestCreateChange,
  onConnect,
  onDisconnect,
  onRefreshHealth,
  onRefreshRepositories,
  onSelectRepository,
}: Props) {
  const connected = connection.status === 'CONNECTED';
  const selected = connection.defaultRepository || '';
  const selectedMissing = selected && !repositories.some((repo) => repo.fullName === selected);

  return (
    <div className="github-connection-simple">
      {connected ? (
        <>
          <div className="github-connection-grid">
            <div className="github-account-block">
              <span>Account</span>
              <strong>{connection.account || '—'}</strong>
              <small>{connection.lastCheckedAt ? 'Checked ' + new Date(connection.lastCheckedAt).toLocaleString() : 'Connected'}</small>
            </div>

            <label className="github-repository-field">
              <span>Repository</span>
              <select
                value={selected}
                disabled={repositoryBusy}
                onChange={(event) => onSelectRepository(event.target.value)}
              >
                <option value="">{repositoryBusy ? 'Loading repositories…' : 'Select repository…'}</option>
                {selectedMissing && <option value={selected}>{selected}</option>}
                {repositories.map((repo) => (
                  <option key={String(repo.id ?? repo.fullName)} value={repo.fullName || ''}>
                    {(repo.fullName || 'Unnamed repository') + (repo.private ? ' · private' : '') + (repo.archived ? ' · archived' : '')}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="github-access-block">
            <span>Access</span>
            <div className="github-access-list">
              <span className={connection.capabilities.includes('repo.read') ? 'granted' : 'missing'}><i /> Read repository</span>
              <span className={connection.capabilities.includes('pull_request.read') ? 'granted' : 'missing'}><i /> Read pull requests</span>
              <span className={connection.capabilities.includes('pull_request.create') ? 'granted' : 'missing'}><i /> Create pull request</span>
            </div>
          </div>

          {repositoryError && <p className="console-inline-error">{repositoryError}</p>}

          <div className="github-connected-actions">
            <button type="button" className="text-action" disabled={repositoryBusy} onClick={onRefreshRepositories}>
              {repositoryBusy ? 'Loading repos…' : 'Refresh repositories'}
            </button>
            <button type="button" className="text-action" disabled={connectionsBusy || actionBusy} onClick={onRefreshHealth}>
              Refresh health
            </button>
            <button type="button" className="text-action console-disconnect" disabled={actionBusy} onClick={onDisconnect}>
              Disconnect
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="github-setup-copy">
            Connect GitHub once. Hearth stores the credential securely; after that you only choose a repository.
          </p>
          {connection.lastError && <p className="console-inline-error">Last error: {connection.lastError}</p>}

          {!setupOpen ? (
            <button type="button" className="subtle-action github-connect-start" onClick={onOpenSetup}>
              Connect GitHub
            </button>
          ) : (
            <div className="console-connect-form github-first-connect">
              <label>
                <span>Fine-grained PAT · first connection only</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                  value={tokenValue}
                  onChange={(event) => onTokenChange(event.target.value)}
                  placeholder="Paste token locally"
                />
              </label>

              <label className="console-checkbox">
                <input
                  type="checkbox"
                  checked={allowPullRequestCreate}
                  onChange={(event) => onAllowPullRequestCreateChange(event.target.checked)}
                />
                Allow pull request creation
              </label>

              <div className="github-setup-actions">
                <button type="button" className="subtle-action" disabled={actionBusy || !tokenValue.trim()} onClick={onConnect}>
                  {actionBusy ? 'Connecting…' : 'Connect'}
                </button>
                <button type="button" className="text-action" disabled={actionBusy} onClick={onCloseSetup}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
