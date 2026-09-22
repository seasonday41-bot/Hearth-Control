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
  formatElapsed: (created?: string, completed?: string) => string;
  executorStatus: AntigravityStatus | null;
  taskCenterTab: 'x' | 'antigravity' | 'remote';
  setTaskCenterTab: Dispatch<SetStateAction<'x' | 'antigravity' | 'remote'>>;
  taskPrompt: string;
  setTaskPrompt: Dispatch<SetStateAction<string>>;
  promptBytes: number;
  taskSubmitting: boolean;
  handleStartTask: () => Promise<void>;
  taskData: AntigravityTaskData | null;
  activeTaskSource: 'Local' | 'Remote';
  showTaskProgress: boolean;
  setShowTaskProgress: Dispatch<SetStateAction<boolean>>;
  followUpInput: string;
  setFollowUpInput: Dispatch<SetStateAction<string>>;
  followUpSubmitting: boolean;
  handleSendFollowUp: () => Promise<void>;
  handleResumeTask: () => Promise<void>;
  handleDismissTask: () => Promise<void>;
  handleMarkTaskFailed: () => Promise<void>;
  recoveryBusy: boolean;
  xPerm: PermissionValue;
  xReady: boolean;
  rotateXPerm: () => void;
  xPendingTasks: BridgeTask[];
  activeXStatus: XQueueStatus | null;
  liveXRuns: XRunSummary[];
  recentXRuns: XRunSummary[];
  antigravityPerm: PermissionValue;
  rotateAntigravityPerm: () => void;
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
  formatElapsed,
  executorStatus,
  taskCenterTab,
  setTaskCenterTab,
  taskPrompt,
  setTaskPrompt,
  promptBytes,
  taskSubmitting,
  handleStartTask,
  taskData,
  activeTaskSource,
  showTaskProgress,
  setShowTaskProgress,
  followUpInput,
  setFollowUpInput,
  followUpSubmitting,
  handleSendFollowUp,
  handleResumeTask,
  handleDismissTask,
  handleMarkTaskFailed,
  recoveryBusy,
  xPerm,
  xReady,
  rotateXPerm,
  xPendingTasks,
  activeXStatus,
  liveXRuns,
  recentXRuns,
  antigravityPerm,
  rotateAntigravityPerm,
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
        ) : taskCenterTab === 'remote' ? (
          <div className={'connection-pill ' + (bridgeState?.connected ? 'online' : '')}>
            <span /> Remote · {bridgeState?.connected ? 'Bridge connected' : 'Standing by'}
          </div>
        ) : (
          <div className={'connection-pill ' + (executorStatus?.available ? 'online' : '')}>
            <span /> Executor · {executorStatus?.available ? 'Connected' : 'Unavailable'}
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
        <button type="button" role="tab" aria-selected={taskCenterTab === 'antigravity'} className={taskCenterTab === 'antigravity' ? 'active' : ''} onClick={() => setTaskCenterTab('antigravity')}>
          <span>Antigravity</span>
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

      {taskCenterTab === 'antigravity' && (
        <>
      <div className="task-input-box">
        <div className="task-textarea-container">
          <textarea
            className="task-textarea"
            placeholder="Describe your task for Antigravity (e.g. Inspect git diff, review package.json, check test suite...)"
            value={taskPrompt}
            onChange={(e) => setTaskPrompt(e.target.value)}
            disabled={taskSubmitting || isTaskRunning}
            rows={4}
          />
          {promptBytes > 60000 && (
            <div className="task-size-warning">
              {promptBytes.toLocaleString()} / 65,536 bytes {promptBytes > 65536 ? '⚠️ Exceeds 64 KiB limit' : ''}
            </div>
          )}
        </div>
        <div className="task-input-footer">
          <div className="task-options-group">
            <div className="executor-indicator">
              <span className={`executor-status-dot ${executorStatus?.available ? 'connected' : 'unavailable'}`} />
              <span>Executor: <em>{executorStatus?.available ? 'Ready' : 'Unavailable'}</em></span>
            </div>
            <button
              className="task-perm-button"
              onClick={rotateAntigravityPerm}
              type="button"
              title="Click to cycle Antigravity permission (Ask / Allow / Blocked)"
            >
              <i style={{
                background: antigravityPerm === 'Allow' ? 'var(--sage)' : antigravityPerm === 'Blocked' ? 'var(--rose)' : '#9a7545'
              }} />
              <span>Permission: <strong>{antigravityPerm}</strong></span>
              <Icon name="chevron" />
            </button>
          </div>
          <button
            className="run-task-button"
            disabled={!taskPrompt.trim() || taskSubmitting || isTaskRunning || !executorStatus?.available || antigravityPerm === 'Blocked' || promptBytes > 65536}
            onClick={handleStartTask}
            type="button"
          >
            <Icon name="console" />
            <span>{taskSubmitting ? 'Starting…' : isTaskRunning ? 'Running…' : 'Run Task'}</span>
          </button>
        </div>
      </div>

      {taskData ? (
        <section className="active-task-section" aria-labelledby="active-task-heading">
          <div className="task-header-row">
            <div className="task-header-title">
              <h2 id="active-task-heading">{taskData.title || `Task ${taskData.taskId}`}</h2>
              <p>Started at {new Date(taskData.createdAt).toLocaleTimeString()}</p>
            </div>
            <div className={`task-status-pill ${taskData.status}`}>
              <span />
              {taskData.status}
            </div>
          </div>

          <div className="task-meta-bar">
            <div className="task-meta-item"><span>Source</span><code>{activeTaskSource}</code></div>
            <div className="task-meta-item">
              <span>Task ID</span>
              <button className="task-id-copy" type="button" onClick={() => { void navigator.clipboard.writeText(taskData.taskId); flash('Task ID copied'); }}><code>{taskData.taskId.slice(0, 8)}…</code> Copy</button>
            </div>
            <div className="task-meta-item">
              <span>Conversation ID</span>
              <code>{taskData.conversationId || 'Pending…'}</code>
            </div>
            <div className="task-meta-item">
              <span>Status</span>
              <code>{taskData.status}</code>
            </div>
            <div className="task-meta-item">
              <span>Elapsed</span>
              <code>{formatElapsed(taskData.createdAt, ['done', 'error', 'waiting'].includes(taskData.status) ? taskData.updatedAt : undefined)}</code>
            </div>
          </div>

          <div className="task-live-summary"><strong>Latest</strong><span>{taskData.lastEvent?.summary || taskData.completion?.summary || (taskData.status === 'starting' ? 'Preparing executor…' : 'No progress update yet.')}</span><button type="button" aria-expanded={showTaskProgress} onClick={() => setShowTaskProgress((visible) => !visible)}>{showTaskProgress ? 'Hide Progress' : 'View Progress'}</button></div>

          {taskData.status === 'recovery_required' && (
            <div className="task-recovery-box">
              <div className="task-recovery-header">
                <div className="task-recovery-title">
                  <Icon name="terminal" />
                  <span>INTERRUPTED TASK REQUIRES RECOVERY</span>
                </div>
                <span className="task-status-pill recovery_required">RECOVERY REQUIRED</span>
              </div>
              <p className="task-recovery-desc">
                This task was interrupted by an application or system shutdown. Process termination is never assumed to be successful. You can resume execution with the original conversation context, mark the task failed, or dismiss it.
              </p>
              <div className="task-recovery-actions">
                <button
                  className="task-recovery-btn-resume"
                  disabled={recoveryBusy || !executorStatus?.available || antigravityPerm === 'Blocked'}
                  onClick={handleResumeTask}
                  type="button"
                >
                  {recoveryBusy ? 'Processing…' : 'Resume Task'}
                </button>
                <button
                  className="task-recovery-btn-fail"
                  disabled={recoveryBusy}
                  onClick={handleMarkTaskFailed}
                  type="button"
                >
                  Mark Failed
                </button>
                <button
                  className="task-recovery-btn-dismiss"
                  disabled={recoveryBusy}
                  onClick={handleDismissTask}
                  type="button"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {taskData.error && (
            <div className="task-error-box">
              <div className="task-error-message">
                <strong>Task Error:</strong> {taskData.error}
              </div>
            </div>
          )}

          {taskData.status === 'waiting' && taskData.completion?.interimReason && (
            <div className="task-error-box">
              <div className="task-error-message">
                <strong>Waiting:</strong> {taskData.completion.interimReason}
              </div>
            </div>
          )}

          {taskData.lastAnswer && (
            <div className="task-result-card">
              <div className="task-result-header">
                <span className="task-section-label">Executor Output</span>
                <button
                  className="task-copy-button"
                  type="button"
                  onClick={async () => {
                    if (taskData.lastAnswer) {
                      await navigator.clipboard.writeText(taskData.lastAnswer);
                      flash('Result copied to clipboard');
                    }
                  }}
                >
                  <Icon name="copy" />
                  <span>Copy Result</span>
                </button>
              </div>
              <div className="task-result-content">{taskData.lastAnswer}</div>
            </div>
          )}

          {showTaskProgress && (
            <div className="task-progress-card">
              <span className="task-section-label">
                Progress Events ({taskData.recentEvents?.length ?? 0})
              </span>
              <div className="task-events-list">
              {(!taskData.recentEvents || taskData.recentEvents.length === 0) ? (
                <div style={{ color: '#718089', fontStyle: 'italic', padding: '6px 0' }}>
                  {taskData.status === 'starting' ? 'Waiting for executor to initialize…' : 'No events recorded.'}
                </div>
              ) : (
                taskData.recentEvents.map((ev, i) => (
                  <div key={`${ev.stepIndex ?? i}-${i}`} className="task-event-row">
                    <span className="task-event-step">#{ev.stepIndex ?? i + 1}</span>
                    <span className="task-event-type">{ev.type || 'PROGRESS'}</span>
                    <span className="task-event-text">{ev.summary || ''}</span>
                  </div>
                ))
              )}
              </div>
            </div>
          )}

          {(taskData.status === 'done' || taskData.status === 'waiting') && (
            <div className="task-followup-box">
              <input
                className="task-followup-input"
                placeholder="Send follow-up instruction to this conversation…"
                value={followUpInput}
                onChange={(e) => setFollowUpInput(e.target.value)}
                disabled={followUpSubmitting}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void handleSendFollowUp();
                  }
                }}
              />
              <button
                className="task-followup-button"
                disabled={!followUpInput.trim() || followUpSubmitting}
                onClick={handleSendFollowUp}
                type="button"
              >
                <span>{followUpSubmitting ? 'Sending…' : 'Send'}</span>
                <Icon name="chevron" />
              </button>
            </div>
          )}
        </section>
      ) : (
        <div className="task-empty-card">
          <Icon name="console" />
          <p>No active task</p>
          <small>Compose an instruction above and click Run Task to dispatch work to Antigravity.</small>
        </div>
      )}

        </>
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
                  <button
                    className="remote-action-btn approve"
                    type="button"
                    disabled={t.routedTo === 'x' ? bridgeBusy : (bridgeBusy || isTaskRunning || !executorStatus?.available || antigravityPerm === 'Blocked')}
                    onClick={() => handleApproveRemoteTask(t)}
                    title={t.routedTo === 'x' ? 'Approve and dispatch to X' : (isTaskRunning ? 'Cannot run while another task is running' : 'Approve and dispatch to Antigravity')}
                  >
                    Approve & Run
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
