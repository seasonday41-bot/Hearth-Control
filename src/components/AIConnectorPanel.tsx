type ConnectorTone = 'connected' | 'ready' | 'disabled' | 'offline' | 'unavailable';

export type AIConnectorItem = {
  id: 'x' | 'gpt' | 'codex' | 'claude';
  name: string;
  badge: string;
  role: string;
  detail: string;
  state: string;
  tone: ConnectorTone;
  enabled: boolean;
  canToggle: boolean;
  busy?: boolean;
  hint?: string;
};

export interface AIConnectorPanelProps {
  connectors: AIConnectorItem[];
  onToggle: (id: AIConnectorItem['id'], enabled: boolean) => void;
}

export default function AIConnectorPanel({ connectors, onToggle }: AIConnectorPanelProps) {
  const activeCount = connectors.filter((item) => item.enabled && ['connected', 'ready'].includes(item.tone)).length;

  return (
    <section className="soft-panel ai-connectors-panel" aria-labelledby="ai-connectors-title">
      <div className="panel-title">
        <div>
          <p className="section-kicker">AI CONNECTORS</p>
          <h2 id="ai-connectors-title">Agents & bridges</h2>
        </div>
        <span className="panel-meta">{activeCount}/{connectors.length} active</span>
      </div>

      <div className="ai-connector-list">
        {connectors.map((connector) => (
          <article className={`ai-connector-row tone-${connector.tone}`} key={connector.id}>
            <div className="ai-connector-identity">
              <span className="ai-connector-badge">{connector.badge}</span>
              <div>
                <div className="ai-connector-name-row">
                  <strong>{connector.name}</strong>
                  <span className={`ai-connector-state state-${connector.tone}`}><i />{connector.state}</span>
                </div>
                <p>{connector.role}</p>
                <small>{connector.detail}</small>
              </div>
            </div>

            <div className="ai-connector-actions">
              {connector.hint && <span className="ai-connector-hint">{connector.hint}</span>}
              <button
                type="button"
                className={`agent-toggle ${connector.enabled ? 'on' : 'off'}`}
                aria-pressed={connector.enabled}
                aria-label={connector.canToggle ? `${connector.enabled ? 'Disable' : 'Enable'} ${connector.name}` : `${connector.name} status: ${connector.state}`}
                disabled={!connector.canToggle || connector.busy}
                title={connector.canToggle ? `${connector.enabled ? 'Disable' : 'Enable'} ${connector.name} for new work` : connector.hint || 'Connector not available'}
                onClick={() => onToggle(connector.id, !connector.enabled)}
              >
                <span />
              </button>
            </div>
          </article>
        ))}
      </div>

      <p className="console-boundary-note">Connector switches affect new work only. Existing running tasks keep their current execution lifecycle.</p>
    </section>
  );
}
