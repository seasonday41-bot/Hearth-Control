import { useCallback, useEffect, useState } from 'react';
import type { ApprovalRequest } from './approval-types';
import './control-center.css';

type Page = 'Dashboard' | 'Tools' | 'Connections' | 'Activity' | 'Settings';
type Permission = 'Allow' | 'Ask' | 'Blocked';
type ActivityItem = { at: string; text: string };
const pages: Page[] = ['Dashboard', 'Tools', 'Connections', 'Activity', 'Settings'];
const permissionsList = ['Files', 'Editing', 'Terminal', 'Jobs', 'Git', 'GitHub', 'Vercel', 'LAYA'];
const activityLimit = 40;

export default function App() {
  const api = window.controlApp;
  const [page, setPage] = useState<Page>('Dashboard');
  const [settings, setSettings] = useState<ControlSettings | null>(null);
  const [server, setServer] = useState<ServerState>({ running: false, port: 3001, pid: null });
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tokenInputs, setTokenInputs] = useState<Record<string, string>>({});
  const [update, setUpdate] = useState<UpdaterInfo | null>(null);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheck | null>(null);
  const [dark, setDark] = useState(() => localStorage.getItem('control-theme') === 'dark');
  const [layaStatus, setLayaStatus] = useState('Not configured');
  const [layaConnected, setLayaConnected] = useState(false);
  const [layaAction, setLayaAction] = useState<'consult' | 'ui' | 'code' | null>(null);
  const [layaPrompt, setLayaPrompt] = useState('');
  const [layaResult, setLayaResult] = useState('');
  const [toolNames, setToolNames] = useState<string[]>([]);
  const [jobs, setJobs] = useState<Awaited<ReturnType<typeof api.getJobs>>>([]);
  const [workspaceSummary, setWorkspaceSummary] = useState<Awaited<ReturnType<typeof api.getWorkspaceSummary>> | null>(null);
  const [showFiles, setShowFiles] = useState(false);

  const note = useCallback((text: string) => setActivity((items) => [{ at: new Date().toLocaleTimeString(), text }, ...items].slice(0, activityLimit)), []);
  const refresh = useCallback(async () => {
    const [nextSettings, nextServer, nextConnections, nextUpdate, names, recentJobs, laya, summary] = await Promise.all([
      api.getSettings(), api.getServerState(), api.connectionsList(), api.updaterGetInfo(), api.getToolNames(), api.getJobs(), api.getLayaStatus(), api.getWorkspaceSummary(),
    ]);
    setSettings(nextSettings);
    setServer(nextServer);
    setConnections(nextConnections.filter((connection) => connection.provider === 'github' || connection.provider === 'vercel'));
    setUpdate(nextUpdate);
    setToolNames(names);
    setJobs(recentJobs);
    setWorkspaceSummary(summary);
    setLayaConnected(laya.connected);
    setLayaStatus(laya.connected ? `${laya.provider || 'Local'} · Connected` : laya.available ? 'Offline' : 'Not configured');
  }, [api]);
  useEffect(() => {
    void refresh().catch((cause) => setError(String(cause)));
    return api.onServerEvent((event) => {
      if (event.type === 'state' && event.state && typeof event.state === 'object' && 'running' in event.state) setServer(event.state as ServerState);
      if (event.type === 'approval' && event.requestId && event.permission && event.action) setApproval({ requestId: event.requestId, permission: event.permission, action: event.action });
      if (event.type === 'approval:resolved') setApproval((current) => current?.requestId === event.requestId ? null : current);
      if (event.type === 'log') note(`${event.source}: ${event.message}`);
    });
  }, [api, note, refresh]);
  useEffect(() => { const timer = setInterval(() => { void api.getJobs().then(setJobs).catch(() => {}); void api.getServerState().then(setServer).catch(() => {}); }, 5000); return () => clearInterval(timer); }, [api]);
  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; localStorage.setItem('control-theme', dark ? 'dark' : 'light'); }, [dark]);

  const execute = async (action: () => Promise<unknown>, label: string) => {
    setBusy(true); setError('');
    try { await action(); note(label); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const savePermission = (name: string, value: Permission) => {
    if (!settings) return;
    const effective = name === 'Editing' ? 'Files' : name === 'Jobs' ? 'Terminal' : name === 'GitHub' ? 'Git' : name;
    void execute(() => api.saveSettings({ permissions: { ...settings.permissions, [effective]: value } }), `${name} access set to ${value}`);
  };
  const changeWorkspace = () => void execute(async () => { const selected = await api.chooseWorkspace(); if (selected) note('Workspace changed'); }, 'Workspace selection closed');
  const toggleServer = () => void execute(() => server.running ? api.stopServer() : api.startServer({ workspace: settings?.workspace || '', port: settings?.port || 3001 }), server.running ? 'MCP server stopped' : 'MCP server started');
  const submitLaya = () => void execute(async () => {
    const result = layaAction === 'consult' ? await api.layaConsult(layaPrompt) : await api.layaReview({ objective: layaPrompt, focus: layaAction || 'code' });
    setLayaResult(JSON.stringify(result, null, 2).slice(0, 12000));
  }, `LAYA ${layaAction || 'consult'} completed`);
  const connected = connections.filter((item) => item.status === 'CONNECTED').length;
  const projectName = settings?.workspace?.split(/[\\/]/).filter(Boolean).pop() || 'No workspace';
  const featureAccess = (name: string): Permission => {
    const key = name === 'Editing' ? 'Files' : name === 'Jobs' ? 'Terminal' : name === 'GitHub' ? 'Git' : name;
    return settings?.permissions?.[key] || 'Blocked';
  };
  const connect = (item: ConnectionSummary) => void execute(async () => {
    const token = tokenInputs[item.alias]?.trim();
    if (!token) throw new Error('Enter a token for this connection.');
    if (item.alias === 'github:personal' || item.alias === 'github:work') await api.githubConnect({ alias: item.alias, token, allowPullRequestCreate: false });
    else if (item.alias === 'vercel:main') await api.vercelConnect({ alias: item.alias, token });
    setTokenInputs((previous) => ({ ...previous, [item.alias]: '' }));
  }, `${item.label} connected`);
  const disconnect = (item: ConnectionSummary) => void execute(() => item.alias === 'github:personal' || item.alias === 'github:work' ? api.githubDisconnect(item.alias) : item.alias === 'vercel:main' ? api.vercelDisconnect(item.alias) : Promise.reject(new Error('Unsupported connection')), `${item.label} disconnected`);

  return <div className="hearth-shell">
    <aside className="hearth-sidebar" aria-label="Main navigation">
      <div className="hearth-brand"><span className="hearth-mark" aria-hidden="true">H</span><span><strong>Hearth Control</strong><small>MCP Control Center</small></span></div>
      <nav>{pages.map((destination) => <button key={destination} type="button" className={page === destination ? 'selected' : ''} aria-current={page === destination ? 'page' : undefined} onClick={() => setPage(destination)}>{destination}</button>)}</nav>
      <div className="sidebar-foot">Local workspace tools</div>
    </aside>
    <main className="hearth-main">
      <header className="hearth-header"><div><p className="eyebrow">HEARTH CONTROL</p><h1>{page}</h1><p className="subtitle">{page === 'Dashboard' ? 'Your local MCP control center' : page === 'Tools' ? 'Access to workspace and connected tools' : page === 'Connections' ? 'Accounts used by Hearth' : page === 'Activity' ? 'Recent local events and jobs' : 'Workspace and application preferences'}</p></div><div className="header-controls"><span className="server-state">MCP {server.running ? 'Running' : 'Offline'}</span><button type="button" className="icon-button" aria-label={dark ? 'Use light appearance' : 'Use dark appearance'} onClick={() => setDark((value) => !value)}>{dark ? 'Light' : 'Dark'}</button></div></header>
      {error && <div className="notice error" role="alert">{error}<button type="button" onClick={() => setError('')}>Dismiss</button></div>}
      {approval && <div className="notice" role="alertdialog" aria-label="Permission request"><strong>{approval.permission} access requested</strong><span>{approval.action}</span><button type="button" onClick={() => { void api.respondToApproval({ requestId: approval.requestId, allowed: false }); setApproval(null); }}>Deny</button><button type="button" onClick={() => { void api.respondToApproval({ requestId: approval.requestId, allowed: true }); setApproval(null); }}>Allow once</button></div>}
      {page === 'Dashboard' && <>
        <div className="summary-row"><div><span>Workspace</span><strong title={settings?.workspace}>{projectName}</strong></div><div><span>Tools</span><strong>{toolNames.length} available</strong></div><div><span>Connections</span><strong>{connected} connected</strong></div><div><span>Jobs</span><strong>{jobs.filter((job) => job.status === 'running').length} running</strong></div></div>
        <div className="dashboard-grid"><section className="panel"><div className="section-head"><h2>Workspace</h2><button type="button" onClick={changeWorkspace}>Change</button></div><strong>{projectName}</strong><p className="path">{settings?.workspace || 'Choose a folder to start working.'}</p><p className="git-summary">{workspaceSummary?.branch ? `Branch ${workspaceSummary.branch} · ${workspaceSummary.dirty ? 'Changes pending' : 'Clean'}` : 'Git status unavailable'}</p><div className="action-row"><button type="button" onClick={changeWorkspace}>Change workspace</button><button type="button" onClick={() => void execute(async () => { setWorkspaceSummary(await api.getWorkspaceSummary()); }, 'Git status read')}>Git status</button></div></section>
        <section className="panel"><div className="section-head"><h2>Connections</h2><button type="button" onClick={() => setPage('Connections')}>Manage</button></div>{connections.map((item) => <div className="compact-row" key={item.alias}><span>{item.label}</span><strong>{item.status === 'CONNECTED' ? item.account || 'Connected' : 'Disconnected'}</strong></div>)}<div className="compact-row"><span>LAYA</span><strong>{layaStatus}</strong></div></section>
        <section className="panel"><div className="section-head"><h2>Tool access</h2><button type="button" onClick={() => setPage('Tools')}>View all</button></div>{permissionsList.slice(0, 5).map((name) => <div className="compact-row" key={name}><span>{name}</span><strong>{featureAccess(name)}</strong></div>)}</section>
        <section className="panel"><div className="section-head"><h2>Recent activity</h2><button type="button" onClick={() => setPage('Activity')}>View activity</button></div>{activity.length ? activity.slice(0, 4).map((item, i) => <div className="compact-row" key={`${item.at}-${i}`}><span>{item.text}</span><time>{item.at}</time></div>) : <p className="quiet">No activity in this session.</p>}</section></div>
        <section className="quick-actions"><h2>Quick actions</h2><button type="button" disabled={busy} onClick={toggleServer}>{server.running ? 'Stop MCP' : 'Start MCP'}</button><button type="button" onClick={() => void execute(async () => { setWorkspaceSummary(await api.getWorkspaceSummary()); setShowFiles(true); setPage('Tools'); }, 'Workspace files listed')}>List files</button><button type="button" onClick={() => setPage('Activity')}>Recent jobs</button></section>
      </>}
      {page === 'Tools' && <section className="panel full"><div className="section-head"><h2>Tool permissions</h2><span className="quiet">Allow, Ask, or Blocked</span></div>{permissionsList.map((name) => <div className="permission-row" key={name}><div><strong>{name}</strong><small>{name === 'Editing' ? 'Uses Files permission' : name === 'Jobs' ? 'Uses Terminal permission' : name === 'GitHub' ? 'Uses Git permission' : name === 'LAYA' ? 'Optional advice only' : 'Workspace scoped access'}</small></div><select aria-label={`${name} permission`} value={featureAccess(name)} disabled={busy} onChange={(event) => savePermission(name, event.target.value as Permission)}><option>Allow</option><option>Ask</option><option>Blocked</option></select></div>)}{showFiles && <div className="files-list"><h2>Workspace files</h2>{workspaceSummary?.files.map((entry) => <div className="compact-row" key={entry.name}><span>{entry.name}</span><span>{entry.directory ? 'Folder' : 'File'}</span></div>)}</div>}</section>}
      {page === 'Connections' && <div className="dashboard-grid"><section className="panel full"><div className="section-head"><h2>Connected services</h2><button type="button" disabled={busy} onClick={() => void execute(() => api.connectionsRefresh(), 'Connections refreshed')}>Refresh</button></div>{connections.map((item) => <div className="connection-row" key={item.alias}><div><strong>{item.label}</strong><small>{item.alias} · {item.status === 'CONNECTED' ? item.account || 'Connected' : 'Disconnected'}</small></div>{item.status === 'CONNECTED' ? <button type="button" disabled={busy} onClick={() => disconnect(item)}>Disconnect</button> : <div className="connect-form"><input aria-label={`${item.label} token`} type="password" autoComplete="off" placeholder="Access token" value={tokenInputs[item.alias] || ''} onChange={(event) => setTokenInputs((inputs) => ({ ...inputs, [item.alias]: event.target.value }))}/><button type="button" disabled={busy} onClick={() => connect(item)}>Connect</button></div>}</div>)}</section><section className="panel full"><div className="section-head"><h2>LAYA</h2><strong>{layaStatus}</strong></div><p>Optional consult and review specialist. Its advice does not change files.</p><div className="action-row"><button type="button" disabled={!layaConnected || busy} onClick={() => { setLayaAction('consult'); setLayaResult(''); }}>Consult LAYA</button><button type="button" disabled={!layaConnected || busy} onClick={() => { setLayaAction('ui'); setLayaResult(''); }}>Review UI</button><button type="button" disabled={!layaConnected || busy} onClick={() => { setLayaAction('code'); setLayaResult(''); }}>Review code</button></div>{layaAction && <div className="laya-form"><label htmlFor="laya-prompt">{layaAction === 'consult' ? 'Consultation' : 'Review objective and summary'}</label><textarea id="laya-prompt" value={layaPrompt} maxLength={4000} onChange={(event) => setLayaPrompt(event.target.value)} /><div className="action-row"><button type="button" disabled={busy || !layaPrompt.trim()} onClick={submitLaya}>Send to LAYA</button><button type="button" onClick={() => setLayaAction(null)}>Close</button></div></div>}{layaResult && <pre className="laya-result">{layaResult}</pre>}</section></div>}
      {page === 'Activity' && <div className="dashboard-grid"><section className="panel full"><h2>Activity</h2>{activity.length ? activity.map((item, i) => <div className="compact-row" key={`${item.at}-${i}`}><span>{item.text}</span><time>{item.at}</time></div>) : <p className="quiet">No activity in this session.</p>}</section><section className="panel full"><h2>Jobs</h2>{jobs.length ? jobs.map((job) => <div className="job-row" key={job.job_id}><div className="compact-row"><span>{job.command} · {job.status}</span><span>{job.duration === null ? 'In progress' : `${(job.duration / 1000).toFixed(1)}s`} · {job.exit_code === null ? 'No exit code' : `Exit ${job.exit_code}`}</span></div>{job.output_preview && <pre className="job-preview">{job.output_preview}</pre>}</div>) : <p className="quiet">No jobs recorded by the running MCP server.</p>}</section></div>}
      {page === 'Settings' && <div className="dashboard-grid"><section className="panel"><h2>MCP server</h2><p>{server.running ? `Running on 127.0.0.1:${server.port}` : 'Offline'}</p><button type="button" disabled={busy || !settings?.workspace} onClick={toggleServer}>{server.running ? 'Stop server' : 'Start server'}</button></section><section className="panel"><h2>Workspace</h2><p className="path">{settings?.workspace || 'Not selected'}</p><button type="button" disabled={busy} onClick={changeWorkspace}>Choose folder</button></section><section className="panel full"><h2>Updates</h2><p>Installed version: {update?.currentVersion || 'Unknown'}</p><div className="action-row"><button type="button" disabled={busy} onClick={() => void execute(async () => setUpdateCheck(await api.updaterCheck()), 'Update check completed')}>Check for updates</button>{updateCheck?.state === 'update_available' && <button type="button" disabled={busy} onClick={() => void execute(async () => setUpdateCheck(await api.updaterPrepare()), 'Update prepared')}>Prepare update</button>}{updateCheck?.state === 'update_ready' && <button type="button" disabled={busy} onClick={() => void execute(() => api.updaterInstall(), 'Install requested')}>Install update</button>}</div>{updateCheck && <p className="quiet">{updateCheck.state}</p>}</section></div>}
    </main>
  </div>;
}
