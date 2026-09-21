import type { Dispatch, ReactNode, SetStateAction } from 'react';
import Icon from '../Icon';
import type { ApprovalRequest } from '../approval-types';

type Props = {
  renderGoalsHeader: (status?: ReactNode) => ReactNode;
  workspace: string;
  chooseWorkspace: () => Promise<void>;
  isGoalActive: boolean;
  isTaskRunning: boolean;
  approvalQueue: ApprovalRequest[];
  goals: Goal[];
  selectedGoal: Goal | null;
  terminalGoalCount: number;
  setSelectedGoalId: Dispatch<SetStateAction<string | null>>;
  setShowNewGoalModal: Dispatch<SetStateAction<boolean>>;
  setShowClearGoalsConfirm: Dispatch<SetStateAction<boolean>>;
  goalActionBusy: boolean;
  handleRunGoal: (goalId: string) => Promise<void>;
  handlePauseGoal: (goalId: string) => Promise<void>;
  handleResumeGoal: (goalId: string) => Promise<void>;
  handleSignoffStep: (goalId: string, stepId: string, action: 'complete' | 'fail') => Promise<void>;
  bridgeState: BridgeState | null;
  publicXState: PublicTasksState | null;
  goalRequestBusy: boolean;
  handleImportRemoteGoalRequest: (goalRequest: GoalRequestCard) => Promise<void>;
  handleRejectRemoteGoalRequest: (goalRequest: GoalRequestCard) => Promise<void>;
  setReviewGoalRequest: Dispatch<SetStateAction<GoalRequestCard | null>>;
};

export default function GoalsPage({
  renderGoalsHeader,
  workspace,
  chooseWorkspace,
  isGoalActive,
  isTaskRunning,
  approvalQueue,
  goals,
  selectedGoal,
  terminalGoalCount,
  setSelectedGoalId,
  setShowNewGoalModal,
  setShowClearGoalsConfirm,
  goalActionBusy,
  handleRunGoal,
  handlePauseGoal,
  handleResumeGoal,
  handleSignoffStep,
  bridgeState,
  publicXState,
  goalRequestBusy,
  handleImportRemoteGoalRequest,
  handleRejectRemoteGoalRequest,
  setReviewGoalRequest,
}: Props): ReactNode {
  return (
    <div className="goals-view">
      {renderGoalsHeader(
        <div className={`connection-pill ${isGoalActive ? 'online' : ''}`}>
          <span /> Goal Runner · {isGoalActive ? 'Active' : 'Standing by'}
        </div>
      )}

      <section className="soft-panel console-approvals-panel" aria-labelledby="console-approvals-title">
                      <div className="panel-title">
                        <div><p className="section-kicker">APPROVALS</p><h2 id="console-approvals-title">Pending requests</h2></div>
                        <span className="panel-meta">Status only</span>
                      </div>
                      {approvalQueue.length === 0 ? (
                        <div className="console-empty"><Icon name="lock" /><p>No pending approvals</p><small>A new request opens the approval dialog straight away.</small></div>
                      ) : (
                        <div className="console-approval-list">
                          {approvalQueue.map((item, index) => (
                            <article className="console-approval-row" key={item.requestId}>
                              <span>{index === 0 ? 'Waiting now' : `Queued ${index + 1}`}</span>
                              <strong>{item.permission}</strong>
                              <p>{item.action}</p>
                            </article>
                          ))}
                        </div>
                      )}
                      <p className="console-boundary-note">This list cannot allow or deny requests. Each decision is made in the approval dialog when it appears.</p>
                    </section>

      <div className="goals-workspace-bar">
        <div className="goals-workspace-info">
          <Icon name="folder" />
          <span>Workspace:</span>
          <code>{workspace || 'No workspace selected'}</code>
          {isGoalActive && (
            <span className="workspace-lock-badge" title="Workspace is locked while any goal is running, waiting, or paused">
              🔒 Locked
            </span>
          )}
        </div>
        <div className="goals-action-buttons">
          <button
            className="clear-goal-history-btn"
            type="button"
            disabled={terminalGoalCount === 0 || goalActionBusy}
            onClick={() => setShowClearGoalsConfirm(true)}
            title={terminalGoalCount === 0 ? 'No completed/error Goals to clear' : `Clear ${terminalGoalCount} completed/error Goal(s)`}
          >
            Clear history{terminalGoalCount > 0 ? ` (${terminalGoalCount})` : ''}
          </button>
          <button
            className="task-workspace-change"
            disabled={isTaskRunning || isGoalActive}
            onClick={chooseWorkspace}
            title={isGoalActive ? 'Workspace is locked while goal is active' : 'Choose different folder'}
          >
            Change folder
          </button>
          <button
            className="new-goal-btn"
            type="button"
            onClick={() => setShowNewGoalModal(true)}
          >
            <Icon name="plus" />
            <span>New Goal</span>
          </button>
        </div>
      </div>

      <section className="remote-inbox-section control-center-remote-goals" aria-label="Remote Goals">
        {/* PROJECT X REMOTE GOALS -- a dedicated, distinct transport from
            the single-task Remote Tasks above. Importing only creates
            the Goal locally (status 'ready'); it never runs anything and
            never grants X approval -- open Goals, press Run, and the
            existing Goal-level X approval prompt is still required. */}
        {publicXState?.signedIn ? (
          <>
            <div className="remote-inbox-header">
              <div>
                <p className="kicker">PROJECT X</p>
                <h2>Project X Remote Goals</h2>
              </div>
            </div>
            {!bridgeState?.pendingGoalRequests?.length ? (
              <div className="remote-inbox-empty">
                <Icon name="flag" />
                <p>No pending remote Goals</p>
                <small>A complete, pre-authored multi-step Goal queued by Chat/Main Brain will appear here for your review and import.</small>
              </div>
            ) : (
              <div className="remote-tasks-list">
                {bridgeState.pendingGoalRequests.map((g) => (
                  <div key={g.id} className="remote-task-card">
                    <div className="remote-task-main">
                      <div className="remote-task-meta">
                        <span className="remote-source-tag">goal</span>
                        <strong className="remote-task-title">{g.title}</strong>
                        <span className="remote-task-time">{new Date(g.createdAt).toLocaleTimeString()}</span>
                      </div>
                      <p className="remote-task-preview">{g.objective.slice(0, 140)}{g.objective.length > 140 ? '…' : ''}</p>
                      <small>{g.stepCount} step{g.stepCount === 1 ? '' : 's'} · {g.xStepCount} X step{g.xStepCount === 1 ? '' : 's'} · <code>{g.workspace}</code></small>
                    </div>
                    <div className="remote-task-actions">
                      <button className="remote-action-btn review" type="button" onClick={() => setReviewGoalRequest(g)}>Review</button>
                      <button className="remote-action-btn reject" type="button" disabled={goalRequestBusy} onClick={() => handleRejectRemoteGoalRequest(g)}>Reject</button>
                      <button className="remote-action-btn approve" type="button" disabled={goalRequestBusy} onClick={() => handleImportRemoteGoalRequest(g)} title="Import into Goals -- does not run or approve X">
                        Import
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="remote-inbox-empty">
            <Icon name="flag" />
            <p>Remote Goals are not connected</p>
            <small>Connect Project X from the Connections tab to receive remote multi-step Goals.</small>
          </div>
        )}
      </section>

      <div className="goals-layout">
        {/* Left Column: Goals List */}
        <div className="goals-list-panel">
          <div className="goals-list-header">
            <div>
              <h3>Goals</h3>
              <small>Active work + local history</small>
            </div>
            <span className="goals-count-badge">{goals.length}</span>
          </div>
          {goals.length === 0 ? (
            <div className="task-empty-card" style={{ padding: '24px 12px' }}>
              <Icon name="flag" />
              <p>No goals created yet</p>
              <small>Click "New Goal" above to create your first multi-step goal.</small>
            </div>
          ) : (
            goals.map((g) => {
              const completedSteps = g.steps.filter((s) => s.status === 'completed').length;
              return (
                <div
                  key={g.id}
                  className={`goal-card-item ${selectedGoal?.id === g.id ? 'active' : ''}`}
                  onClick={() => setSelectedGoalId(g.id)}
                >
                  <div className="goal-card-header">
                    <strong className="goal-card-title">{g.title}</strong>
                    <span className={`goal-status-pill ${g.status}`}>{g.status}</span>
                  </div>
                  <div className="goal-card-meta">
                    <span>{completedSteps}/{g.steps.length} steps</span>
                    <span>{new Date(g.createdAt).toLocaleDateString()}</span>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Right Column: Goal Detail */}
        {selectedGoal ? (
          <div className="goal-detail-panel">
            <div className="goal-detail-header">
              <div className="goal-detail-title-group">
                <h2>{selectedGoal.title}</h2>
                <p className="goal-detail-objective">{selectedGoal.objective}</p>
              </div>
              <div className="goal-detail-controls">
                <span className={`goal-status-pill ${selectedGoal.status}`}>{selectedGoal.status}</span>
                {(selectedGoal.status === 'ready' || selectedGoal.status === 'draft' || selectedGoal.status === 'error') && (
                  <button
                    className="goal-btn-run"
                    type="button"
                    disabled={goalActionBusy || isGoalActive}
                    onClick={() => handleRunGoal(selectedGoal.id)}
                  >
                    {goalActionBusy ? 'Running…' : 'Run Goal'}
                  </button>
                )}
                {selectedGoal.status === 'running' && (
                  <button
                    className="goal-btn-pause"
                    type="button"
                    disabled={goalActionBusy}
                    onClick={() => handlePauseGoal(selectedGoal.id)}
                  >
                    Pause
                  </button>
                )}
                {selectedGoal.status === 'waiting' && selectedGoal.steps.find((s) => s.id === selectedGoal.currentStepId)?.route === 'manual' ? (
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <button
                      className="goal-btn-run"
                      type="button"
                      disabled={goalActionBusy}
                      onClick={() => {
                        const activeStep = selectedGoal.steps.find((s) => s.id === selectedGoal.currentStepId);
                        if (activeStep) void handleSignoffStep(selectedGoal.id, activeStep.id, 'complete');
                      }}
                    >
                      <Icon name="check" />
                      <span>Mark Step Complete</span>
                    </button>
                    <button
                      className="remote-action-btn reject"
                      type="button"
                      disabled={goalActionBusy}
                      onClick={() => {
                        const activeStep = selectedGoal.steps.find((s) => s.id === selectedGoal.currentStepId);
                        if (activeStep) void handleSignoffStep(selectedGoal.id, activeStep.id, 'fail');
                      }}
                    >
                      <span>Fail Step</span>
                    </button>
                  </div>
                ) : (selectedGoal.status === 'paused' || selectedGoal.status === 'waiting') && (
                  <button
                    className="goal-btn-resume"
                    type="button"
                    disabled={goalActionBusy}
                    onClick={() => handleResumeGoal(selectedGoal.id)}
                  >
                    {goalActionBusy ? 'Resuming…' : 'Resume'}
                  </button>
                )}
              </div>
            </div>

            {selectedGoal.constraints && selectedGoal.constraints.length > 0 && (
              <div className="goal-constraints-box">
                <strong>Constraints:</strong> {selectedGoal.constraints.join('; ')}
              </div>
            )}

            {/* Steps list */}
            <div className="goal-steps-container">
              <span className="task-section-label">Execution Steps ({selectedGoal.steps.length})</span>
              {selectedGoal.steps.map((step, idx) => (
                <div
                  key={step.id}
                  className={`goal-step-row ${step.status === 'running' ? 'step-running' : step.status === 'error' ? 'step-error' : ''}`}
                >
                  <div className="goal-step-top">
                    <div className="goal-step-title-wrap">
                      <span className={`goal-step-badge ${step.status}`}>
                        {step.status === 'completed' ? '✓' : step.status === 'running' ? '●' : step.status === 'waiting' ? '⏳' : step.status === 'paused' ? '⏸' : step.status === 'error' ? '✕' : step.status === 'skipped' ? '⊘' : idx + 1}
                      </span>
                      <strong className="goal-step-title">{step.title}</strong>
                    </div>
                    <div className="goal-step-tags">
                      <span className="goal-route-tag">{step.route}</span>
                      <span className="goal-req-tag">{step.required ? 'Required' : 'Optional'}</span>
                      <span className={`goal-status-pill ${step.status}`}>{step.status}</span>
                    </div>
                  </div>
                  {step.description && <p className="goal-step-desc">{step.description}</p>}
                  {step.result && (
                    <div className="goal-step-output">
                      <strong>Result:</strong> {step.result}
                    </div>
                  )}
                  {step.route === 'manual' && step.status === 'waiting' && (
                    <div className="manual-signoff-actions" style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                      <button
                        className="goal-btn-run"
                        type="button"
                        disabled={goalActionBusy}
                        onClick={() => void handleSignoffStep(selectedGoal.id, step.id, 'complete')}
                      >
                        <Icon name="check" />
                        <span>Mark Step Complete</span>
                      </button>
                      <button
                        className="remote-action-btn reject"
                        type="button"
                        disabled={goalActionBusy}
                        onClick={() => void handleSignoffStep(selectedGoal.id, step.id, 'fail')}
                      >
                        <span>Fail Step</span>
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Latest Checkpoint */}
            {selectedGoal.checkpoints && selectedGoal.checkpoints.length > 0 && (
              <div className="goal-checkpoint-card">
                <div className="goal-checkpoint-header">
                  <span>Latest Checkpoint #{selectedGoal.checkpoints.length}</span>
                  <span>{new Date(selectedGoal.checkpoints[selectedGoal.checkpoints.length - 1].timestamp).toLocaleTimeString()}</span>
                </div>
                <p className="goal-checkpoint-summary">
                  {selectedGoal.checkpoints[selectedGoal.checkpoints.length - 1].summary}
                </p>
                <div className="goal-checkpoint-checks">
                  <span>Steps: {selectedGoal.checkpoints[selectedGoal.checkpoints.length - 1].completedSteps} completed</span>
                  {selectedGoal.checkpoints[selectedGoal.checkpoints.length - 1].route && (
                    <span>Route: {selectedGoal.checkpoints[selectedGoal.checkpoints.length - 1].route}</span>
                  )}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="task-empty-card">
            <Icon name="flag" />
            <p>Select a goal</p>
            <small>Choose a goal from the list or create a new one.</small>
          </div>
        )}
      </div>
    </div>
  );
}
