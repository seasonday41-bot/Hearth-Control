import type { Dispatch, ReactNode, SetStateAction } from 'react';
import Icon from '../Icon';
import AIConnectorPanel, { type AIConnectorItem } from '../components/AIConnectorPanel';
import GitHubConnectionCard from '../components/GitHubConnectionCard';
import { PAGE_INTRO } from '../page-intro';

type Props = {
  bridgeState: BridgeState | null;
  publicXState: PublicTasksState | null;
  connections: ConnectionSummary[];
  connectionsBusy: boolean;
  connectionsError: string;
  connectionActionBusy: string | null;
  connectionTokenInputs: Record<string, string>;
  setConnectionTokenInputs: Dispatch<SetStateAction<Record<string, string>>>;
  vercelTeamIdInput: string;
  setVercelTeamIdInput: Dispatch<SetStateAction<string>>;
  githubRepositories: Record<string, Array<{ id: number | null; name: string | null; fullName: string | null; private: boolean; archived: boolean; defaultBranch: string | null; owner: string | null }>>;
  githubRepoBusy: string | null;
  githubRepoErrors: Record<string, string>;
  githubSetupOpen: Record<string, boolean>;
  setGithubSetupOpen: Dispatch<SetStateAction<Record<string, boolean>>>;
  githubPrCreateInputs: Record<string, boolean>;
  setGithubPrCreateInputs: Dispatch<SetStateAction<Record<string, boolean>>>;
  refreshConnections: (alias?: string) => Promise<void>;
  connectManagedConnection: (connection: ConnectionSummary) => Promise<void>;
  disconnectManagedConnection: (connection: ConnectionSummary) => Promise<void>;
  loadGitHubRepositories: (alias: 'github:personal' | 'github:work', force?: boolean) => Promise<void>;
  selectGitHubRepository: (connection: ConnectionSummary, fullName: string) => Promise<void>;
  publicXAnonKey: string;
  setPublicXAnonKey: Dispatch<SetStateAction<string>>;
  publicXAuthMode: 'sign-in' | 'sign-up';
  setPublicXAuthMode: Dispatch<SetStateAction<'sign-in' | 'sign-up'>>;
  publicXEmail: string;
  setPublicXEmail: Dispatch<SetStateAction<string>>;
  publicXPassword: string;
  setPublicXPassword: Dispatch<SetStateAction<string>>;
  publicXBusy: boolean;
  handlePublicXSaveKey: () => Promise<void>;
  handlePublicXAuth: () => Promise<void>;
  handlePublicXSignOut: () => Promise<void>;
  connectorItems: AIConnectorItem[];
  setConnectorEnabled: (connectorId: AIConnectorItem['id'], enabled: boolean) => void;
};

export default function ConnectionsPage({
  bridgeState,
  publicXState,
  connections,
  connectionsBusy,
  connectionsError,
  connectionActionBusy,
  connectionTokenInputs,
  setConnectionTokenInputs,
  vercelTeamIdInput,
  setVercelTeamIdInput,
  githubRepositories,
  githubRepoBusy,
  githubRepoErrors,
  githubSetupOpen,
  setGithubSetupOpen,
  githubPrCreateInputs,
  setGithubPrCreateInputs,
  refreshConnections,
  connectManagedConnection,
  disconnectManagedConnection,
  loadGitHubRepositories,
  selectGitHubRepository,
  publicXAnonKey,
  setPublicXAnonKey,
  publicXAuthMode,
  setPublicXAuthMode,
  publicXEmail,
  setPublicXEmail,
  publicXPassword,
  setPublicXPassword,
  publicXBusy,
  handlePublicXSaveKey,
  handlePublicXAuth,
  handlePublicXSignOut,
  connectorItems,
  setConnectorEnabled,
}: Props): ReactNode {
  return (
    <div className="control-center-connections-view">
      <header className="page-header">
        <div>
          <p className="kicker">CONNECTIONS</p>
          <h1>Connections.</h1>
          <p className="intro">{PAGE_INTRO.Connections}</p>
        </div>
        <div className={`connection-pill ${(bridgeState?.connected || publicXState?.signedIn) ? 'online' : ''}`}>
          <span /> Remote · {bridgeState?.connected ? 'Bridge connected' : publicXState?.signedIn ? 'Project X connected' : 'Standing by'}
        </div>
      </header>

      <section className="soft-panel console-connections-panel" aria-labelledby="console-connections-title">
      <div className="panel-title">
        <div><p className="section-kicker">CONNECTIONS</p><h2 id="console-connections-title">Health</h2></div>
        <button type="button" className="subtle-action" disabled={connectionsBusy} onClick={() => void refreshConnections()}>
          {connectionsBusy ? 'Refreshing…' : 'Refresh all'}
        </button>
      </div>
      {connectionsError && <p className="console-error" role="alert">{connectionsError}</p>}
      <div className="console-connection-list">
        {connections.length === 0 ? (
          <div className="console-empty"><Icon name="activity" /><p>No connection metadata available</p><small>Connection credentials are never shown here.</small></div>
        ) : connections.map((connection) => (
          <article className="console-connection-row" key={connection.alias}>
            <div className="console-connection-main">
              <div>
                <strong>{connection.label}</strong>
                <code>{connection.alias}</code>
              </div>
              <span className={`console-status status-${connection.status.toLowerCase()}`}>{connection.status}</span>
            </div>
            {connection.provider === 'github' ? (
              <GitHubConnectionCard
                connection={connection}
                repositories={githubRepositories[connection.alias] || []}
                repositoryBusy={githubRepoBusy === connection.alias}
                repositoryError={githubRepoErrors[connection.alias] || ''}
                setupOpen={githubSetupOpen[connection.alias] === true}
                actionBusy={connectionActionBusy === connection.alias}
                connectionsBusy={connectionsBusy}
                tokenValue={connectionTokenInputs[connection.alias] || ''}
                allowPullRequestCreate={githubPrCreateInputs[connection.alias] === true}
                onOpenSetup={() => setGithubSetupOpen((current) => ({ ...current, [connection.alias]: true }))}
                onCloseSetup={() => setGithubSetupOpen((current) => ({ ...current, [connection.alias]: false }))}
                onTokenChange={(value) => setConnectionTokenInputs((current) => ({ ...current, [connection.alias]: value }))}
                onAllowPullRequestCreateChange={(value) => setGithubPrCreateInputs((current) => ({ ...current, [connection.alias]: value }))}
                onConnect={() => void connectManagedConnection(connection)}
                onDisconnect={() => void disconnectManagedConnection(connection)}
                onRefreshHealth={() => void refreshConnections(connection.alias)}
                onRefreshRepositories={() => void loadGitHubRepositories(connection.alias as 'github:personal' | 'github:work', true)}
                onSelectRepository={(fullName) => void selectGitHubRepository(connection, fullName)}
              />
            ) : (
              <>
            <dl className="console-facts">
              <div><dt>Provider</dt><dd>{connection.provider}</dd></div>
              <div><dt>Account</dt><dd>{connection.account || '—'}</dd></div>
              <div><dt>Last checked</dt><dd>{connection.lastCheckedAt ? new Date(connection.lastCheckedAt).toLocaleString() : 'Not checked'}</dd></div>
              <div><dt>Capabilities</dt><dd>{connection.capabilities.length ? connection.capabilities.join(', ') : 'None granted'}</dd></div>
            </dl>
            {connection.lastError && <p className="console-inline-error">Last error: {connection.lastError}</p>}
            {connection.provider === 'vercel' && (
              <div className="console-connection-management">
                {connection.status !== 'CONNECTED' && (
                  <div className="console-connect-form">
                    <label>
                      <span>Personal access token</span>
                      <input
                        type="password"
                        autoComplete="new-password"
                        spellCheck={false}
                        value={connectionTokenInputs[connection.alias] || ''}
                        onChange={(event) => setConnectionTokenInputs((current) => ({ ...current, [connection.alias]: event.target.value }))}
                        placeholder="Enter token locally"
                      />
                    </label>
                    {connection.provider === 'vercel' && (
                      <label>
                        <span>Team ID (optional)</span>
                        <input
                          type="text"
                          autoComplete="off"
                          spellCheck={false}
                          value={vercelTeamIdInput}
                          onChange={(event) => setVercelTeamIdInput(event.target.value)}
                          placeholder="team_..."
                        />
                      </label>
                    )}
                    <button
                      type="button"
                      className="subtle-action"
                      disabled={connectionActionBusy === connection.alias || !(connectionTokenInputs[connection.alias] || '').trim()}
                      onClick={() => void connectManagedConnection(connection)}
                    >
                      {connectionActionBusy === connection.alias ? 'Connecting…' : connection.status === 'DISCONNECTED' ? 'Connect' : 'Reconnect'}
                    </button>
                  </div>
                )}
                {connection.status !== 'DISCONNECTED' && (
                  <button
                    type="button"
                    className="text-action console-disconnect"
                    disabled={connectionActionBusy === connection.alias}
                    onClick={() => void disconnectManagedConnection(connection)}
                  >
                    Disconnect
                  </button>
                )}
              </div>
            )}
            {connection.provider === 'supabase' && <p className="console-boundary-note">Authentication remains in the existing Remote Bridge / Project X surfaces; P7 does not create a second Supabase login path.</p>}
            <button type="button" className="text-action" disabled={connectionsBusy || connectionActionBusy === connection.alias} onClick={() => void refreshConnections(connection.alias)}>Refresh health</button>
              </>
            )}
          </article>
        ))}
      </div>
      <p className="console-boundary-note">Renderer-safe summaries only. Stored provider targets, credentials, tokens, and ciphertext are never read back or rendered.</p>
    </section>

      <section className="remote-inbox-section control-center-connection-panel" aria-label="Project X connection">
        <div className="remote-inbox-header">
          <div>
            <p className="kicker">PROJECT X CONNECTION</p>
            <h2>Project X Remote Access</h2>
          </div>
          <div className="remote-inbox-controls">
            <div className={`connection-pill ${publicXState?.signedIn ? 'online' : ''}`}>
              <span /> Project X · {publicXState?.signedIn ? 'Connected' : publicXState?.configured ? 'Not signed in' : 'Not configured'}
            </div>
            {publicXState?.signedIn && (
              <button className="bridge-signout-btn" type="button" disabled={publicXBusy} onClick={handlePublicXSignOut}>
                Sign out
              </button>
            )}
          </div>
        </div>

        {!publicXState?.configured ? (
          <div className="bridge-auth-panel">
            <div className="bridge-auth-copy">
              <strong>Connect to Project X</strong>
              <span>Enter Project X's publishable (anon) key to enable X-routed remote tasks.</span>
            </div>
            <div className="bridge-auth-fields">
              <input
                type="text"
                value={publicXAnonKey}
                onChange={(event) => setPublicXAnonKey(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') void handlePublicXSaveKey(); }}
                placeholder="Project X publishable (anon) key"
              />
              <button type="button" disabled={publicXBusy || !publicXAnonKey.trim()} onClick={handlePublicXSaveKey}>
                {publicXBusy ? 'Saving…' : 'Save key'}
              </button>
            </div>
          </div>
        ) : !publicXState?.signedIn ? (
          <div className="bridge-auth-panel">
            <div className="bridge-auth-copy">
              <strong>Sign in to Project X</strong>
              <span>A separate Project X session. Your session is protected by macOS Keychain.</span>
            </div>
            <div className="bridge-auth-fields">
              <input
                autoComplete="email"
                type="email"
                value={publicXEmail}
                onChange={(event) => setPublicXEmail(event.target.value)}
                placeholder="Email"
              />
              <input
                autoComplete={publicXAuthMode === 'sign-in' ? 'current-password' : 'new-password'}
                type="password"
                minLength={8}
                value={publicXPassword}
                onChange={(event) => setPublicXPassword(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') void handlePublicXAuth(); }}
                placeholder="Password (8+ characters)"
              />
              <button type="button" disabled={publicXBusy || !publicXEmail.trim() || publicXPassword.length < 8} onClick={handlePublicXAuth}>
                {publicXBusy ? 'Connecting…' : publicXAuthMode === 'sign-in' ? 'Sign in' : 'Create account'}
              </button>
            </div>
            <button
              className="bridge-auth-switch"
              type="button"
              onClick={() => setPublicXAuthMode((current) => current === 'sign-in' ? 'sign-up' : 'sign-in')}
            >
              {publicXAuthMode === 'sign-in' ? 'Create a Project X account' : 'I already have an account'}
            </button>
          </div>
        ) : (
          <div className="remote-inbox-empty">
            <Icon name="radio" />
            <p>Connected to Project X</p>
            <small>{publicXState.accountEmail}. Queued Project X tasks are routed into Control Center → Tasks.</small>
          </div>
        )}


      </section>

      <AIConnectorPanel connectors={connectorItems} onToggle={setConnectorEnabled} />
    </div>
  );
}
