import type { Dispatch, ReactNode, SetStateAction } from 'react';
import Icon from '../Icon';

type Props = {
  renderGoalsHeader: (status?: ReactNode) => ReactNode;
  navigate: (item: 'Connections') => void;
  workspace: string;
  chooseWorkspace: () => Promise<void>;
  isGoalActive: boolean;
  isTaskRunning: boolean;
  flash: (message: string) => void;
  taskCenterTab: 'x' | 'remote';
  setTaskCenterTab: Dispatch<SetStateAction<'x' | 'remote'>>;
  xPerm: PermissionValue;
  xReady: boolean;
  rotateXPerm: () => void;
  xPendingTasks: BridgeTask[];
  activeXStatus: XQueueStatus | null;
  liveXRuns: XRunSummary[];
  recentXRuns: XRunSummary[];
  bridgeState: BridgeState | null;
  bridgeBusy: boolean;
  toggleBridge: () => Promise<void>;
  bridgeAuthMode: 'sign-in' | 'sign-up';
  setBridgeAuthMode: Dispatch<SetStateAction<'sign-in' | 'sign-up'>>;
  bridgeEmail: string;
  setBridgeEmail: Dispatch<SetStateAction<string>>;
  bridgePassword: string;
  setBridgePassword: Dispatch<SetStateAction<string>>;
  handleBridgeAuth: () => Promise<void>;
  handleBridgeSignOut: () => Promise<void>;
  copyPairingSecret: () => Promise<void>;
  publicXState: PublicTasksState | null;
  remotePendingTasks: BridgeTask[];
  handleApproveRemoteTask: (task: BridgeTask) => Promise<void>;
  handleRejectRemoteTask: (task: BridgeTask) => Promise<void>;
  setReviewTask: Dispatch<SetStateAction<BridgeTask | null>>;
};

export default function GoalsActivityPage({
  renderGoalsHeader,
  navigate,
  workspace,
  chooseWorkspace,
  isGoalActive,
  isTaskRunning,
  flash,
  taskCenterTab,
  setTaskCenterTab,
  xPerm,
  xReady,
  rotateXPerm,
  xPendingTasks,
  activeXStatus,
  liveXRuns,
  recentXRuns,
  bridgeState,
  bridgeBusy,
  toggleBridge,
  bridgeAuthMode,
  setBridgeAuthMode,
  bridgeEmail,
  setBridgeEmail,
  bridgePassword,
  setBridgePassword,
  handleBridgeAuth,
  handleBridgeSignOut,
  copyPairingSecret,
  publicXState,
  remotePendingTasks,
  handleApproveRemoteTask,
  handleRejectRemoteTask,
  setReviewTask,
}: Props): ReactNode {
  return (
    <div className="task-console-view">
      {renderGoalsHeader(
        taskCenterTab === 'x' ? (
          <div className={'connection-pill ' + (xReady ? 'online' : '')}>
            <span /> X · {xPerm === 'Blocked' ? 'Blocked' : xReady ? 'Ready' : 'Unavailable'}
          </div>
        ) : (
          <div className={'connection-pill ' + (bridgeState?.connected ? 'online' : '')}>
            <span /> Remote · {bridgeState?.connected ? 'Bridge connected' : 'Standing by'}
          </div>
        )
      )}

      <div className="task-workspace-bar">
        <div className="task-workspace-info">
          <Icon name="folder" />
          <span>Workspace</span>
          <code>{workspace || 'No workspace selected'}</code>
        </div>
        <button
          className="task-workspace-change"
          disabled={isTaskRunning || isGoalActive}
          onClick={chooseWorkspace}
          title={isGoalActive ? 'Cannot switch workspace while a goal is active' : isTaskRunning ? 'Cannot switch workspace while task is running' : 'Choose different folder'}
        >
          Change folder
        </button>
      </div>

      <section className="soft-panel console-x-panel" aria-labelledby="console-x-title">
                      <div className="panel-title">
                        <div><p className="section-kicker">X RUNTIME</p><h2 id="console-x-title">Live & recent runs</h2></div>
                        <span className="panel-meta">{liveXRuns.length ? `${liveXRuns.length} active` : 'Idle'}</span>
                      </div>
                      {recentXRuns.length === 0 ? (
                        <div className="console-empty"><Icon name="terminal" /><p>No X runs recorded</p><small>Direct and queued X work appears here automatically.</small></div>
                      ) : (
                        <div className="console-x-run-list">
                          {recentXRuns.slice(0, 8).map((run) => {
                            const detail = run.error || run.result?.blockers?.[0]?.detail || run.result?.reason_code || run.hearthOutcome || 'No additional detail';
                            return (
                              <article key={run.runId} className="console-x-run-row">
                                <div className="console-x-run-main">
                                  <div>
                                    <strong>{run.taskId}</strong>
                                    <code>{run.runId}</code>
                                  </div>
                                  <span className={'task-status-pill ' + run.status}>{run.status}</span>
                                </div>
                                <p>{detail}</p>
                                <small>{new Date(run.updatedAt).toLocaleString()} · {run.gateStatus || 'No gate result yet'}</small>
                              </article>
                            );
                          })}
                        </div>
                      )}
                      <p className="console-boundary-note">Read-only projection from XRunStore. Hearth never starts, retries, approves, or cancels X work from this list.</p>
                    </section>

      <div className="task-center-tabs" role="tablist" aria-label="Task execution surfaces">
        <button type="button" role="tab" aria-selected={taskCenterTab === 'x'} className={taskCenterTab === 'x' ? 'active' : ''} onClick={() => setTaskCenterTab('x')}>
          <span>X</span>
          {xPendingTasks.length > 0 && <em>{xPendingTasks.length}</em>}
        </button>
        <button type="button" role="tab" aria-selected={taskCenterTab === 'remote'} className={taskCenterTab === 'remote' ? 'active' : ''} onClick={() => setTaskCenterTab('remote')}>
          <span>Remote</span>
          {remotePendingTasks.length > 0 && <em>{remotePendingTasks.length}</em>}
        </button>
      </div>

      {taskCenterTab === 'x' && (
        <section className="x-task-surface" aria-labelledby="x-task-heading">
          <div className="x-task-overview">
            <div>
              <p className="kicker">LOCAL CODER</p>
              <h2 id="x-task-heading">X Tasks</h2>
              <p>Review Project X requests here, then dispatch them through Hearth's existing X approval and queue path.</p>
            </div>
            <button className="task-perm-button" type="button" onClick={rotateXPerm} title="Cycle X permission: Allow / Ask / Blocked">
              <i style={{ background: xPerm === 'Allow' ? 'var(--sage)' : xPerm === 'Blocked' ? 'var(--rose)' : '#9a7545' }} />
              <span>Permission: <strong>{xPerm}</strong></span>
              <Icon name="chevron" />
            </button>
          </div>

          <div className={'x-permission-note ' + (xPerm === 'Blocked' ? 'blocked' : xPerm === 'Ask' ? 'ask' : 'allow')}>
            <strong>{xPerm === 'Ask' ? 'Approval required' : xPerm === 'Allow' ? 'Automatic X admission enabled' : 'X is blocked'}</strong>
            <span>{xPerm === 'Ask' ? 'After you press Approve & Run, Hearth will show the existing “Allow X access?” dialog before queue admission.' : xPerm === 'Allow' ? 'Approved requests enter X without a second permission dialog. Switch to Ask if you want to press Allow once for every request.' : 'Change X permission before approving new work.'}</span>
          </div>

          {activeXStatus && (
            <div className="x-run-card">
              <div className="x-run-card-header">
                <div>
                  <p className="section-kicker">CURRENT X RUN</p>
                  <strong>{activeXStatus.task_id || activeXStatus.request_id || 'X task'}</strong>
                </div>
                <span className={'task-status-pill ' + (activeXStatus.terminal_status || activeXStatus.queue_status || 'pending')}>
                  {activeXStatus.terminal_status || activeXStatus.queue_status || 'pending'}
                </span>
              </div>
              <dl className="x-run-meta">
                <div><dt>Request</dt><dd>{activeXStatus.request_id || '—'}</dd></div>
                <div><dt>Queue</dt><dd>{activeXStatus.queue_id || '—'}</dd></div>
                <div><dt>Run</dt><dd>{activeXStatus.run_id || 'Waiting for dispatch'}</dd></div>
                <div><dt>Gate</dt><dd>{activeXStatus.gate_status || '—'}</dd></div>
              </dl>
              {activeXStatus.error && <div className="task-error-box"><div className="task-error-message"><strong>X Error:</strong> {activeXStatus.error}</div></div>}
              {activeXStatus.result && (
                <div className="x-run-result">
                  <strong>{activeXStatus.result.gate_status || activeXStatus.terminal_status || 'Result'}</strong>
                  <span>{Array.isArray(activeXStatus.result.files_changed) ? activeXStatus.result.files_changed.length : 0} file(s) changed · {Array.isArray(activeXStatus.result.validation) ? activeXStatus.result.validation.filter((item: any) => item.status === 'passed').length : 0} validation check(s) passed</span>
                </div>
              )}
            </div>
          )}

          <div className="x-runs-section">
            <div className="remote-inbox-header x-inbox-header">
              <div>
                <p className="kicker">X RUNTIME</p>
                <h2>Current & recent X runs</h2>
              </div>
              <span className="panel-meta">{liveXRuns.length ? `${liveXRuns.length} active` : 'Idle'}</span>
            </div>
            {recentXRuns.length === 0 ? (
              <div className="remote-inbox-empty compact">
                <Icon name="terminal" />
                <p>No X runs recorded</p>
                <small>Direct X work and approved Project X requests will appear here.</small>
              </div>
            ) : (
              <div className="x-run-list">
                {recentXRuns.slice(0, 6).map((run) => {
                  const detail = run.error || run.result?.blockers?.[0]?.detail || run.result?.reason_code || run.hearthOutcome || 'No additional detail';
                  return (
                    <article className="x-run-row" key={run.runId}>
                      <div className="x-run-row-head">
                        <div><strong>{run.taskId}</strong><code>{run.runId}</code></div>
                        <span className={'task-status-pill ' + run.status}>{run.status}</span>
                      </div>
                      <p>{detail}</p>
                      <small>{new Date(run.updatedAt).toLocaleString()} · {run.gateStatus || 'No gate result yet'}</small>
                    </article>
                  );
                })}
              </div>
            )}
          </div>

          <div className="remote-inbox-header x-inbox-header">
            <div>
              <p className="kicker">PROJECT X</p>
              <h2>Pending X Requests</h2>
            </div>
            <div className={'connection-pill ' + (publicXState?.signedIn ? 'online' : '')}>
              <span /> Project X · {publicXState?.signedIn ? 'Connected' : 'Not connected'}
            </div>
          </div>

          {!publicXState?.signedIn ? (
            <div className="remote-inbox-empty">
              <Icon name="radio" />
              <p>Project X is not connected</p>
              <small>Open Connections and sign in to receive X requests for local review.</small>
            </div>
          ) : xPendingTasks.length === 0 ? (
            <div className="remote-inbox-empty">
              <Icon name="console" />
              <p>No pending X requests</p>
              <small>New Project X coding requests will appear here before they are admitted to the X queue.</small>
            </div>
          ) : (
            <div className="remote-tasks-list">
              {xPendingTasks.map((t) => (
                <div key={t.id} className="remote-task-card x-request-card">
                  <div className="remote-task-main">
                    <div className="remote-task-meta">
                      <span className="remote-source-tag">X</span>
                      <strong className="remote-task-title">{t.title || 'X Task'}</strong>
                      <span className="remote-task-time">{new Date(t.createdAt).toLocaleTimeString()}</span>
                    </div>
                    <p className="remote-task-preview">{t.prompt.slice(0, 180)}{t.prompt.length > 180 ? '…' : ''}</p>
                  </div>
                  <div className="remote-task-actions">
                    <button className="remote-action-btn review" type="button" onClick={() => setReviewTask(t)}>Review</button>
                    <button className="remote-action-btn reject" type="button" disabled={bridgeBusy} onClick={() => handleRejectRemoteTask(t)}>Reject</button>
                    <button className="remote-action-btn approve" type="button" disabled={bridgeBusy || xPerm === 'Blocked' || !xReady} onClick={() => handleApproveRemoteTask(t)} title={xPerm === 'Ask' ? 'Approve request, then confirm X access in the one-time approval dialog' : 'Approve and dispatch to X'}>
                      {xPerm === 'Ask' ? 'Approve & Request Access' : 'Approve & Run'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* REMOTE INBOX SECTION */}
      {taskCenterTab === 'remote' && (
      <section className="remote-inbox-section" aria-labelledby="remote-inbox-heading">
        <div className="remote-inbox-header">
          <div>
            <p className="kicker">TASK QUEUE</p>
            <h2 id="remote-inbox-heading">Remote Inbox</h2>
          </div>
          <div className="remote-inbox-controls">
            <div className={`connection-pill ${bridgeState?.enabled ? (bridgeState?.connected ? 'online' : 'sand') : ''}`}>
              <span /> Bridge · {bridgeState?.enabled ? (bridgeState?.connected ? 'Connected' : 'Disconnected') : 'Disabled'}
            </div>
            {bridgeState?.deviceId && (
              <button
                className="device-id-chip"
                type="button"
                title="Click to copy full device UUID"
                onClick={async () => {
                  await navigator.clipboard.writeText(bridgeState.deviceId);
                  flash('Device ID copied to clipboard');
                }}
              >
                <Icon name="copy" />
                <span>Device: <code>{bridgeState.deviceId.slice(0, 8)}…</code></span>
              </button>
            )}
            {bridgeState?.signedIn && (
              <>
                <button className="device-id-chip" type="button" onClick={copyPairingSecret}>
                  <Icon name="copy" />
                  <span>Copy pairing secret</span>
                </button>
                <button className="bridge-signout-btn" type="button" disabled={bridgeBusy} onClick={handleBridgeSignOut}>
                  Sign out
                </button>
              </>
            )}
            <button
              className={`bridge-toggle-btn ${bridgeState?.enabled ? 'enabled' : 'disabled'}`}
              type="button"
              disabled={bridgeBusy || !bridgeState?.signedIn}
              onClick={toggleBridge}
            >
              <span>Remote Bridge: <strong>{bridgeState?.enabled ? 'Enabled' : 'Disabled'}</strong></span>
            </button>
          </div>
        </div>

        {!bridgeState?.signedIn ? (
          <div className="bridge-auth-panel">
            <div className="bridge-auth-copy">
              <strong>Connect this Mac</strong>
              <span>Sign in with a dedicated Hearth account. Your session is protected by macOS Keychain.</span>
            </div>
            <div className="bridge-auth-fields">
              <input
                autoComplete="email"
                type="email"
                value={bridgeEmail}
                onChange={(event) => setBridgeEmail(event.target.value)}
                placeholder="Email"
              />
              <input
                autoComplete={bridgeAuthMode === 'sign-in' ? 'current-password' : 'new-password'}
                type="password"
                minLength={8}
                value={bridgePassword}
                onChange={(event) => setBridgePassword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void handleBridgeAuth();
                }}
                placeholder="Password (8+ characters)"
              />
              <button type="button" disabled={bridgeBusy || !bridgeEmail.trim() || bridgePassword.length < 8} onClick={handleBridgeAuth}>
                {bridgeBusy ? 'Connecting…' : bridgeAuthMode === 'sign-in' ? 'Sign in' : 'Create account'}
              </button>
            </div>
            <button
              className="bridge-auth-switch"
              type="button"
              onClick={() => setBridgeAuthMode((current) => current === 'sign-in' ? 'sign-up' : 'sign-in')}
            >
              {bridgeAuthMode === 'sign-in' ? 'Create a Hearth account' : 'I already have an account'}
            </button>
          </div>
        ) : !bridgeState.enabled ? (
          <div className="remote-inbox-empty">
            <Icon name="radio" />
            <p>Remote Bridge is Disabled</p>
            <small>Signed in as {bridgeState.accountEmail}. Enable the bridge when you want Hearth to poll for tasks.</small>
          </div>
        ) : remotePendingTasks.length === 0 ? (
          <div className="remote-inbox-empty">
            <Icon name="radio" />
            <p>No pending remote tasks</p>
            <small>Incoming tasks from connected clients will appear here for your review and approval.</small>
          </div>
        ) : (
          <div className="remote-tasks-list">
            {remotePendingTasks.map((t) => (
              <div key={t.id} className="remote-task-card">
                <div className="remote-task-main">
                  <div className="remote-task-meta">
                    <span className="remote-source-tag">{t.source || 'chatgpt'}</span>
                    <strong className="remote-task-title">{t.title || 'Remote Task'}</strong>
                    <span className="remote-task-time">{new Date(t.createdAt).toLocaleTimeString()}</span>
                  </div>
                  <p className="remote-task-preview">{t.prompt.slice(0, 140)}{t.prompt.length > 140 ? '…' : ''}</p>
                </div>
                <div className="remote-task-actions">
                  <button
                    className="remote-action-btn review"
                    type="button"
                    onClick={() => setReviewTask(t)}
                  >
                    Review
                  </button>
                  <button
                    className="remote-action-btn reject"
                    type="button"
                    disabled={bridgeBusy}
                    onClick={() => handleRejectRemoteTask(t)}
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="remote-routing-note">
          <div>
            <strong>Project X routing</strong>
            <span>{publicXState?.signedIn ? 'Connected · X-routed requests are shown in the X tab.' : 'Project X is not connected. Configure it from Connections.'}</span>
          </div>
          <button className="task-workspace-change" type="button" onClick={() => navigate('Connections')}>
            Open Connections
          </button>
        </div>
      </section>
      )}
    </div>
  );
}
