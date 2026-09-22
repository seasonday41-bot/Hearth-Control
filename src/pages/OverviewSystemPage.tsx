import type { Dispatch, ReactNode, SetStateAction } from 'react';
import Icon, { type IconName } from '../Icon';
import StorageAudit from '../StorageAudit';
import { PAGE_INTRO } from '../page-intro';
import { SYSTEM_TABS, type NavItem, type SystemTab } from '../nav';
import type { ApprovalEvidence } from '../approval-types';

export type PermissionRow = { name: string; detail: string; value: PermissionValue; disabled?: boolean };
export type LogEntry = { time: string; source: string; tone: string; message: string };
export type DurableGoalEvidence = {
  goalId: string; goalTitle: string; checkpointId: string; timestamp: string;
  summary?: string; checks?: Record<string, unknown>; filesChanged: string[];
};

type Props = {
  activeNav: NavItem;
  navigate: (item: NavItem) => void;
  systemTab: SystemTab;
  setSystemTab: Dispatch<SetStateAction<SystemTab>>;
  running: boolean;
  busy: boolean;
  pid: number | null;
  port: number;
  setPort: Dispatch<SetStateAction<number>>;
  toggleServer: () => Promise<void>;
  permissions: PermissionRow[];
  allowed: number;
  rotatePermission: (index: number) => void;
  workspace: string;
  setWorkspace: Dispatch<SetStateAction<string>>;
  workspaceValid: boolean | null;
  chooseWorkspace: () => Promise<void>;
  flash: (message: string) => void;
  isGoalActive: boolean;
  isTaskRunning: boolean;
  executorStatus: AntigravityStatus | null;
  activeTaskId: string | null;
  taskData: AntigravityTaskData | null;
  logs: LogEntry[];
  setLogs: Dispatch<SetStateAction<LogEntry[]>>;
  approvalEvidence: ApprovalEvidence[];
  durableGoalEvidence: DurableGoalEvidence[];
  updaterInfo: UpdaterInfo | null;
  updateCheck: UpdateCheck | null;
  updateBusy: boolean;
  updateStatusText: Record<UpdateStatus, string>;
  showUpdateDetails: boolean;
  setShowUpdateDetails: Dispatch<SetStateAction<boolean>>;
  checkForUpdate: () => Promise<void>;
  prepareUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
  chooseUpdateDirectory: () => Promise<void>;
};

export default function OverviewSystemPage({
  activeNav,
  navigate,
  systemTab,
  setSystemTab,
  running,
  busy,
  pid,
  port,
  setPort,
  toggleServer,
  permissions,
  allowed,
  rotatePermission,
  workspace,
  setWorkspace,
  workspaceValid,
  chooseWorkspace,
  flash,
  isGoalActive,
  isTaskRunning,
  executorStatus,
  activeTaskId,
  taskData,
  logs,
  setLogs,
  approvalEvidence,
  durableGoalEvidence,
  updaterInfo,
  updateCheck,
  updateBusy,
  updateStatusText,
  showUpdateDetails,
  setShowUpdateDetails,
  checkForUpdate,
  prepareUpdate,
  installUpdate,
  chooseUpdateDirectory,
}: Props): ReactNode {
  return (
    <>
      <header className="page-header" id="overview">
        <div><p className="kicker">{activeNav === 'Overview' ? 'YOUR LOCAL CONTROL CENTER' : 'SYSTEM'}</p><h1>{activeNav === 'Overview' ? 'A clear view of your work.' : 'System.'}</h1><p className="intro">{PAGE_INTRO[activeNav]}</p></div>
        <div className={`connection-pill ${running ? 'online' : ''}`}><span /> MCP Server · {running ? 'Running' : 'Offline'}</div>
      </header>

      {activeNav === 'System' && (
        <div className="control-center-tabs" role="tablist" aria-label="System sections">
          {SYSTEM_TABS.map((tab: SystemTab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={systemTab === tab}
              className={systemTab === tab ? 'active' : ''}
              onClick={() => setSystemTab(tab)}
            >
              <Icon name={tab === 'Workspace' ? 'folder' : tab === 'Permissions' ? 'lock' : tab === 'Activity' ? 'terminal' : tab === 'Storage' ? 'folder' : 'server'} />
              <span>{tab}</span>
            </button>
          ))}
        </div>
      )}

      {activeNav === 'Overview' && <><section className={`power-console ${running ? 'is-running' : ''}`} aria-labelledby="server-title">
        <div className="console-copy"><div className="console-icon"><Icon name="server" /><span className="pulse-ring" /></div><div><p className="section-kicker">SERVER STATUS</p><h2 id="server-title">{running ? 'MCP server is active' : 'MCP server is standing by'}</h2><p>{running ? `Streamable HTTP listening on 127.0.0.1:${port}.` : 'Start the server to expose Hearth MCP tools locally.'}</p></div></div>
        <div className="server-action"><label className="port-readout"><span>PORT</span><input aria-label="Server port" inputMode="numeric" disabled={running || busy} value={port} onChange={(event) => setPort(Number(event.target.value.replace(/\D/g, '').slice(0, 5)) || 3001)} onBlur={() => void window.controlApp.saveSettings({ port })} /></label><button className={`power-button ${running ? 'stop' : ''}`} disabled={busy} onClick={toggleServer}><span className="power-symbol" />{busy ? 'Working…' : running ? 'Stop Server' : 'Start Server'}</button></div>
      </section>

      <section className="metrics" aria-label="System overview">
        <article><div className="metric-icon sage"><Icon name="activity" /></div><div><span>Connection</span><strong>{busy ? 'Changing' : running ? 'Healthy' : 'Idle'}</strong><small>{running ? `Process ${pid ?? 'active'} · local` : 'No active process'}</small></div></article>
        <article><div className="metric-icon sand"><Icon name="lock" /></div><div><span>Permissions</span><strong>{allowed} allowed</strong><small>{permissions.length - allowed} require attention</small></div></article>
        <article><div className="metric-icon blue"><Icon name="folder" /></div><div><span>Workspace</span><strong>{workspaceValid === null ? 'Checking…' : workspaceValid ? 'Connected' : 'Not found'}</strong><small>{workspaceValid ? 'Local filesystem' : workspace ? 'Path not accessible' : 'No workspace configured'}</small></div></article>
        <article><div className="metric-icon purple"><Icon name="console" /></div><div><span>Executor</span><strong>{executorStatus?.available ? 'Connected' : 'Unavailable'}</strong><small>{isTaskRunning ? `Task running (${taskData?.status})` : activeTaskId ? 'Task ready' : 'Standing by'}</small></div></article>
      </section>

      <section className="calm-shortcuts" aria-label="Workspace shortcuts">
        {([{ page: 'Goals', title: 'Goals', detail: 'What you asked for, and how far it has got', icon: 'flag' }, { page: 'Connections', title: 'Connections', detail: 'Agents and services this workspace can reach', icon: 'console' }, { page: 'System', title: 'System', detail: 'Workspace, permissions, activity, and updates', icon: 'lock' }] as Array<{page: NavItem; title: string; detail: string; icon: IconName}>).map(item => <button type="button" key={item.page} onClick={() => navigate(item.page)}><Icon name={item.icon}/><strong>{item.title}</strong><span>{item.detail}</span><Icon name="chevron"/></button>)}
      </section></>}

      <div className="dashboard-grid calm-system-page">
        {activeNav === 'System' && systemTab === 'Workspace' && <section className="soft-panel workspace-panel" id="workspace">
          <div className="panel-title"><div><p className="section-kicker">WORKSPACE</p><h2>Working directory</h2></div><button className="round-button" aria-label="Copy workspace path" onClick={async () => { await navigator.clipboard.writeText(workspace); flash('Workspace path copied'); }}><Icon name="copy" /></button></div>
          <div className="folder-well"><div className="folder-tab" /><div className="folder-icon"><Icon name="folder" /></div><label htmlFor="workspace-path">Current folder</label><input id="workspace-path" value={workspace} onChange={(event) => setWorkspace(event.target.value)} onBlur={() => void window.controlApp.saveSettings({ workspace })} disabled={isTaskRunning || isGoalActive} /><button onClick={chooseWorkspace} disabled={isTaskRunning || isGoalActive}>Choose folder <Icon name="chevron" /></button></div>
          <p className="panel-note">{isGoalActive ? <span style={{ color: '#8a724f' }}>🔒 Workspace is locked while a goal is active.</span> : <><span /> Changes are restricted to this directory.</>}</p>
        </section>

        }
        {activeNav === 'System' && systemTab === 'Permissions' && <section className="soft-panel permission-panel" id="permissions">
          <div className="panel-title"><div><p className="section-kicker">PERMISSIONS</p><h2>Tool access</h2></div><span className="panel-meta">Click to change</span></div>
          <div className="permission-list">{permissions.map((permission, index) => <button className={`permission-row${permission.disabled ? ' disabled' : ''}`} onClick={() => rotatePermission(index)} key={permission.name} disabled={permission.disabled} aria-disabled={permission.disabled}><span className="permission-copy"><strong>{permission.name}</strong><small>{permission.detail}</small></span><em className={`permission-value value-${permission.value.toLowerCase()}`}><i />{permission.value}{!permission.disabled && <Icon name="chevron" />}</em></button>)}</div>
        </section>

        }
        {activeNav === 'System' && systemTab === 'Updates' && <section className="soft-panel update-panel" aria-labelledby="updates-title">
          <div className="panel-title">
            <div><p className="section-kicker">UPDATE</p><h2 id="updates-title">Hearth updates</h2></div>
            <span className={`update-status ${updateCheck?.state ?? 'idle'}`}>
              {updateCheck?.state === 'downloading'
                ? <span className="update-status-flow" aria-hidden="true" />
                : <i aria-hidden="true" />}
              <span>{updateStatusText[updateCheck?.state ?? 'idle']}</span>
            </span>
          </div>
          <dl className="update-facts">
            <div><dt>Current version</dt><dd>v{updaterInfo?.currentVersion ?? '—'}</dd></div>
            <div><dt>Current build</dt><dd title={updaterInfo?.currentBuildId}>{updaterInfo?.currentBuildId ?? '—'}</dd></div>
            <div><dt>Build time</dt><dd>{updaterInfo?.builtAt ? new Date(updaterInfo.builtAt).toLocaleString() : 'Development build'}</dd></div>
            {updateCheck?.state === 'up_to_date' && updateCheck.latestRelease && <div><dt>Latest release</dt><dd title={updateCheck.latestRelease.buildId}>v{updateCheck.latestRelease.version} · {updateCheck.latestRelease.buildId}</dd></div>}
            {updateCheck?.available && <div><dt>New build</dt><dd>v{updateCheck.available.version} · {updateCheck.available.buildId}</dd></div>}
          </dl>
          {updateCheck?.error && <p className="update-error">{updateCheck.error}</p>}
          <div className="update-actions">
            <button type="button" className="subtle-action" disabled={updateBusy} onClick={checkForUpdate}>{updateBusy && updateCheck?.state === 'checking' ? 'Checking…' : 'Check for Update'}</button>
            {updateCheck?.state === 'update_available' && <button type="button" className="update-install" disabled={updateBusy} onClick={prepareUpdate}>Download / Prepare</button>}
            <button type="button" className="update-install" disabled={updateBusy || updateCheck?.state !== 'update_ready'} onClick={installUpdate}>{updateCheck?.state === 'installing' ? 'Installing…' : 'Install Update'}</button>
            <button type="button" className="text-action" onClick={() => setShowUpdateDetails((visible) => !visible)}>{showUpdateDetails ? 'Hide Details' : 'View Details'}</button>
          </div>
          {showUpdateDetails && <div className="update-details">
            <p>Remote updates are checked from the built-in Hearth GitHub Releases trust configuration and must pass signature, download, and staging verification before Install is enabled.</p>
            <p><strong>Manual trusted folder</strong><code>{updaterInfo?.updateDirectory ?? '—'}</code></p>
            <button type="button" className="text-action" disabled={updateBusy} onClick={chooseUpdateDirectory}>Choose manual update folder</button>
          </div>}
        </section>

        }
        {activeNav === 'System' && systemTab === 'Activity' && <section className="soft-panel logs-panel" id="logs">
          <div className="panel-title"><div><p className="section-kicker">ACTIVITY</p><h2>System log</h2></div><div className="log-actions"><span className="live-indicator"><i /> LIVE</span><button onClick={() => setLogs([])}>Clear log</button></div></div>
          <div className="log-well" aria-live="polite">{logs.length === 0 ? <div className="empty-state"><Icon name="terminal" /><p>No activity recorded</p><small>New system events will appear here.</small></div> : logs.map((log, index) => <div className={`log-line ${log.tone}`} key={`${log.time}-${index}`}><time>{log.time}</time><span className="log-source">{log.source}</span><p>{log.message}</p></div>)}</div>
        </section>
        }
        {activeNav === 'System' && systemTab === 'Activity' && <section className="soft-panel console-evidence-panel" aria-labelledby="console-evidence-title">
        <div className="panel-title">
          <div><p className="section-kicker">EVIDENCE</p><h2 id="console-evidence-title">Operational evidence</h2></div>
          <span className="panel-meta">Read only</span>
        </div>
        <div className="console-evidence-grid">
          <div>
            <h3>Current session</h3>
            <p className="console-evidence-caption">System logs and approval lifecycle events are retained only for this open app session.</p>
            <div className="console-evidence-list">
              {[...approvalEvidence].reverse().slice(0, 6).map((item) => (
                <article key={item.requestId}>
                  <time>{item.time}</time>
                  <strong>{item.permission} · {item.state}</strong>
                  <p>{item.action}</p>
                </article>
              ))}
              {[...logs].reverse().slice(0, 6).map((log, index) => (
                <article key={`${log.time}-${log.source}-${index}`}>
                  <time>{log.time}</time>
                  <strong>{log.source}</strong>
                  <p>{log.message}</p>
                </article>
              ))}
              {approvalEvidence.length === 0 && logs.length === 0 && <div className="console-empty compact"><p>No session evidence yet</p></div>}
            </div>
          </div>
          <div>
            <h3>Durable Goal checkpoints</h3>
            <p className="console-evidence-caption">These summaries come from Goal Runner checkpoint evidence already persisted by Hearth.</p>
            <div className="console-evidence-list">
              {durableGoalEvidence.map((item) => (
                <article key={item.checkpointId}>
                  <time>{new Date(item.timestamp).toLocaleString()}</time>
                  <strong>{item.goalTitle}</strong>
                  <p>{item.summary || 'Checkpoint recorded'}</p>
                  <small>{item.filesChanged.length ? `${item.filesChanged.length} file(s) changed` : 'No changed files recorded'} · {Object.keys(item.checks || {}).length} check(s)</small>
                </article>
              ))}
              {durableGoalEvidence.length === 0 && <div className="console-empty compact"><p>No durable Goal checkpoints yet</p></div>}
            </div>
          </div>
        </div>
      </section>
        }
        {activeNav === 'System' && systemTab === 'Storage' && <StorageAudit />}
      </div>
    </>
  );
}
