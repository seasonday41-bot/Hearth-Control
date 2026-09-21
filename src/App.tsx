import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import StorageAudit from './StorageAudit';
import Icon, { type IconName } from './Icon';
import type { ApprovalRequest } from './approval-types';
import InvestPage from './pages/InvestPage';
import GoalsPage from './pages/GoalsPage';
import GoalsActivityPage from './pages/GoalsActivityPage';
import ChatPage, { type ChatActivityItem, type ChatTestApproval } from './pages/ChatPage';
import './calm-control.css';
import AIConnectorPanel, { type AIConnectorItem } from './components/AIConnectorPanel';
import GitHubConnectionCard from './components/GitHubConnectionCard';
import { getV2CoordinatorDisplay } from './invest-coordinator-status';

type Permission = 'Allow' | 'Ask' | 'Blocked';
// Six destinations, each one thing the operator actually does. Anything that is
// a mechanism rather than a destination -- X runs, the queue, pending tasks,
// runIds -- is detail inside Goals or evidence inside System, never navigation.
type NavItem = 'Overview' | 'Goals' | 'Chat' | 'Invest' | 'Connections' | 'System';
type GoalsTab = 'Goals' | 'Activity';
type SystemTab = 'Workspace' | 'Permissions' | 'Activity' | 'Storage' | 'Updates';


type LogEntry = { time: string; source: string; message: string; tone: string };
type ApprovalEvidenceState = 'pending' | 'allowed' | 'denied' | 'timeout' | 'aborted' | 'shutdown';
type ApprovalEvidence = ApprovalRequest & {
  state: ApprovalEvidenceState;
  time: string;
  reason: 'user' | 'timeout' | 'aborted' | 'shutdown' | null;
};

const APPROVAL_EVIDENCE_LIMIT = 40;

export const recordApprovalRequested = (
  history: ApprovalEvidence[],
  incoming: ApprovalRequest,
  time: string,
): ApprovalEvidence[] => {
  const existing = history.find((item) => item.requestId === incoming.requestId);
  const next = existing
    ? history.map((item) => item.requestId === incoming.requestId
      ? { ...item, permission: incoming.permission, action: incoming.action }
      : item)
    : [...history, { ...incoming, state: 'pending' as const, time, reason: null }];
  return next.slice(-APPROVAL_EVIDENCE_LIMIT);
};

export const recordApprovalResolved = (
  history: ApprovalEvidence[],
  requestId: string,
  allowed: boolean,
  reason: 'user' | 'timeout' | 'aborted' | 'shutdown' | undefined,
  time: string,
): ApprovalEvidence[] => {
  const state: ApprovalEvidenceState = allowed
    ? 'allowed'
    : reason === 'timeout' || reason === 'aborted' || reason === 'shutdown'
      ? reason
      : 'denied';
  const next = history.map((item) => item.requestId === requestId
    ? { ...item, state, reason: reason ?? 'user', time }
    : item);
  return next.slice(-APPROVAL_EVIDENCE_LIMIT);
};

// Pure FIFO queue logic for the approval collection -- kept outside the
// component so it's a plain, deterministic function of (queue, event),
// independent of React state timing. Duplicates are ignored on arrival
// (never re-queued), and removal is always requestId-specific: resolving
// or answering one request never disturbs any other pending one.
export const upsertApproval = (queue: ApprovalRequest[], incoming: ApprovalRequest): ApprovalRequest[] => {
  if (queue.some((item) => item.requestId === incoming.requestId)) return queue;
  return [...queue, incoming];
};

export const removeApproval = (queue: ApprovalRequest[], requestId: string): ApprovalRequest[] => {
  if (!queue.some((item) => item.requestId === requestId)) return queue;
  return queue.filter((item) => item.requestId !== requestId);
};

const initialPermissions: Array<{ name: string; detail: string; value: Permission; disabled?: boolean }> = [
  { name: 'X', detail: 'Route coding work to the local X worker', value: 'Ask' },
  { name: 'Codex', detail: 'Allow authorized specialist continuations through Codex CLI', value: 'Ask' },
  { name: 'Files', detail: 'Read and write inside this workspace', value: 'Allow' },
  { name: 'Git', detail: 'Inspect status, history and diffs', value: 'Allow' },
  { name: 'Terminal', detail: 'Run local commands after confirmation', value: 'Ask' },
  { name: 'Antigravity', detail: 'Run approved tasks through the secure Antigravity CLI', value: 'Ask' },
  { name: 'Vercel', detail: 'Read projects and deployments through the connected Vercel account', value: 'Ask' },
  { name: 'MarketResearch', detail: 'Use fixed-source XAU/USD research for Search AI; this does not control a browser', value: 'Ask' },
  { name: 'Browser', detail: 'General browser automation — unavailable and unrelated to Market Research', value: 'Blocked', disabled: true },
];

const navGroups: Array<{ label: string; items: Array<{ name: NavItem; icon: IconName; label?: string }> }> = [
  {
    label: 'WORK',
    items: [
      { name: 'Overview', icon: 'grid' },
      { name: 'Goals', icon: 'flag' },
      { name: 'Chat', icon: 'radio' },
      { name: 'Invest', icon: 'activity' },
    ],
  },
  {
    label: 'SETUP',
    items: [
      { name: 'Connections', icon: 'console' },
      { name: 'System', icon: 'lock' },
    ],
  },
];

const GOALS_TABS: GoalsTab[] = ['Goals', 'Activity'];
const SYSTEM_TABS: SystemTab[] = ['Workspace', 'Permissions', 'Activity', 'Storage', 'Updates'];

const PAGE_INTRO: Record<NavItem, string> = {
  Overview: 'Monitor your workspace and choose where to work next.',
  Goals: 'Everything you have asked Hearth to do, and how far it has got.',
  Chat: 'Talk to a local model. Nothing here creates a task or a durable job.',
  Invest: 'The XAUUSD demo trading subsystem.',
  Connections: 'Agents and services this workspace can reach.',
  System: 'Workspace, permissions, activity, storage, and updates.',
};

const LocalChatResponse = ({ text, onExpand }: { text: string; onExpand: (code: string, language: string) => void }) => {
  const parts: ReactNode[] = [];
  const pattern = /```([^\n`]*)\n?([\s\S]*?)```/g;
  let cursor = 0;
  let match;
  let key = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) parts.push(<span key={`text-${key++}`}>{text.slice(cursor, match.index)}</span>);
    const language = match[1].trim();
    const code = match[2].replace(/^\n/, '').replace(/\n$/, '');
    parts.push(<div className="local-chat-code-block" key={`code-${key++}`}><div className="local-chat-code-toolbar"><span>{language || 'code'}</span><span><button type="button" onClick={() => void navigator.clipboard.writeText(code)}>Copy</button><button type="button" onClick={() => onExpand(code, language)}>Expand</button></span></div><pre><code>{code}</code></pre></div>);
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push(<span key={`text-${key++}`}>{text.slice(cursor)}</span>);
  return <div className="local-chat-response-content">{parts}</div>;
};

export default function App() {
  const [running, setRunning] = useState(false);
  const [workspace, setWorkspace] = useState('');
  const [port, setPort] = useState(3001);
  const [pid, setPid] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [settingsReady, setSettingsReady] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [permissions, setPermissions] = useState(initialPermissions);
  const [activeNav, setActiveNav] = useState<NavItem>('Overview');
  const [goalsTab, setGoalsTab] = useState<GoalsTab>('Goals');
  const [systemTab, setSystemTab] = useState<SystemTab>('Workspace');
  const [dark, setDark] = useState(() => localStorage.getItem('control-theme') === 'dark');
  const [notice, setNotice] = useState('');
  const [approvalQueue, setApprovalQueue] = useState<ApprovalRequest[]>([]);
  const [approvalEvidence, setApprovalEvidence] = useState<ApprovalEvidence[]>([]);
  const approval = approvalQueue[0] ?? null;
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [connectionsBusy, setConnectionsBusy] = useState(false);
  const [connectionsError, setConnectionsError] = useState('');
  const [connectionActionBusy, setConnectionActionBusy] = useState<string | null>(null);
  const [connectionTokenInputs, setConnectionTokenInputs] = useState<Record<string, string>>({});
  const [githubPrCreateInputs, setGithubPrCreateInputs] = useState<Record<string, boolean>>({});
  const [githubSetupOpen, setGithubSetupOpen] = useState<Record<string, boolean>>({});
  const [githubRepositories, setGithubRepositories] = useState<Record<string, Array<{ id: number | null; name: string | null; fullName: string | null; private: boolean; archived: boolean; defaultBranch: string | null; owner: string | null }>>>({});
  const [githubRepoBusy, setGithubRepoBusy] = useState<string | null>(null);
  const [githubRepoErrors, setGithubRepoErrors] = useState<Record<string, string>>({});
  const githubRepoLoadedRef = useRef<Set<string>>(new Set());
  const [vercelTeamIdInput, setVercelTeamIdInput] = useState('');
  const [workspaceValid, setWorkspaceValid] = useState<boolean | null>(null);
  const [updaterInfo, setUpdaterInfo] = useState<UpdaterInfo | null>(null);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheck | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [showUpdateDetails, setShowUpdateDetails] = useState(false);
  const [investStatus, setInvestStatus] = useState<InvestStatus | null>(null);
  const [investBusy, setInvestBusy] = useState(false);
  const [investError, setInvestError] = useState('');
  const [demoRiskDirty, setDemoRiskDirty] = useState(false);
  const [showV1History, setShowV1History] = useState(false);
  const [demoRiskForm, setDemoRiskForm] = useState({
    riskPerTradePct: '',
    maxDailyLossPct: '',
    maxDrawdownPct: '',
    maxOpenRiskPct: '',
    maxPositions: '',
    maxSpreadPoints: '',
    maxSlippagePoints: '',
    minStopPoints: '',
    maxStopPoints: '',
    requestedVolume: '',
  });

  // Bridge states
  const [bridgeState, setBridgeState] = useState<BridgeState | null>(null);
  const [reviewTask, setReviewTask] = useState<BridgeTask | null>(null);
  const [bridgeBusy, setBridgeBusy] = useState(false);
  const [reviewGoalRequest, setReviewGoalRequest] = useState<GoalRequestCard | null>(null);
  const [goalRequestBusy, setGoalRequestBusy] = useState(false);
  const [bridgeEmail, setBridgeEmail] = useState('');
  const [bridgePassword, setBridgePassword] = useState('');
  const [bridgeAuthMode, setBridgeAuthMode] = useState<'sign-in' | 'sign-up'>('sign-in');

  // Project X Remote Tasks states -- a SEPARATE namespace from the bridge
  // states above (own settings key, own encrypted session, own project).
  const [publicXState, setPublicXState] = useState<PublicTasksState | null>(null);
  const [publicXBusy, setPublicXBusy] = useState(false);
  const [publicXAnonKey, setPublicXAnonKey] = useState('');
  const [publicXEmail, setPublicXEmail] = useState('');
  const [publicXPassword, setPublicXPassword] = useState('');
  const [publicXAuthMode, setPublicXAuthMode] = useState<'sign-in' | 'sign-up'>('sign-in');

  // Goals / Activity states
  const [taskCenterTab, setTaskCenterTab] = useState<'x' | 'antigravity' | 'remote'>('x');
  const [activeXRequestId, setActiveXRequestId] = useState<string | null>(null);
  const [activeXStatus, setActiveXStatus] = useState<XQueueStatus | null>(null);
  const [recentXRuns, setRecentXRuns] = useState<XRunSummary[]>([]);
  const [executorStatus, setExecutorStatus] = useState<AntigravityStatus | null>(null);
  const [codexStatus, setCodexStatus] = useState<{ available: boolean } | null>(null);
  const [claudeStatus, setClaudeStatus] = useState<{ available: boolean } | null>(null);
  const [taskPrompt, setTaskPrompt] = useState('');
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [activeTaskSource, setActiveTaskSource] = useState<'Local' | 'Remote'>('Local');
  const [taskData, setTaskData] = useState<AntigravityTaskData | null>(null);
  const [showTaskProgress, setShowTaskProgress] = useState(false);
  const [taskSubmitting, setTaskSubmitting] = useState(false);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [followUpInput, setFollowUpInput] = useState('');
  const [followUpSubmitting, setFollowUpSubmitting] = useState(false);
  const [pollTrigger, setPollTrigger] = useState(0);
  const [, setNowTick] = useState(Date.now());

  // Experimental Chat states; isolated from the Goals / Activity lifecycle.
  const [chatProvider, setChatProvider] = useState<'local' | 'external'>('local');
  const [chatModel, setChatModel] = useState('qwen3.5:9b-hermes');
  const [chatProfile, setChatProfile] = useState<'fast' | 'normal' | 'deep'>('normal');
  const [chatLongResponse, setChatLongResponse] = useState(false);
  const [chatPrompt, setChatPrompt] = useState('');
  const [chatModels, setChatModels] = useState<string[]>([]);
  const [chatHealth, setChatHealth] = useState<any>(null);
  const [chatResult, setChatResult] = useState<any>(null);
  const [chatError, setChatError] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [chatStreaming, setChatStreaming] = useState(false);
  const [chatStreamText, setChatStreamText] = useState('');
  const [chatElapsedMs, setChatElapsedMs] = useState(0);
  const [chatFollowOutput, setChatFollowOutput] = useState(true);
  const [chatExpandedCode, setChatExpandedCode] = useState<{ code: string; language: string } | null>(null);
  const [chatActivity, setChatActivity] = useState<ChatActivityItem[]>([]);
  const [chatTestApproval, setChatTestApproval] = useState<ChatTestApproval | null>(null);
  const [showChatContext, setShowChatContext] = useState(false);
  const [chatContext, setChatContext] = useState<any>(null);
  const [chatContextLoading, setChatContextLoading] = useState(false);
  const [chatContextError, setChatContextError] = useState('');
  const chatRequestIdRef = useRef<string | null>(null);
  const chatStreamStartedRef = useRef(0);
  const chatResponseRef = useRef<HTMLDivElement | null>(null);

  // Goals states
  const [goals, setGoals] = useState<Goal[]>([]);
  const [selectedGoalId, setSelectedGoalId] = useState<string | null>(null);
  const [goalActionBusy, setGoalActionBusy] = useState(false);
  const [showNewGoalModal, setShowNewGoalModal] = useState(false);
  const [showClearGoalsConfirm, setShowClearGoalsConfirm] = useState(false);
  const [newGoalTitle, setNewGoalTitle] = useState('');
  const [newGoalObjective, setNewGoalObjective] = useState('');
  const [newGoalConstraints, setNewGoalConstraints] = useState('');
  const [newGoalSteps, setNewGoalSteps] = useState<Array<{ title: string; description: string; route: StepRoute; required: boolean }>>([
    { title: '', description: '', route: 'antigravity', required: true },
  ]);

  const isGoalActive = useMemo(() => goals.some((g) => ['running', 'waiting', 'paused'].includes(g.status)), [goals]);
  const terminalGoalCount = useMemo(() => goals.filter((g) => ['completed', 'error'].includes(g.status)).length, [goals]);
  const selectedGoal = useMemo(() => goals.find((g) => g.id === selectedGoalId) || goals[0] || null, [goals, selectedGoalId]);

  const activeTaskIdRef = useRef<string | null>(null);
  const pollingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTaskLockRef = useRef(false);

  useEffect(() => {
    activeTaskIdRef.current = activeTaskId;
  }, [activeTaskId]);

  useEffect(() => {
    if (!activeXRequestId) return;
    let active = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    const poll = async () => {
      try {
        const status = await window.controlApp.xQueueStatus(activeXRequestId);
        if (!active) return;
        setActiveXStatus(status);
        if (status.queue_status === 'terminal' && timer) {
          clearInterval(timer);
          timer = null;
        }
      } catch (error) {
        if (active) console.error('X queue status poll error:', error);
      }
    };
    void poll();
    timer = setInterval(poll, 1500);
    return () => {
      active = false;
      if (timer) clearInterval(timer);
    };
  }, [activeXRequestId]);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const runs = await window.controlApp.xListRuns(20);
        if (active) setRecentXRuns(runs);
      } catch (error) {
        if (active) console.error('X run list poll error:', error);
      }
    };
    void poll();
    const timer = setInterval(poll, 1500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    localStorage.setItem('control-theme', dark ? 'dark' : 'light');
    if (settingsReady) void window.controlApp.saveSettings({ theme: dark ? 'dark' : 'light' });
  }, [dark, settingsReady]);

  useEffect(() => {
    let active = true;
    Promise.all([
      window.controlApp.getSettings(),
      window.controlApp.getServerState(),
      window.controlApp.antigravityStatus().catch(() => null),
      window.controlApp.codexStatus().catch(() => null),
      window.controlApp.claudeStatus().catch(() => null),
      window.controlApp.bridgeGetState().catch(() => null),
      window.controlApp.publicTasksGetState().catch(() => null),
      window.controlApp.updaterGetInfo().catch(() => null),
      window.controlApp.updaterCheck().catch(() => null),
      window.controlApp.goalsList().catch(() => []),
      window.controlApp.antigravityListTasks().catch(() => []),
      window.controlApp.connectionsList().catch(() => []),
      window.controlApp.investStatusGet().catch(() => null),
    ]).then(([settings, state, executor, codex, claude, bridge, publicX, updateInfo, update, goalsList, taskList, connectionList, invest]) => {
      if (!active) return;
      if (settings.workspace) setWorkspace(settings.workspace);
      setPort(settings.port);
      setDark(settings.theme === 'dark');
      setPermissions((current) => current.map((item) => ({ ...item, value: settings.permissions[item.name] ?? item.value })));
      setRunning(state.running);
      setPid(state.pid);
      if (executor) setExecutorStatus(executor);
      if (codex) setCodexStatus(codex);
      if (claude) setClaudeStatus(claude);
      if (bridge) setBridgeState(bridge);
      if (publicX) setPublicXState(publicX);
      if (updateInfo) setUpdaterInfo(updateInfo);
      if (update) setUpdateCheck(update);
      if (goalsList) setGoals(goalsList);
      if (Array.isArray(connectionList)) setConnections(connectionList);
      if (invest) setInvestStatus(invest);

      if (Array.isArray(taskList) && taskList.length > 0) {
        const recoveringOrActive = taskList.find((t: any) => !t.dismissed && ['recovery_required', 'running', 'starting', 'waiting'].includes(t.status))
          || taskList.find((t: any) => !t.dismissed);
        if (recoveringOrActive) {
          setActiveTaskId(recoveringOrActive.taskId);
          setActiveTaskSource(recoveringOrActive.source === 'remote' ? 'Remote' : 'Local');
          setTaskData(recoveringOrActive);
        }
      }

      setSettingsReady(true);
    });

    const unsubscribe = window.controlApp.onServerEvent((event) => {
      if (event.type === 'state' && event.state) {
        setRunning((event.state as ServerState).running);
        setPort((event.state as ServerState).port);
        setPid((event.state as ServerState).pid);
        setBusy(false);
      }
      if (event.type === 'bridge:state' && event.state) {
        setBridgeState(event.state as BridgeState);
      }
      if (event.type === 'publicTasks:state' && event.state) {
        setPublicXState(event.state as PublicTasksState);
      }
      if (event.type === 'invest:updated' && event.status) {
        setInvestStatus(event.status);
      }
      if (event.type === 'log' && event.message) {
        setLogs((current) => [...current, { time: now(), source: event.source ?? 'core', tone: event.tone ?? 'quiet', message: event.message ?? '' }]);
      }
      if (event.type === 'approval' && event.requestId && event.permission && event.action) {
        const incoming = { requestId: event.requestId!, permission: event.permission!, action: event.action! };
        setApprovalQueue((current) => upsertApproval(current, incoming));
        setApprovalEvidence((current) => recordApprovalRequested(current, incoming, now()));
      }
      if (event.type === 'approval:resolved' && event.requestId) {
        setApprovalQueue((current) => removeApproval(current, event.requestId!));
        setApprovalEvidence((current) => recordApprovalResolved(
          current,
          event.requestId!,
          event.allowed === true,
          event.reason,
          now(),
        ));
      }
      if (event.type === 'goals:updated' && event.goal) {
        const updatedGoal = event.goal;
        setGoals((current) => {
          const idx = current.findIndex((g) => g.id === updatedGoal.id);
          if (idx >= 0) {
            const next = [...current];
            next[idx] = updatedGoal;
            return next;
          }
          return [updatedGoal, ...current];
        });
      }
    });

    return () => { active = false; unsubscribe(); };
  }, []);

  useEffect(() => {
    if (activeNav !== 'Chat' || chatProvider !== 'local') return;
    let active = true;
    void window.controlApp.localChatStatus().then((status) => {
      if (!active) return;
      setChatHealth(status.health);
      setChatModels(status.models?.ok ? status.models.models : []);
      if (status.models?.ok && status.models.models.length > 0 && !status.models.models.includes(chatModel)) {
        setChatModel(status.models.models[0]);
      }
    }).catch((error: any) => {
      if (active) { setChatHealth({ ok: false, error: { code: 'UNAVAILABLE', message: error?.message || 'Ollama is unavailable' } }); setChatModels([]); }
    });
    return () => { active = false; };
  }, [activeNav, chatProvider]);

  useEffect(() => {
    if (activeNav !== 'Invest') return;
    let active = true;
    void window.controlApp.investStatusGet().then((status) => {
      if (active) setInvestStatus(status);
    }).catch((error: any) => {
      if (active) setInvestError(error?.message || 'Invest status is unavailable.');
    });
    return () => { active = false; };
  }, [activeNav]);

  useEffect(() => {
    const config = investStatus?.risk_config.config;
    if (!config || demoRiskDirty) return;
    setDemoRiskForm({
      riskPerTradePct: String(config.risk_fraction_per_trade * 100),
      maxDailyLossPct: String(config.max_daily_loss_fraction * 100),
      maxDrawdownPct: String(config.max_drawdown_fraction * 100),
      maxOpenRiskPct: String(config.max_total_open_risk_fraction * 100),
      maxPositions: String(config.max_positions),
      maxSpreadPoints: String(config.max_spread_points),
      maxSlippagePoints: String(config.max_slippage_points),
      minStopPoints: String(config.min_stop_points),
      maxStopPoints: String(config.max_stop_points),
      requestedVolume: config.requested_volume == null ? '' : String(config.requested_volume),
    });
  }, [investStatus?.risk_config.config, demoRiskDirty]);

  useEffect(() => {
    if (activeNav !== 'Chat') return;
    void window.controlApp.localChatContext({ model: chatModel, profile: chatProfile, longResponse: chatLongResponse, ollamaAvailable: chatHealth?.ok }).then(setChatContext).catch(() => setChatContext(null));
  }, [activeNav, chatModel, chatProfile, chatLongResponse, chatHealth?.ok]);

  const toggleChatContext = async () => {
    if (showChatContext) {
      setShowChatContext(false);
      return;
    }
    setShowChatContext(true);
    setChatContextError('');
    setChatContextLoading(true);
    try {
      const context = await window.controlApp.localChatContext({ model: chatModel, profile: chatProfile, longResponse: chatLongResponse, ollamaAvailable: chatHealth?.ok });
      setChatContext(context);
    } catch (error: any) {
      setChatContextError(error?.message || 'Context is unavailable.');
    } finally {
      setChatContextLoading(false);
    }
  };

  useEffect(() => window.controlApp.onLocalChatStream((event) => {
    if (!event.requestId || event.requestId !== chatRequestIdRef.current) return;
    if (event.type === 'activity' && event.activity) {
      if (event.activity.type === 'test_approval_requested' && event.activity.profile && event.activity.label && event.activity.timeoutMs) {
        const approval = { ...event.activity, elapsedMs: Math.max(0, Date.now() - chatStreamStartedRef.current) };
        setChatTestApproval({ requestId: event.requestId, profile: event.activity.profile, label: event.activity.label, timeoutMs: event.activity.timeoutMs });
        setChatActivity((current) => [...current, approval]);
      }
      if (['test_approval_cancelled', 'test_running', 'test_finished'].includes(event.activity.type)) setChatTestApproval(null);
      if (event.activity.type === 'test_progress') setChatActivity((current) => current.map((item) => item.type === 'test_running' && item.profile === event.activity!.profile ? { ...item, elapsedMs: event.activity!.elapsedMs } : item));
      else if (event.activity.type === 'test_running') setChatActivity((current) => [...current.filter((item) => item.type !== 'test_approval_requested' || item.profile !== event.activity!.profile), event.activity!]);
      else if (event.activity.type === 'test_finished') setChatActivity((current) => current.map((item) => item.type === 'test_running' && item.profile === event.activity!.profile ? event.activity! : item));
      else if (event.activity.type === 'test_approval_cancelled') setChatActivity((current) => current.map((item) => item.type === 'test_approval_requested' && item.profile === event.activity!.profile ? event.activity! : item));
      else setChatActivity((current) => [...current, event.activity!]);
      return;
    }
    if (event.type === 'chunk' && event.content) {
      setChatStreamText((current) => current + event.content);
      return;
    }
    if (event.type === 'done' || event.type === 'error') {
      const result = event.result || { ok: false, error: { message: 'Provider stream failed' } };
      setChatBusy(false);
      setChatStreaming(false);
      setChatTestApproval(null);
      setChatElapsedMs(Number.isFinite(result.elapsedMs) ? result.elapsedMs : Math.max(0, Date.now() - chatStreamStartedRef.current));
      if (result.response) setChatStreamText(result.response);
      setChatResult(result);
      if (!result.ok) setChatError(result.error?.code === 'CANCELLED' ? 'Generation stopped.' : (result.error?.message || 'Provider stream failed'));
      chatRequestIdRef.current = null;
    }
  }), []);

  useEffect(() => {
    if (!chatStreaming) return;
    const requestId = chatRequestIdRef.current;
    const requestStartedAt = chatStreamStartedRef.current;
    const timer = window.setInterval(() => {
      if (requestId && chatRequestIdRef.current === requestId) {
        const elapsed = Math.max(0, Date.now() - requestStartedAt);
        setChatElapsedMs(elapsed);
        setChatActivity((current) => current.map((item) => item.type === 'test_approval_requested' ? { ...item, elapsedMs: elapsed } : item));
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [chatStreaming]);

  useEffect(() => {
    if (chatFollowOutput && chatResponseRef.current) chatResponseRef.current.scrollTop = chatResponseRef.current.scrollHeight;
  }, [chatStreamText, chatFollowOutput]);

  // Local manifest checks are deliberately infrequent and never install by
  // themselves. A manual check is always available below.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (updateBusy) return;
      void window.controlApp.updaterCheck().then(setUpdateCheck).catch(() => {});
    }, 12_000);
    return () => window.clearInterval(timer);
  }, [updateBusy]);

  // Validate workspace path against real filesystem on every workspace change
  useEffect(() => {
    setWorkspaceValid(null);
    if (!workspace) { setWorkspaceValid(false); return; }
    void window.controlApp.validateWorkspace(workspace).then((result) => setWorkspaceValid(result.valid));
  }, [workspace]);

  // Single polling timer instance per active task
  useEffect(() => {
    if (pollingTimerRef.current) {
      clearInterval(pollingTimerRef.current);
      pollingTimerRef.current = null;
    }
    if (!activeTaskId) return;

    let isSubscribed = true;
    const poll = async () => {
      const currentId = activeTaskIdRef.current;
      if (!currentId || !isSubscribed) return;
      try {
        const data = await window.controlApp.antigravityTask(currentId);
        if (!isSubscribed || activeTaskIdRef.current !== currentId) return;
        setTaskData(data);
        if (data.status === 'done' || data.status === 'error') {
          if (pollingTimerRef.current) {
            clearInterval(pollingTimerRef.current);
            pollingTimerRef.current = null;
          }
        }
      } catch (err) {
        console.error('Task poll error:', err);
      }
    };

    void poll();
    pollingTimerRef.current = setInterval(poll, 2500);

    return () => {
      isSubscribed = false;
      if (pollingTimerRef.current) {
        clearInterval(pollingTimerRef.current);
        pollingTimerRef.current = null;
      }
    };
  }, [activeTaskId, pollTrigger]);

  const isTaskRunning = Boolean(
    taskSubmitting ||
    (taskData && !taskData.dismissed && (
      ['pending', 'starting', 'running'].includes(taskData.status) ||
      taskData.status === 'recovery_required' ||
      (taskData.status === 'paused' && (taskData as any).retainExecutionLock)
    ))
  );

  // Ticker for live elapsed time while task is active
  useEffect(() => {
    if (!isTaskRunning) return;
    const interval = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [isTaskRunning]);

  const now = () => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date());
  const allowed = useMemo(() => permissions.filter((item) => item.value === 'Allow').length, [permissions]);
  const healthyConnections = useMemo(() => connections.filter((item) => item.status === 'CONNECTED').length, [connections]);
  const attentionConnections = useMemo(
    () => connections.filter((item) => ['EXPIRED', 'NEEDS_REAUTH', 'ERROR'].includes(item.status)).length,
    [connections],
  );
  const durableGoalEvidence = useMemo(() => goals
    .flatMap((goal) => goal.checkpoints.map((checkpoint) => ({
      goalId: goal.id,
      goalTitle: goal.title,
      checkpointId: checkpoint.id,
      timestamp: checkpoint.timestamp,
      summary: checkpoint.summary,
      checks: checkpoint.checks,
      filesChanged: checkpoint.filesChanged,
    })))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, 8), [goals]);
  const flash = (message: string) => { setNotice(message); window.setTimeout(() => setNotice(''), 2200); };

  const promptBytes = useMemo(() => new TextEncoder().encode(taskPrompt).length, [taskPrompt]);

  const xPerm = permissions.find((p) => p.name === 'X')?.value ?? 'Ask';
  const xReady = running && workspaceValid !== false && xPerm !== 'Blocked';
  const liveXRuns = useMemo(() => recentXRuns.filter((run) => run.status === 'queued' || run.status === 'running'), [recentXRuns]);
  const xPendingTasks = useMemo(() => bridgeState?.pendingTasks.filter((task) => task.routedTo === 'x') ?? [], [bridgeState?.pendingTasks]);
  const remotePendingTasks = useMemo(() => bridgeState?.pendingTasks.filter((task) => task.routedTo !== 'x') ?? [], [bridgeState?.pendingTasks]);
  const codexPerm = permissions.find((p) => p.name === 'Codex')?.value ?? 'Ask';
  const antigravityPerm = permissions.find((p) => p.name === 'Antigravity')?.value ?? 'Ask';

  const setPermissionEnabled = (permissionName: 'X' | 'Codex' | 'Antigravity', enabled: boolean) => {
    const nextValue: Permission = enabled ? 'Ask' : 'Blocked';
    setPermissions((current) => {
      const next = current.map((item) => item.name === permissionName ? { ...item, value: nextValue } : item);
      void window.controlApp.saveSettings({ permissions: Object.fromEntries(next.map((item) => [item.name, item.value])) });
      return next;
    });
    flash(`${permissionName} ${enabled ? 'enabled' : 'disabled'} for new work`);
  };

  const connectorItems = useMemo<AIConnectorItem[]>(() => {
    const xAvailable = running && workspaceValid !== false;
    const gptSignedIn = bridgeState?.signedIn === true;
    const gptEnabled = bridgeState?.enabled === true;
    const gptConnected = bridgeState?.connected === true;
    const codexAvailable = codexStatus?.available === true;
    const claudeAvailable = claudeStatus?.available === true;
    const antiAvailable = executorStatus?.available === true;

    return [
      {
        id: 'x',
        name: 'X',
        badge: 'X',
        role: 'Local coder · code_change / code_inspect',
        detail: xAvailable ? 'Hearth server and workspace are ready' : 'Start Hearth server and verify workspace',
        state: xPerm === 'Blocked' ? 'Disabled' : xAvailable ? 'Ready' : 'Offline',
        tone: xPerm === 'Blocked' ? 'disabled' : xAvailable ? 'ready' : 'offline',
        enabled: xPerm !== 'Blocked',
        canToggle: true,
        hint: xPerm,
      },
      {
        id: 'gpt',
        name: 'GPT',
        badge: 'G',
        role: 'ChatGPT / Remote Bridge',
        detail: gptConnected ? 'Remote Bridge connected to Hearth' : gptSignedIn ? 'Signed in; bridge is not connected' : 'Sign in from Remote Inbox to connect',
        state: !gptSignedIn ? 'Not connected' : !gptEnabled ? 'Disabled' : gptConnected ? 'Connected' : 'Offline',
        tone: !gptSignedIn ? 'unavailable' : !gptEnabled ? 'disabled' : gptConnected ? 'connected' : 'offline',
        enabled: gptEnabled,
        canToggle: gptSignedIn,
        busy: bridgeBusy,
        hint: gptSignedIn ? (gptEnabled ? 'Bridge on' : 'Bridge off') : 'Sign in first',
      },
      {
        id: 'codex',
        name: 'Codex',
        badge: 'C',
        role: 'Specialist continuation · Codex CLI',
        detail: codexAvailable ? 'Codex CLI detected; specialist authorization still required' : 'Codex CLI is not available on this Mac',
        state: !codexAvailable ? 'Unavailable' : codexPerm === 'Blocked' ? 'Disabled' : 'Available',
        tone: !codexAvailable ? 'unavailable' : codexPerm === 'Blocked' ? 'disabled' : 'ready',
        enabled: codexAvailable && codexPerm !== 'Blocked',
        canToggle: codexAvailable,
        hint: codexAvailable ? codexPerm : 'CLI missing',
      },
      {
        id: 'anti',
        name: 'Anti',
        badge: 'A',
        role: 'Antigravity · general execution',
        detail: antiAvailable ? 'Antigravity executor is available' : 'Antigravity executor is unavailable',
        state: antigravityPerm === 'Blocked' ? 'Disabled' : antiAvailable ? 'Connected' : 'Offline',
        tone: antigravityPerm === 'Blocked' ? 'disabled' : antiAvailable ? 'connected' : 'offline',
        enabled: antigravityPerm !== 'Blocked',
        canToggle: true,
        hint: antigravityPerm,
      },
      {
        id: 'claude',
        name: 'Claude',
        badge: 'Cl',
        role: 'Claude Code · Hearth MCP (stdio)',
        detail: claudeAvailable ? 'Claude CLI detected; Hearth session not verified' : 'Claude CLI is not available on this Mac',
        state: claudeAvailable ? 'Available' : 'Unavailable',
        tone: claudeAvailable ? 'ready' : 'unavailable',
        enabled: false,
        canToggle: false,
        hint: claudeAvailable ? 'CLI detected' : 'CLI missing',
      },
    ];
  }, [running, workspaceValid, xPerm, bridgeState?.signedIn, bridgeState?.enabled, bridgeState?.connected, bridgeBusy, codexStatus?.available, claudeStatus?.available, codexPerm, executorStatus?.available, antigravityPerm]);

  const setConnectorEnabled = (connectorId: AIConnectorItem['id'], enabled: boolean) => {
    if (connectorId === 'x') {
      setPermissionEnabled('X', enabled);
      return;
    }
    if (connectorId === 'codex') {
      setPermissionEnabled('Codex', enabled);
      return;
    }
    if (connectorId === 'anti') {
      setPermissionEnabled('Antigravity', enabled);
      return;
    }
    if (connectorId === 'gpt') {
      if (!bridgeState?.signedIn || bridgeBusy || bridgeState.enabled === enabled) return;
      void toggleBridge();
    }
  };

  const rotateXPerm = () => {
    const index = permissions.findIndex((p) => p.name === 'X');
    if (index !== -1) rotatePermission(index);
  };

  const rotateAntigravityPerm = () => {
    const index = permissions.findIndex((p) => p.name === 'Antigravity');
    if (index !== -1) rotatePermission(index);
  };

  const formatElapsed = (created?: string, completed?: string) => {
    if (!created) return '—';
    const start = new Date(created).getTime();
    const end = completed ? new Date(completed).getTime() : Date.now();
    const sec = Math.max(0, Math.floor((end - start) / 1000));
    const mins = Math.floor(sec / 60);
    const remainingSec = sec % 60;
    return mins > 0 ? `${mins}m ${remainingSec}s` : `${remainingSec}s`;
  };

  const toggleServer = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (running) {
        const state = await window.controlApp.stopServer();
        if (state) {
          setRunning(state.running);
          setPort(state.port);
          setPid(state.pid);
        }
      } else {
        const state = await window.controlApp.startServer({ workspace, port });
        if (state) {
          setRunning(state.running);
          setPort(state.port);
          setPid(state.pid);
        }
      }
    } catch (error) {
      flash(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const rotatePermission = (index: number) => {
    const options: Permission[] = ['Allow', 'Ask', 'Blocked'];
    setPermissions((current) => {
      if (current[index]?.disabled) return current;
      const next = current.map((item, itemIndex) => itemIndex === index ? { ...item, value: options[(options.indexOf(item.value) + 1) % options.length] } : item);
      void window.controlApp.saveSettings({ permissions: Object.fromEntries(next.map((item) => [item.name, item.value])) });
      return next;
    });
  };

  const setInvestMode = async (mode: InvestModeName) => {
    if (investBusy) return;
    setInvestBusy(true);
    setInvestError('');
    try {
      const next = await window.controlApp.investModeSet(mode);
      setInvestStatus((current) => current ? { ...current, mode: next } : null);
      flash(`Invest mode changed to ${mode.replace('_', ' ')}`);
    } catch (error) {
      setInvestError(error instanceof Error ? error.message : String(error));
    } finally {
      setInvestBusy(false);
    }
  };

  const useInvestKillSwitch = async () => {
    if (investBusy) return;
    setInvestBusy(true);
    setInvestError('');
    try {
      const next = await window.controlApp.investModeKillSwitch();
      setInvestStatus((current) => current ? { ...current, mode: next } : null);
      flash('Invest stopped and returned to OFF');
    } catch (error) {
      setInvestError(error instanceof Error ? error.message : String(error));
    } finally {
      setInvestBusy(false);
    }
  };

  const saveDemoRiskConfig = async () => {
    if (investBusy) return;
    setInvestBusy(true);
    setInvestError('');
    try {
      const number = (value: string, field: string) => {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) throw new Error(`${field} is required`);
        return parsed;
      };
      const next = await window.controlApp.investRiskConfigSet({
        risk_fraction_per_trade: number(demoRiskForm.riskPerTradePct, 'Risk per trade') / 100,
        max_daily_loss_fraction: number(demoRiskForm.maxDailyLossPct, 'Max daily loss') / 100,
        max_drawdown_fraction: number(demoRiskForm.maxDrawdownPct, 'Max drawdown') / 100,
        max_total_open_risk_fraction: number(demoRiskForm.maxOpenRiskPct, 'Max open risk') / 100,
        max_positions: number(demoRiskForm.maxPositions, 'Max positions'),
        max_spread_points: number(demoRiskForm.maxSpreadPoints, 'Max spread points'),
        max_slippage_points: number(demoRiskForm.maxSlippagePoints, 'Max slippage points'),
        min_stop_points: number(demoRiskForm.minStopPoints, 'Min stop points'),
        max_stop_points: number(demoRiskForm.maxStopPoints, 'Max stop points'),
        requested_volume: demoRiskForm.requestedVolume.trim() ? number(demoRiskForm.requestedVolume, 'Requested volume') : null,
      });
      setInvestStatus((current) => current ? { ...current, risk_config: next } : current);
      setDemoRiskDirty(false);
      flash('Demo risk rules saved');
    } catch (error) {
      setInvestError(error instanceof Error ? error.message : String(error));
    } finally {
      setInvestBusy(false);
    }
  };

  const setMarketResearchPermission = (value: Permission) => {
    setPermissions((current) => {
      const next = current.map((item) => item.name === 'MarketResearch' ? { ...item, value } : item);
      void window.controlApp.saveSettings({ permissions: Object.fromEntries(next.map((item) => [item.name, item.value])) });
      return next;
    });
    setInvestStatus((current) => current ? {
      ...current,
      search_ai: { permission: value, ready: value !== 'Blocked', approval_required: value === 'Ask' },
    } : current);
    flash(`Market Research set to ${value}`);
  };

  const chooseWorkspace = async () => {
    if (isTaskRunning || isGoalActive) {
      flash('Cannot change workspace while a task or goal is active');
      return;
    }
    const selected = await window.controlApp.chooseWorkspace();
    if (selected) { setWorkspace(selected); flash('Workspace updated'); }
  };

  const handleRunGoal = async (goalId: string) => {
    setGoalActionBusy(true);
    try {
      const updated = await window.controlApp.goalsRun(goalId);
      setGoals((prev) => prev.map((g) => (g.id === updated.id ? updated : g)));
      flash(`Goal '${updated.title}' finished: ${updated.status}`);
    } catch (err: any) {
      flash(`Goal run error: ${err.message}`);
    } finally {
      setGoalActionBusy(false);
    }
  };

  const handlePauseGoal = async (goalId: string) => {
    try {
      const updated = await window.controlApp.goalsPause(goalId);
      setGoals((prev) => prev.map((g) => (g.id === updated.id ? updated : g)));
      flash(`Goal '${updated.title}' paused`);
    } catch (err: any) {
      flash(`Pause error: ${err.message}`);
    }
  };

  const handleResumeGoal = async (goalId: string) => {
    setGoalActionBusy(true);
    try {
      const updated = await window.controlApp.goalsResume(goalId);
      setGoals((prev) => prev.map((g) => (g.id === updated.id ? updated : g)));
      flash(`Goal '${updated.title}' resumed`);
    } catch (err: any) {
      flash(`Resume error: ${err.message}`);
    } finally {
      setGoalActionBusy(false);
    }
  };

  const handleClearGoalHistory = async () => {
    if (goalActionBusy || terminalGoalCount === 0) return;
    setGoalActionBusy(true);
    try {
      const result = await window.controlApp.goalsClearHistory();
      setGoals(result.remaining);
      if (selectedGoalId && result.removedIds.includes(selectedGoalId)) {
        setSelectedGoalId(result.remaining[0]?.id ?? null);
      }
      setShowClearGoalsConfirm(false);
      flash(`Cleared ${result.removedIds.length} completed/error Goal${result.removedIds.length === 1 ? '' : 's'}`);
    } catch (error: any) {
      flash(error?.message || 'Could not clear Goal history');
    } finally {
      setGoalActionBusy(false);
    }
  };

  const handleSignoffStep = async (goalId: string, stepId: string, action: 'complete' | 'fail') => {
    setGoalActionBusy(true);
    try {
      const updated = await window.controlApp.goalsSignoffStep({
        goalId,
        stepId,
        action,
        autoRun: action === 'complete',
      });
      setGoals((prev) => prev.map((g) => (g.id === updated.id ? updated : g)));
      flash(action === 'complete' ? 'Manual step marked complete' : 'Manual step marked failed');
    } catch (err: any) {
      flash(`Sign-off error: ${err.message}`);
    } finally {
      setGoalActionBusy(false);
    }
  };

  const handleCreateGoal = async () => {
    if (!newGoalTitle.trim() || !newGoalObjective.trim()) {
      flash('Please enter goal title and objective');
      return;
    }
    const validSteps = newGoalSteps.filter((s) => s.title.trim().length > 0);
    if (validSteps.length === 0) {
      flash('Please add at least one step with a title');
      return;
    }
    const constraints = newGoalConstraints
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);

    try {
      const created = await window.controlApp.goalsCreate({
        title: newGoalTitle.trim(),
        objective: newGoalObjective.trim(),
        workspace,
        constraints,
        steps: validSteps.map((s, idx) => ({
          id: `step-${idx + 1}`,
          title: s.title.trim(),
          description: s.description.trim(),
          route: s.route,
          required: s.required,
        })),
      });
      setGoals((prev) => [created, ...prev]);
      setSelectedGoalId(created.id);
      setShowNewGoalModal(false);
      setNewGoalTitle('');
      setNewGoalObjective('');
      setNewGoalConstraints('');
      setNewGoalSteps([{ title: '', description: '', route: 'antigravity', required: true }]);
      flash(`Goal '${created.title}' created`);
    } catch (err: any) {
      flash(`Create error: ${err.message}`);
    }
  };

  const answerApproval = async (allowedChoice: boolean) => {
    if (!approval) return;
    const { requestId, action } = approval;
    await window.controlApp.respondToApproval({ requestId, allowed: allowedChoice });
    const resolvedAt = now();
    setLogs((current) => [...current, { time: resolvedAt, source: 'approval', tone: allowedChoice ? 'success' : 'warning', message: `${allowedChoice ? 'Allowed' : 'Denied'} once: ${action}` }]);
    setApprovalEvidence((current) => recordApprovalResolved(current, requestId, allowedChoice, 'user', resolvedAt));
    // Optimistic, requestId-specific removal -- a later approval:resolved
    // for this same id (the normal server-side confirmation) is harmless
    // (removeApproval no-ops on an already-absent requestId), and this
    // never disturbs any other queued approval.
    setApprovalQueue((current) => removeApproval(current, requestId));
  };

  const refreshConnections = async (alias?: string) => {
    if (connectionsBusy) return;
    setConnectionsBusy(true);
    setConnectionsError('');
    try {
      await window.controlApp.connectionsRefresh(alias);
      setConnections(await window.controlApp.connectionsList());
    } catch (error: any) {
      setConnectionsError(error?.message || 'Connection refresh failed');
    } finally {
      setConnectionsBusy(false);
    }
  };

  const loadGitHubRepositories = async (alias: 'github:personal' | 'github:work', force = false) => {
    if (!force && githubRepoLoadedRef.current.has(alias)) return;
    setGithubRepoBusy(alias);
    setGithubRepoErrors((current) => ({ ...current, [alias]: '' }));
    try {
      const result = await window.controlApp.githubRepositories(alias);
      const repositories = Array.isArray(result?.repositories)
        ? result.repositories.filter((repo) => typeof repo.fullName === 'string' && repo.fullName)
        : [];
      setGithubRepositories((current) => ({ ...current, [alias]: repositories }));
      githubRepoLoadedRef.current.add(alias);
    } catch (error: any) {
      githubRepoLoadedRef.current.delete(alias);
      setGithubRepoErrors((current) => ({ ...current, [alias]: error?.message || 'Could not load repositories' }));
    } finally {
      setGithubRepoBusy((current) => current === alias ? null : current);
    }
  };

  const selectGitHubRepository = async (connection: ConnectionSummary, fullName: string) => {
    const alias = connection.alias as 'github:personal' | 'github:work';
    setGithubRepoBusy(alias);
    setGithubRepoErrors((current) => ({ ...current, [alias]: '' }));
    try {
      const updated = await window.controlApp.githubSetDefaultRepository({ alias, fullName: fullName || null });
      setConnections((current) => current.map((item) => item.alias === updated.alias ? updated : item));
      flash(fullName ? `Default repository: ${fullName}` : 'Default repository cleared');
    } catch (error: any) {
      setGithubRepoErrors((current) => ({ ...current, [alias]: error?.message || 'Could not select repository' }));
    } finally {
      setGithubRepoBusy((current) => current === alias ? null : current);
    }
  };

  const connectManagedConnection = async (connection: ConnectionSummary) => {
    const token = (connectionTokenInputs[connection.alias] || '').trim();
    if (!token) {
      setConnectionsError('Enter a token before connecting.');
      return;
    }
    setConnectionActionBusy(connection.alias);
    setConnectionsError('');
    try {
      if (connection.provider === 'github') {
        const alias = connection.alias as 'github:personal' | 'github:work';
        await window.controlApp.githubConnect({
          alias,
          token,
          allowPullRequestCreate: githubPrCreateInputs[connection.alias] === true,
        });
        githubRepoLoadedRef.current.delete(alias);
        setGithubSetupOpen((current) => ({ ...current, [connection.alias]: false }));
        void loadGitHubRepositories(alias, true);
      } else if (connection.provider === 'vercel') {
        await window.controlApp.vercelConnect({
          alias: 'vercel:main',
          token,
          ...(vercelTeamIdInput.trim() ? { teamId: vercelTeamIdInput.trim() } : {}),
        });
      } else {
        throw new Error('This connection uses its existing dedicated auth surface.');
      }
      setConnectionTokenInputs((current) => ({ ...current, [connection.alias]: '' }));
      setConnections(await window.controlApp.connectionsList());
    } catch (error: any) {
      setConnectionsError(error?.message || 'Connection failed');
    } finally {
      setConnectionActionBusy(null);
    }
  };

  const disconnectManagedConnection = async (connection: ConnectionSummary) => {
    setConnectionActionBusy(connection.alias);
    setConnectionsError('');
    try {
      if (connection.provider === 'github') {
        const alias = connection.alias as 'github:personal' | 'github:work';
        await window.controlApp.githubDisconnect(alias);
        githubRepoLoadedRef.current.delete(alias);
        setGithubRepositories((current) => ({ ...current, [alias]: [] }));
        setGithubRepoErrors((current) => ({ ...current, [alias]: '' }));
        setGithubSetupOpen((current) => ({ ...current, [alias]: false }));
      } else if (connection.provider === 'vercel') {
        await window.controlApp.vercelDisconnect('vercel:main');
      } else {
        throw new Error('This connection uses its existing dedicated auth surface.');
      }
      setConnectionTokenInputs((current) => ({ ...current, [connection.alias]: '' }));
      setConnections(await window.controlApp.connectionsList());
    } catch (error: any) {
      setConnectionsError(error?.message || 'Disconnect failed');
    } finally {
      setConnectionActionBusy(null);
    }
  };

  useEffect(() => {
    for (const connection of connections) {
      if (connection.provider !== 'github' || connection.status !== 'CONNECTED') continue;
      const alias = connection.alias as 'github:personal' | 'github:work';
      if (!githubRepoLoadedRef.current.has(alias)) void loadGitHubRepositories(alias);
    }
  }, [connections]);

  const navigate = (item: NavItem) => {
    setActiveNav(item);
    document.querySelector('.main-content')?.scrollTo({ top: 0 });
  };

  useEffect(() => {
    setShowTaskProgress(false);
  }, [activeTaskId]);

  const handleChatProviderChange = (provider: 'local' | 'external') => {
    setChatProvider(provider);
    setChatResult(null);
    setChatError('');
    if (provider === 'local') setChatHealth(null);
  };

  const handleLocalChatSend = async () => {
    if (chatBusy || !chatPrompt.trim()) return;
    setChatBusy(true);
    setChatResult(null);
    setChatError('');
    setChatStreamText('');
    setChatActivity([]);
    setChatTestApproval(null);
    setChatElapsedMs(0);
    setChatFollowOutput(true);
    chatStreamStartedRef.current = Date.now();
    if (chatProvider === 'local') {
      const requestId = crypto.randomUUID();
      chatRequestIdRef.current = requestId;
      setChatStreaming(true);
      window.controlApp.localChatStreamStart({ requestId, provider: 'local', messages: [{ role: 'user', content: chatPrompt.trim() }], model: chatModel, profile: chatProfile, longResponse: chatLongResponse, ollamaAvailable: Boolean(chatHealth?.ok) });
      return;
    }
    try {
      const result = await window.controlApp.localChatSend({ provider: 'external', messages: [{ role: 'user', content: chatPrompt.trim() }] });
      if (!result?.ok) setChatError(result?.error?.message || 'Provider request failed');
      else setChatResult(result);
      if (result?.response) setChatStreamText(result.response);
      setChatElapsedMs(Number.isFinite(result?.elapsedMs) ? result.elapsedMs : Math.max(0, Date.now() - chatStreamStartedRef.current));
    } catch (error: any) { setChatError(error?.message || 'Provider request failed'); }
    finally { setChatBusy(false); }
  };

  const handleLocalChatStop = () => {
    const requestId = chatRequestIdRef.current;
    setChatTestApproval(null);
    if (requestId) window.controlApp.localChatStreamStop(requestId);
  };

  const handleChatResponseScroll = () => {
    const element = chatResponseRef.current;
    if (!element) return;
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    setChatFollowOutput(nearBottom);
  };

  useEffect(() => {
    if (!approval) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        void answerApproval(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [approval]);

  const handleStartTask = async () => {
    if (startTaskLockRef.current || !taskPrompt.trim() || isTaskRunning || taskSubmitting) return;
    if (promptBytes > 65536) {
      flash('Prompt exceeds maximum 64 KiB limit');
      return;
    }
    startTaskLockRef.current = true;
    setTaskSubmitting(true);
    // Do not leave a prior task's result visible during executor startup.
    setActiveTaskId(null);
    setActiveTaskSource('Local');
    const title = taskPrompt.trim().slice(0, 96) || 'New task';
    setTaskData({
      taskId: 'pending...',
      conversationId: null,
      workspace,
      title,
      status: 'starting',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastEvent: null,
      recentEvents: [],
      lastAnswer: null,
      error: null,
      completion: null,
    });
    try {
      const res = await window.controlApp.antigravityStart({ prompt: taskPrompt.trim(), title });
      setActiveTaskId(res.taskId);
      setActiveTaskSource('Local');
      setTaskData((current) => ({
        taskId: res.taskId,
        conversationId: res.conversationId || null,
        workspace: res.workspace || workspace,
        title: current?.title || title,
        status: (res.status as AntigravityTaskData['status']) || 'running',
        createdAt: res.startedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastEvent: null,
        recentEvents: [],
        lastAnswer: null,
        error: null,
        completion: (res as any).completion || null,
      }));
      flash(`Task ${res.taskId.slice(0, 8)} started`);
    } catch (err: any) {
      const errorMsg = err?.message || 'Failed to start task';
      setTaskData((current) => ({
        taskId: current && current.taskId !== 'pending...' ? current.taskId : 'failed',
        conversationId: current?.conversationId || null,
        workspace,
        title: current?.title || title,
        status: 'error',
        createdAt: current?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastEvent: null,
        recentEvents: current?.recentEvents || [],
        lastAnswer: null,
        error: errorMsg,
        completion: null,
      }));
      flash(`Failed to start task: ${errorMsg}`);
    } finally {
      setTaskSubmitting(false);
      startTaskLockRef.current = false;
    }
  };

  const handleSendFollowUp = async () => {
    if (!followUpInput.trim() || !activeTaskId || followUpSubmitting) return;
    const msgBytes = new TextEncoder().encode(followUpInput).length;
    if (msgBytes > 65536) {
      flash('Message exceeds maximum 64 KiB limit');
      return;
    }
    setFollowUpSubmitting(true);
    try {
      // Clear the old terminal state before the next response is classified.
      setTaskData((current) => current ? { ...current, status: 'running', lastAnswer: null, error: null, completion: null } : current);
      await window.controlApp.antigravitySend({ taskId: activeTaskId, message: followUpInput.trim() });
      setFollowUpInput('');
      flash('Follow-up message sent');
      setPollTrigger((prev) => prev + 1);
    } catch (err: any) {
      flash(`Failed to send follow-up: ${err?.message || 'Unknown error'}`);
    } finally {
      setFollowUpSubmitting(false);
    }
  };

  const handleResumeTask = async () => {
    if (!activeTaskId || recoveryBusy) return;
    setRecoveryBusy(true);
    try {
      const res = await window.controlApp.antigravityResume(activeTaskId);
      setTaskData((current) => current ? {
        ...current,
        status: (res.status as AntigravityTaskData['status']) || 'running',
        error: null,
      } : null);
      flash(`Task ${activeTaskId.slice(0, 8)} resumed`);
      setPollTrigger((prev) => prev + 1);
    } catch (err: any) {
      flash(`Resume error: ${err?.message || 'Failed to resume'}`);
    } finally {
      setRecoveryBusy(false);
    }
  };

  const handleMarkTaskFailed = async () => {
    if (!activeTaskId || recoveryBusy) return;
    setRecoveryBusy(true);
    try {
      const res = await window.controlApp.antigravityMarkFailed({ taskId: activeTaskId, reason: 'Marked failed by user from recovery' });
      setTaskData(res);
      flash(`Task ${activeTaskId.slice(0, 8)} marked failed`);
    } catch (err: any) {
      flash(`Error marking failed: ${err?.message || 'Failed'}`);
    } finally {
      setRecoveryBusy(false);
    }
  };

  const handleDismissTask = async () => {
    if (!activeTaskId || recoveryBusy) return;
    setRecoveryBusy(true);
    try {
      await window.controlApp.antigravityDismiss(activeTaskId);
      setActiveTaskId(null);
      setTaskData(null);
      flash('Task dismissed from active view');
    } catch (err: any) {
      flash(`Dismiss error: ${err?.message || 'Failed'}`);
    } finally {
      setRecoveryBusy(false);
    }
  };

  const toggleBridge = async () => {
    if (bridgeBusy || !bridgeState) return;
    setBridgeBusy(true);
    try {
      const next = await window.controlApp.bridgeSetEnabled(!bridgeState.enabled);
      setBridgeState(next);
      flash(`Remote Bridge ${next.enabled ? 'Enabled' : 'Disabled'}`);
    } catch (err: any) {
      flash(`Failed to toggle bridge: ${err?.message || 'Unknown error'}`);
    } finally {
      setBridgeBusy(false);
    }
  };

  const handleBridgeAuth = async () => {
    if (bridgeBusy || !bridgeEmail.trim() || bridgePassword.length < 8) return;
    setBridgeBusy(true);
    try {
      if (bridgeAuthMode === 'sign-up') {
        const result = await window.controlApp.bridgeSignUp({ email: bridgeEmail.trim(), password: bridgePassword });
        if (result.needsEmailVerification) {
          flash('Check your email, then sign in');
          setBridgeAuthMode('sign-in');
        } else {
          setBridgeState(await window.controlApp.bridgeGetState());
          flash('Hearth is connected to Supabase');
        }
      } else {
        setBridgeState(await window.controlApp.bridgeSignIn({ email: bridgeEmail.trim(), password: bridgePassword }));
        flash('Hearth is connected to Supabase');
      }
      setBridgePassword('');
    } catch (err: any) {
      flash(err?.message || 'Could not connect to Supabase');
    } finally {
      setBridgeBusy(false);
    }
  };

  const handleBridgeSignOut = async () => {
    if (bridgeBusy) return;
    setBridgeBusy(true);
    try {
      setBridgeState(await window.controlApp.bridgeSignOut());
      setBridgePassword('');
      flash('Signed out and Remote Bridge disabled');
    } finally {
      setBridgeBusy(false);
    }
  };

  // Project X Remote Tasks handlers -- mirror the bridge handlers above but
  // against the SEPARATE publicTasks* IPC namespace/session.
  const handlePublicXSaveKey = async () => {
    if (publicXBusy || !publicXAnonKey.trim()) return;
    setPublicXBusy(true);
    try {
      setPublicXState(await window.controlApp.publicTasksSaveAnonKey(publicXAnonKey.trim()));
      flash('Project X publishable key saved');
    } catch (err: any) {
      flash(err?.message || 'Could not save the Project X key');
    } finally {
      setPublicXBusy(false);
    }
  };

  const handlePublicXAuth = async () => {
    if (publicXBusy || !publicXEmail.trim() || publicXPassword.length < 8) return;
    setPublicXBusy(true);
    try {
      if (publicXAuthMode === 'sign-up') {
        const result = await window.controlApp.publicTasksSignUp({ email: publicXEmail.trim(), password: publicXPassword });
        if (result.needsEmailVerification) {
          flash('Check your email, then sign in');
          setPublicXAuthMode('sign-in');
        } else {
          setPublicXState(await window.controlApp.publicTasksGetState());
          flash('Hearth is connected to Project X');
        }
      } else {
        setPublicXState(await window.controlApp.publicTasksSignIn({ email: publicXEmail.trim(), password: publicXPassword }));
        flash('Hearth is connected to Project X');
      }
      setPublicXPassword('');
    } catch (err: any) {
      flash(err?.message || 'Could not connect to Project X');
    } finally {
      setPublicXBusy(false);
    }
  };

  const handlePublicXSignOut = async () => {
    if (publicXBusy) return;
    setPublicXBusy(true);
    try {
      setPublicXState(await window.controlApp.publicTasksSignOut());
      setPublicXPassword('');
      flash('Signed out of Project X');
    } finally {
      setPublicXBusy(false);
    }
  };

  const copyPairingSecret = async () => {
    try {
      const secret = await window.controlApp.bridgeGetPairingSecret();
      await navigator.clipboard.writeText(secret);
      flash('Pairing secret copied — store it securely');
    } catch (err: any) {
      flash(err?.message || 'Could not get pairing secret');
    }
  };

  const checkForUpdate = async () => {
    if (updateBusy) return;
    setUpdateBusy(true);
    setUpdateCheck((current) => current ? { ...current, state: 'checking', error: null } : current);
    try {
      const result = await window.controlApp.updaterCheck();
      setUpdateCheck(result);
      if (result.state === 'update_available') flash(`Update ${result.available?.version} is available`);
    } catch (err: any) {
      flash(err?.message || 'Could not check for updates');
    } finally {
      setUpdateBusy(false);
    }
  };

  const prepareUpdate = async () => {
    if (updateBusy || updateCheck?.state !== 'update_available' || !updateCheck.available) return;
    setUpdateBusy(true);
    setUpdateCheck((current) => current ? { ...current, state: 'downloading', error: null } : current);
    try {
      const result = await window.controlApp.updaterPrepare();
      setUpdateCheck(result);
      if (result.state === 'update_ready') flash(`Update ${result.available?.version} is ready to install`);
    } catch (err: any) {
      setUpdateCheck((current) => current ? { ...current, state: 'error', error: err?.message || 'Could not prepare update' } : current);
    } finally {
      setUpdateBusy(false);
    }
  };

  const chooseUpdateDirectory = async () => {
    if (updateBusy) return;
    const info = await window.controlApp.updaterChooseDirectory();
    setUpdaterInfo(info);
    setUpdateBusy(true);
    try {
      setUpdateCheck(await window.controlApp.updaterCheckLocal());
    } finally {
      setUpdateBusy(false);
    }
  };

  const installUpdate = async () => {
    if (updateBusy || updateCheck?.state !== 'update_ready' || !updateCheck.available) return;
    setUpdateBusy(true);
    setUpdateCheck((current) => current ? { ...current, state: 'installing', error: null } : current);
    try {
      const result = await window.controlApp.updaterInstall();
      if (result.blocked) {
        setUpdateCheck((current) => current ? { ...current, state: 'update_ready', error: null } : current);
        setUpdateBusy(false);
        flash(result.message);
        return;
      }
      if (result.cancelled) {
        setUpdateCheck((current) => current ? { ...current, state: 'update_ready', error: null } : current);
        setUpdateBusy(false);
        return;
      }
      setUpdateCheck((current) => current ? { ...current, state: 'restarting' } : current);
    } catch (err: any) {
      setUpdateCheck((current) => current ? { ...current, state: 'error', error: err?.message || 'Install failed' } : current);
      setUpdateBusy(false);
    }
  };

  const updateStatusText: Record<UpdateStatus, string> = {
    idle: 'Ready to check', checking: 'Checking for update', up_to_date: 'Up to date', update_available: 'Update available', downloading: 'Downloading', verifying: 'Verifying', update_ready: 'Update ready', installing: 'Installing', restarting: 'Restarting', rollback: 'Rollback', error: 'Error',
  };

  const handleApproveRemoteTask = async (task: BridgeTask) => {
    if (bridgeBusy || (task.routedTo !== 'x' && isTaskRunning)) {
      flash(task.routedTo === 'x' ? 'X approval is already in progress' : 'Cannot run while another task is running');
      return;
    }
    setBridgeBusy(true);
    if (task.routedTo !== 'x') {
      setActiveTaskId(null);
      setActiveTaskSource('Remote');
      setTaskData({ taskId: 'pending', conversationId: null, workspace, title: task.title || 'Remote task', status: 'pending', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastEvent: null, recentEvents: [], lastAnswer: null, error: null, completion: null });
    }
    try {
      const res = await window.controlApp.bridgeApproveTask(task.id);
      if (res.routedTo === 'x') {
        setActiveXRequestId(res.taskId);
        setActiveXStatus({ found: true, request_id: res.taskId, queue_id: res.queueId, queue_status: 'pending' });
        setTaskCenterTab('x');
        setReviewTask(null);
        flash('X task approved and queued (' + (res.queueId || res.taskId) + ')');
      } else {
        setTaskData(null);
        setActiveTaskId(res.taskId);
        setActiveTaskSource('Remote');
        setReviewTask(null);
        setTaskCenterTab('antigravity');
        flash('Remote task approved (' + res.taskId + ')');
      }
    } catch (err: any) {
      if (task.routedTo !== 'x') setTaskData(null);
      flash('Failed to approve task: ' + (err?.message || 'Unknown error'));
    } finally {
      setBridgeBusy(false);
    }
  };

  const handleRejectRemoteTask = async (task: BridgeTask) => {
    if (bridgeBusy) return;
    setBridgeBusy(true);
    try {
      await window.controlApp.bridgeRejectTask(task.id);
      setReviewTask(null);
      flash('Remote task rejected');
    } catch (err: any) {
      flash(`Failed to reject task: ${err?.message || 'Unknown error'}`);
    } finally {
      setBridgeBusy(false);
    }
  };

  // Importing a remote Goal only creates it locally (status 'ready') -- it
  // does NOT run anything and does NOT grant X approval. goals:updated adds
  // it to the existing Goals list; the user still presses Run there and
  // still sees the existing, unmodified Goal-level X approval prompt.
  const handleImportRemoteGoalRequest = async (goalRequest: GoalRequestCard) => {
    if (goalRequestBusy) return;
    setGoalRequestBusy(true);
    try {
      const res = await window.controlApp.bridgeApproveGoalRequest(goalRequest.id);
      setReviewGoalRequest(null);
      flash(`Remote Goal imported (${res.goalId}). Open Goals to review and press Run.`);
    } catch (err: any) {
      flash(`Failed to import remote Goal: ${err?.message || 'Unknown error'}`);
    } finally {
      setGoalRequestBusy(false);
    }
  };

  const handleRejectRemoteGoalRequest = async (goalRequest: GoalRequestCard) => {
    if (goalRequestBusy) return;
    setGoalRequestBusy(true);
    try {
      await window.controlApp.bridgeRejectGoalRequest(goalRequest.id);
      setReviewGoalRequest(null);
      flash('Remote Goal request rejected');
    } catch (err: any) {
      flash(`Failed to reject remote Goal request: ${err?.message || 'Unknown error'}`);
    } finally {
      setGoalRequestBusy(false);
    }
  };

  const v2CoordinatorDisplay = getV2CoordinatorDisplay(investStatus?.v2);

  // Goals is one destination with two faces: the Goals themselves, and the
  // machinery that carried them out. The machinery is a tab, never a nav item.
  const renderGoalsHeader = (status?: ReactNode) => (
    <header className="control-center-header">
      <div className="control-center-title-row">
        <div>
          <p className="kicker">HEARTH WORK CONTROL</p>
          <h1>Goals.</h1>
          <p className="intro">{PAGE_INTRO.Goals}</p>
        </div>
        {status}
      </div>
      <div className="control-center-tabs" role="tablist" aria-label="Goals sections">
        {GOALS_TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={goalsTab === tab}
            className={goalsTab === tab ? 'active' : ''}
            onClick={() => setGoalsTab(tab)}
          >
            <Icon name={tab === 'Goals' ? 'flag' : 'console'} />
            <span>{tab === 'Goals' ? 'Goals' : 'Activity'}</span>
            {tab === 'Goals' && !!bridgeState?.pendingGoalRequests?.length && <em>{bridgeState.pendingGoalRequests.length}</em>}
          </button>
        ))}
      </div>
    </header>
  );

  return (
    <div className="app-frame calm-control">
      <div className="titlebar-drag-region" aria-hidden="true">
        <div className="window-drag-handle" />
      </div>
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark"><span /><span /><span /></div><div><strong>Hearth</strong><small>Local Control</small></div></div>
        <nav aria-label="Primary navigation">
          {navGroups.map((group) => (
            <div className="nav-group" key={group.label}>
              <p className="nav-label">{group.label}</p>
              <div className="nav-group-items">
                {group.items.map((item) => {
                  const itemActive = activeNav === item.name;
                  const itemLabel = item.label ?? item.name;
                  return (
                    <button key={item.name} aria-label={itemLabel} aria-current={itemActive ? 'page' : undefined} title={itemLabel} className={itemActive ? 'active' : ''} onClick={() => navigate(item.name)}>
                      <Icon name={item.icon} />
                      <span>{itemLabel}</span>
                      {itemActive && <i />}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-badge"><span /> Local connection only</div>
          <button className="theme-switch" onClick={() => setDark((current) => !current)} aria-label={`Use ${dark ? 'light' : 'dark'} mode`}><span><Icon name="sun" /></span><span><Icon name="moon" /></span><i className={dark ? 'to-dark' : ''} /></button>
          <p>Hearth Control · {updaterInfo ? `v${updaterInfo.currentVersion}` : 'loading build…'}</p>
        </div>
      </aside>

      <main className="main-content">
        <div className="calm-topbar"><span>Hearth Control <span aria-hidden="true">/</span> <strong>{activeNav === 'Goals' ? `Goals / ${goalsTab}` : activeNav === 'System' ? `System / ${systemTab}` : activeNav}</strong></span><span className="calm-server-state"><i className={running ? 'online' : ''} />{running ? 'Local server online' : 'Local server offline'}</span></div>
        {activeNav === 'Chat' ? (
          <ChatPage
            chatProvider={chatProvider}
            chatModel={chatModel}
            chatModels={chatModels}
            chatProfile={chatProfile}
            chatPrompt={chatPrompt}
            chatBusy={chatBusy}
            chatError={chatError}
            chatResult={chatResult}
            chatStreaming={chatStreaming}
            chatStreamText={chatStreamText}
            chatElapsedMs={chatElapsedMs}
            chatLongResponse={chatLongResponse}
            chatFollowOutput={chatFollowOutput}
            chatHealth={chatHealth}
            chatActivity={chatActivity}
            chatTestApproval={chatTestApproval}
            chatExpandedCode={chatExpandedCode}
            chatContext={chatContext}
            chatContextLoading={chatContextLoading}
            chatContextError={chatContextError}
            showChatContext={showChatContext}
            chatResponseRef={chatResponseRef}
            setChatModel={setChatModel}
            setChatProfile={setChatProfile}
            setChatPrompt={setChatPrompt}
            setChatLongResponse={setChatLongResponse}
            setChatFollowOutput={setChatFollowOutput}
            setChatExpandedCode={setChatExpandedCode}
            setChatTestApproval={setChatTestApproval}
            setShowChatContext={setShowChatContext}
            handleChatProviderChange={handleChatProviderChange}
            handleChatResponseScroll={handleChatResponseScroll}
            handleLocalChatSend={handleLocalChatSend}
            handleLocalChatStop={handleLocalChatStop}
            toggleChatContext={toggleChatContext}
            LocalChatResponse={LocalChatResponse}
          />
        ) : activeNav === 'Invest' ? (
          <InvestPage
            investStatus={investStatus}
            investBusy={investBusy}
            investError={investError}
            demoRiskForm={demoRiskForm}
            setDemoRiskForm={setDemoRiskForm}
            setDemoRiskDirty={setDemoRiskDirty}
            showV1History={showV1History}
            setShowV1History={setShowV1History}
            saveDemoRiskConfig={saveDemoRiskConfig}
            setInvestMode={setInvestMode}
            setMarketResearchPermission={setMarketResearchPermission}
            useInvestKillSwitch={useInvestKillSwitch}
            v2CoordinatorDisplay={v2CoordinatorDisplay}
          />
        ) : activeNav === 'Goals' && goalsTab === 'Activity' ? (
          <GoalsActivityPage
            renderGoalsHeader={renderGoalsHeader}
            navigate={navigate}
            workspace={workspace}
            chooseWorkspace={chooseWorkspace}
            isGoalActive={isGoalActive}
            isTaskRunning={isTaskRunning}
            flash={flash}
            formatElapsed={formatElapsed}
            executorStatus={executorStatus}
            taskCenterTab={taskCenterTab}
            setTaskCenterTab={setTaskCenterTab}
            taskPrompt={taskPrompt}
            setTaskPrompt={setTaskPrompt}
            promptBytes={promptBytes}
            taskSubmitting={taskSubmitting}
            handleStartTask={handleStartTask}
            taskData={taskData}
            activeTaskSource={activeTaskSource}
            showTaskProgress={showTaskProgress}
            setShowTaskProgress={setShowTaskProgress}
            followUpInput={followUpInput}
            setFollowUpInput={setFollowUpInput}
            followUpSubmitting={followUpSubmitting}
            handleSendFollowUp={handleSendFollowUp}
            handleResumeTask={handleResumeTask}
            handleDismissTask={handleDismissTask}
            handleMarkTaskFailed={handleMarkTaskFailed}
            recoveryBusy={recoveryBusy}
            xPerm={xPerm}
            xReady={xReady}
            rotateXPerm={rotateXPerm}
            xPendingTasks={xPendingTasks}
            activeXStatus={activeXStatus}
            liveXRuns={liveXRuns}
            recentXRuns={recentXRuns}
            antigravityPerm={antigravityPerm}
            rotateAntigravityPerm={rotateAntigravityPerm}
            bridgeState={bridgeState}
            bridgeBusy={bridgeBusy}
            toggleBridge={toggleBridge}
            bridgeAuthMode={bridgeAuthMode}
            setBridgeAuthMode={setBridgeAuthMode}
            bridgeEmail={bridgeEmail}
            setBridgeEmail={setBridgeEmail}
            bridgePassword={bridgePassword}
            setBridgePassword={setBridgePassword}
            handleBridgeAuth={handleBridgeAuth}
            handleBridgeSignOut={handleBridgeSignOut}
            copyPairingSecret={copyPairingSecret}
            publicXState={publicXState}
            remotePendingTasks={remotePendingTasks}
            handleApproveRemoteTask={handleApproveRemoteTask}
            handleRejectRemoteTask={handleRejectRemoteTask}
            setReviewTask={setReviewTask}
          />
        ) : activeNav === 'Goals' ? (
          <GoalsPage
            renderGoalsHeader={renderGoalsHeader}
            workspace={workspace}
            chooseWorkspace={chooseWorkspace}
            isGoalActive={isGoalActive}
            isTaskRunning={isTaskRunning}
            approvalQueue={approvalQueue}
            goals={goals}
            selectedGoal={selectedGoal}
            terminalGoalCount={terminalGoalCount}
            setSelectedGoalId={setSelectedGoalId}
            setShowNewGoalModal={setShowNewGoalModal}
            setShowClearGoalsConfirm={setShowClearGoalsConfirm}
            goalActionBusy={goalActionBusy}
            handleRunGoal={handleRunGoal}
            handlePauseGoal={handlePauseGoal}
            handleResumeGoal={handleResumeGoal}
            handleSignoffStep={handleSignoffStep}
            bridgeState={bridgeState}
            publicXState={publicXState}
            goalRequestBusy={goalRequestBusy}
            handleImportRemoteGoalRequest={handleImportRemoteGoalRequest}
            handleRejectRemoteGoalRequest={handleRejectRemoteGoalRequest}
            setReviewGoalRequest={setReviewGoalRequest}
          />
        ) : activeNav === 'Connections' ? (
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
        ) : (
          <>
            <header className="page-header" id="overview">
              <div><p className="kicker">{activeNav === 'Overview' ? 'YOUR LOCAL CONTROL CENTER' : 'SYSTEM'}</p><h1>{activeNav === 'Overview' ? 'A clear view of your work.' : 'System.'}</h1><p className="intro">{PAGE_INTRO[activeNav]}</p></div>
              <div className={`connection-pill ${running ? 'online' : ''}`}><span /> MCP Server · {running ? 'Running' : 'Offline'}</div>
            </header>

            {activeNav === 'System' && (
              <div className="control-center-tabs" role="tablist" aria-label="System sections">
                {SYSTEM_TABS.map((tab) => (
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
        )}
        <footer><span>System operates locally on this Mac</span><span>Hearth MCP tools · 1 Executor registered</span></footer>
      </main>

      {showClearGoalsConfirm && (
        <div className="approval-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setShowClearGoalsConfirm(false); }}>
          <section className="approval-dialog goal-clear-dialog" role="dialog" aria-modal="true" aria-labelledby="clear-goals-heading">
            <div className="approval-icon"><Icon name="flag" /></div>
            <p className="section-kicker">GOAL HISTORY</p>
            <h2 id="clear-goals-heading">Clear terminal Goal history?</h2>
            <p className="approval-note">
              This permanently removes {terminalGoalCount} completed/error Goal{terminalGoalCount === 1 ? '' : 's'} from local Hearth history.
              Draft, ready, running, waiting, and paused Goals are preserved.
            </p>
            <div className="approval-actions">
              <button type="button" className="deny-button" disabled={goalActionBusy} onClick={() => setShowClearGoalsConfirm(false)}>Cancel</button>
              <button type="button" className="clear-confirm-button" disabled={goalActionBusy || terminalGoalCount === 0} onClick={() => void handleClearGoalHistory()}>
                {goalActionBusy ? 'Clearing…' : 'Clear history'}
              </button>
            </div>
          </section>
        </div>
      )}

      {showNewGoalModal && (
        <div className="approval-backdrop" role="presentation">
          <section className="approval-dialog goal-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="new-goal-heading">
            <div className="approval-icon"><Icon name="flag" /></div>
            <p className="section-kicker">GOAL CREATION</p>
            <h2 id="new-goal-heading">Create New Goal</h2>

            <div className="goal-form-group">
              <label>Goal Title</label>
              <input
                placeholder="e.g. Audit Repository and Verify Tests"
                value={newGoalTitle}
                onChange={(e) => setNewGoalTitle(e.target.value)}
              />
            </div>

            <div className="goal-form-group">
              <label>Objective</label>
              <textarea
                placeholder="Describe the ultimate objective of this multi-step goal..."
                rows={3}
                value={newGoalObjective}
                onChange={(e) => setNewGoalObjective(e.target.value)}
              />
            </div>

            <div className="goal-form-group">
              <label>Constraints (optional, comma-separated)</label>
              <input
                placeholder="e.g. No git commit, strictly read-only, tests must pass"
                value={newGoalConstraints}
                onChange={(e) => setNewGoalConstraints(e.target.value)}
              />
            </div>

            <div className="goal-form-group">
              <label>Execution Steps ({newGoalSteps.length})</label>
              {newGoalSteps.map((st, i) => (
                <div key={i} className="goal-step-editor-item">
                  <div className="goal-step-editor-row">
                    <input
                      placeholder={`Step ${i + 1} Title`}
                      value={st.title}
                      onChange={(e) => {
                        const next = [...newGoalSteps];
                        next[i] = { ...next[i], title: e.target.value };
                        setNewGoalSteps(next);
                      }}
                    />
                    <select
                      value={st.route}
                      onChange={(e) => {
                        const next = [...newGoalSteps];
                        next[i] = { ...next[i], route: e.target.value as StepRoute };
                        setNewGoalSteps(next);
                      }}
                    >
                      <option value="antigravity">Antigravity</option>
                      <option value="mcp">MCP Tool</option>
                      <option value="manual">Manual</option>
                    </select>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '10px', textTransform: 'none' }}>
                      <input
                        type="checkbox"
                        checked={st.required}
                        onChange={(e) => {
                          const next = [...newGoalSteps];
                          next[i] = { ...next[i], required: e.target.checked };
                          setNewGoalSteps(next);
                        }}
                      />
                      Req
                    </label>
                    {newGoalSteps.length > 1 && (
                      <button
                        type="button"
                        className="goal-step-remove-btn"
                        onClick={() => setNewGoalSteps(newGoalSteps.filter((_, idx) => idx !== i))}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                  <input
                    placeholder="Step description or instruction..."
                    value={st.description}
                    onChange={(e) => {
                      const next = [...newGoalSteps];
                      next[i] = { ...next[i], description: e.target.value };
                      setNewGoalSteps(next);
                    }}
                  />
                </div>
              ))}
              <button
                type="button"
                className="remote-action-btn review"
                style={{ alignSelf: 'flex-start', marginTop: '4px' }}
                onClick={() => setNewGoalSteps([...newGoalSteps, { title: '', description: '', route: 'antigravity', required: true }])}
              >
                + Add Step
              </button>
            </div>

            <div className="approval-actions">
              <button className="deny-button" type="button" onClick={() => setShowNewGoalModal(false)}>Cancel</button>
              <button className="allow-button" type="button" onClick={handleCreateGoal}>Create Goal</button>
            </div>
          </section>
        </div>
      )}

      {reviewTask && (
        <div className="approval-backdrop" role="presentation">
          <section className="approval-dialog review-dialog" role="dialog" aria-modal="true" aria-labelledby="review-task-title">
            <div className="approval-icon"><Icon name="radio" /></div>
            <p className="section-kicker">REMOTE TASK REVIEW</p>
            <h2 id="review-task-title">{reviewTask.title || 'Remote Task'}</h2>
            <div className="review-meta-row">
              <span>Source: <strong>{reviewTask.source}</strong></span>
              <span>Received: <strong>{new Date(reviewTask.createdAt).toLocaleTimeString()}</strong></span>
              {reviewTask.requestId && <span>Request ID: <code>{reviewTask.requestId}</code></span>}
            </div>
            <div className="review-prompt-container">
              <label>Full Prompt ({new TextEncoder().encode(reviewTask.prompt).length.toLocaleString()} bytes)</label>
              <div className="review-prompt-text">{reviewTask.prompt}</div>
            </div>
            <div className="approval-actions">
              <button className="deny-button" onClick={() => setReviewTask(null)}>Close</button>
              <button
                className="deny-button"
                style={{ borderColor: 'var(--rose)', color: 'var(--rose)' }}
                disabled={bridgeBusy}
                onClick={() => handleRejectRemoteTask(reviewTask)}
              >
                Reject Task
              </button>
              <button
                className="allow-button"
                autoFocus
                disabled={reviewTask.routedTo === 'x' ? bridgeBusy : (bridgeBusy || isTaskRunning || !executorStatus?.available || antigravityPerm === 'Blocked')}
                onClick={() => handleApproveRemoteTask(reviewTask)}
              >
                Approve & Run
              </button>
            </div>
          </section>
        </div>
      )}

      {reviewGoalRequest && (
        <div className="approval-backdrop" role="presentation">
          <section className="approval-dialog review-dialog" role="dialog" aria-modal="true" aria-labelledby="review-goal-request-title">
            <div className="approval-icon"><Icon name="flag" /></div>
            <p className="section-kicker">REMOTE GOAL REVIEW</p>
            <h2 id="review-goal-request-title">{reviewGoalRequest.title}</h2>
            <div className="review-meta-row">
              <span>Workspace: <code>{reviewGoalRequest.workspace}</code></span>
              <span>Received: <strong>{new Date(reviewGoalRequest.createdAt).toLocaleTimeString()}</strong></span>
              <span>{reviewGoalRequest.stepCount} step{reviewGoalRequest.stepCount === 1 ? '' : 's'} ({reviewGoalRequest.xStepCount} X)</span>
            </div>
            <div className="review-prompt-container">
              <label>Objective</label>
              <div className="review-prompt-text">{reviewGoalRequest.objective}</div>
            </div>
            {reviewGoalRequest.constraints.length > 0 && (
              <div className="review-prompt-container">
                <label>Constraints</label>
                <div className="review-prompt-text">{reviewGoalRequest.constraints.join(', ')}</div>
              </div>
            )}
            <div className="review-prompt-container">
              <label>Ordered Steps</label>
              <div className="review-prompt-text">
                {reviewGoalRequest.stepTitles.map((title, i) => <div key={i}>{i + 1}. {title}</div>)}
              </div>
            </div>
            <p className="approval-note">Importing only adds this Goal to your local Goals list. It does not run and does not grant X approval -- you still press Run there, and the existing Goal-level X approval prompt still applies.</p>
            <div className="approval-actions">
              <button className="deny-button" onClick={() => setReviewGoalRequest(null)}>Close</button>
              <button
                className="deny-button"
                style={{ borderColor: 'var(--rose)', color: 'var(--rose)' }}
                disabled={goalRequestBusy}
                onClick={() => handleRejectRemoteGoalRequest(reviewGoalRequest)}
              >
                Reject
              </button>
              <button
                className="allow-button"
                autoFocus
                disabled={goalRequestBusy}
                onClick={() => handleImportRemoteGoalRequest(reviewGoalRequest)}
              >
                Import
              </button>
            </div>
          </section>
        </div>
      )}

      {approval && <div className="approval-backdrop" role="presentation">
        <section className="approval-dialog" role="alertdialog" aria-modal="true" aria-labelledby="approval-title">
          <div className="approval-icon"><Icon name="lock" /></div>
          <p className="section-kicker">PERMISSION REQUEST</p>
          <h2 id="approval-title">Allow {approval.permission} access?</h2>
          <p className="approval-action">{approval.action}</p>
          <p className="approval-note">This approval applies to this request only.</p>
          <div className="approval-actions"><button className="deny-button" onClick={() => answerApproval(false)}>Deny</button><button className="allow-button" autoFocus onClick={() => answerApproval(true)}>Allow once</button></div>
        </section>
      </div>}
      <div className={`toast ${notice ? 'visible' : ''}`} role="status">{notice}</div>
    </div>
  );
}