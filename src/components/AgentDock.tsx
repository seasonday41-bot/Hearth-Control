type AgentPermission = 'Allow' | 'Ask' | 'Blocked';

type AgentCard = {
  id: 'x' | 'antigravity';
  name: string;
  role: string;
  available: boolean;
  enabled: boolean;
  permission: AgentPermission;
  detail: string;
};

export interface AgentDockProps {
  agents: AgentCard[];
  onToggle: (id: AgentCard['id'], enabled: boolean) => void;
}

export default function AgentDock({ agents, onToggle }: AgentDockProps) {
  const enabledCount = agents.filter((agent) => agent.enabled && agent.available).length;

  return (
    <section className="agent-dock" aria-label="Execution agents">
      <div className="agent-dock-heading">
        <div>
          <span className="agent-dock-kicker">EXECUTION AGENTS</span>
          <strong>{enabledCount}/{agents.length} ready</strong>
        </div>
        <small>Controls apply to new work only. Running work is not stopped.</small>
      </div>

      <div className="agent-dock-list">
        {agents.map((agent) => {
          const state = !agent.enabled ? 'Disabled' : agent.available ? 'Connected' : 'Offline';
          return (
            <article className={`agent-chip ${agent.enabled ? 'enabled' : 'disabled'} ${agent.available ? 'available' : 'offline'}`} key={agent.id}>
              <div className="agent-chip-main">
                <span className="agent-avatar">{agent.id === 'x' ? 'X' : 'A'}</span>
                <div>
                  <div className="agent-chip-title">
                    <strong>{agent.name}</strong>
                    <span className={`agent-state state-${state.toLowerCase()}`}><i />{state}</span>
                  </div>
                  <p>{agent.role} · {agent.detail}</p>
                </div>
              </div>

              <div className="agent-chip-actions">
                <span className={`agent-permission permission-${agent.permission.toLowerCase()}`}>{agent.permission}</span>
                <button
                  type="button"
                  className={`agent-toggle ${agent.enabled ? 'on' : 'off'}`}
                  aria-pressed={agent.enabled}
                  aria-label={`${agent.enabled ? 'Disable' : 'Enable'} ${agent.name}`}
                  onClick={() => onToggle(agent.id, !agent.enabled)}
                >
                  <span />
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
