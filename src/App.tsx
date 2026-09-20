import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import StorageAudit from './StorageAudit';
import './calm-control.css';
import AIConnectorPanel, { type AIConnectorItem } from './components/AIConnectorPanel';
import GitHubConnectionCard from './components/GitHubConnectionCard';

type Permission = 'Allow' | 'Ask' | 'Blocked';
type NavItem = 'Overview' | 'Console' | 'Local Chat' | 'Invest' | 'Storage Audit' | 'Task Console' | 'Goals' | 'Workspace' | 'Permissions' | 'Logs' | 'AI Connectors' | 'Updates';
type IconName = 'grid' | 'folder' | 'lock' | 'terminal' | 'moon' | 'sun' | 'chevron' | 'activity' | 'copy' | 'server' | 'console' | 'radio' | 'flag' | 'check' | 'plus';

const Icon = ({ name }: { name: IconName }) => {
  const paths: Record<IconName, ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></>,
    folder: <path d="M3.5 6.5h6l2-2h9a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-17a2 2 0 0 1-2-2v-10a2 2 0 0 1 2-2Z"/>,
    lock: <><rect x="4" y="10" width="16" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
    terminal: <><path d="m5 8 4 4-4 4"/><path d="M12 17h6"/></>,
    moon: <path d="M20.5 15.6A8.6 8.6 0 0 1 8.4 3.5 8.7 8.7 0 1 0 20.5 15.6Z"/>,
    sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></>,
    chevron: <path d="m9 18 6-6-6-6"/>,
    activity: <path d="M3 12h4l2.2-7 4.3 14 2.3-7H21"/>,
    copy: <><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></>,
    server: <><rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/></>,
    console: <><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></>,
    radio: <><path d="M4.93 19.07A10 10 0 0 1 2 12a10 10 0 0 1 2.93-7.07"/><path d="M19.07 4.93A10 10 0 0 1 22 12a10 10 0 0 1-2.93 7.07"/><path d="M7.76 16.24A6 6 0 0 1 6 12a6 6 0 0 1 1.76-4.24"/><path d="M16.24 7.76A6 6 0 0 1 18 12a6 6 0 0 1-1.76 4.24"/><circle cx="12" cy="12" r="2"/></>,
    flag: <><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></>,
    check: <polyline points="20 6 9 17 4 12"/>,
    plus: <><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></>,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
};

type LogEntry = { time: string; source: string; message: string; tone: string };
type ApprovalRequest = { requestId: string; permission: string; action: string };
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

const navGroups: Array<{ label: string; items: Array<{ name: NavItem; icon: IconName }> }> = [
  {
    label: 'OPERATE',
    items: [
      { name: 'Overview', icon: 'grid' },
      { name: 'Console', icon: 'activity' },
      { name: 'Task Console', icon: 'console' },
      { name: 'Goals', icon: 'flag' },
    ],
  },
  {
    label: 'AI',
    items: [
      { name: 'AI Connectors', icon: 'activity' },
      { name: 'Local Chat', icon: 'radio' },
      { name: 'Invest', icon: 'activity' },
    ],
  },
  {
    label: 'SYSTEM',
    items: [
      { name: 'Workspace', icon: 'folder' },
      { name: 'Permissions', icon: 'lock' },
      { name: 'Logs', icon: 'terminal' },
      { name: 'Storage Audit', icon: 'folder' },
      { name: 'Updates', icon: 'server' },
    ],
  },
];

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

  // Task Console states
  const [executorStatus, setExecutorStatus] = useState<AntigravityStatus | null>(null);
  const [codexStatus, setCodexStatus] = useState<{ available: boolean } | null>(null);
  const [taskPrompt, setTaskPrompt] = useState('');
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [activeTaskSource, setActiveTaskSource] = useState<'Local' | 'Remote'>('Local');
  const [taskData, setTaskData] = useState<AntigravityTaskData | null>(null);
  const [taskSubmitting, setTaskSubmitting] = useState(false);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [followUpInput, setFollowUpInput] = useState('');
  const [followUpSubmitting, setFollowUpSubmitting] = useState(false);
  const [pollTrigger, setPollTrigger] = useState(0);
  const [, setNowTick] = useState(Date.now());

  // Experimental Local Chat states; isolated from Task Console lifecycle.
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
  const [chatActivity, setChatActivity] = useState<Array<{ type: string; skill: string; elapsedMs?: number; resultCount?: number; stage?: string; relativePath?: string; profile?: string; label?: string; timeoutMs?: number; pid?: number | null; status?: string; exitCode?: number | null; passedCount?: number; testCount?: number; outputTruncated?: boolean; processStillRunning?: boolean }>>([]);
  const [chatTestApproval, setChatTestApproval] = useState<{ requestId: string; profile: string; label: string; timeoutMs: number } | null>(null);
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
      window.controlApp.bridgeGetState().catch(() => null),
      window.controlApp.publicTasksGetState().catch(() => null),
      window.controlApp.updaterGetInfo().catch(() => null),
      window.controlApp.updaterCheck().catch(() => null),
      window.controlApp.goalsList().catch(() => []),
      window.controlApp.antigravityListTasks().catch(() => []),
      window.controlApp.connectionsList().catch(() => []),
      window.controlApp.investStatusGet().catch(() => null),
    ]).then(([settings, state, executor, codex, bridge, publicX, updateInfo, update, goalsList, taskList, connectionList, invest]) => {
      if (!active) return;
      if (settings.workspace) setWorkspace(settings.workspace);
      setPort(settings.port);
      setDark(settings.theme === 'dark');
      setPermissions((current) => current.map((item) => ({ ...item, value: settings.permissions[item.name] ?? item.value })));
      setRunning(state.running);
      setPid(state.pid);
      if (executor) setExecutorStatus(executor);
      if (codex) setCodexStatus(codex);
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
    if (activeNav !== 'Local Chat' || chatProvider !== 'local') return;
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
    if (activeNav !== 'Local Chat') return;
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
        role: 'Claude connector',
        detail: 'No first-class Claude connector is installed in Hearth yet',
        state: 'Not connected',
        tone: 'unavailable',
        enabled: false,
        canToggle: false,
        hint: 'Not installed',
      },
    ];
  }, [running, workspaceValid, xPerm, bridgeState?.signedIn, bridgeState?.enabled, bridgeState?.connected, bridgeBusy, codexStatus?.available, codexPerm, executorStatus?.available, antigravityPerm]);

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
    if (bridgeBusy || isTaskRunning) {
      flash('Cannot run while another task is running');
      return;
    }
    setBridgeBusy(true);
    setActiveTaskId(null);
    setActiveTaskSource('Remote');
    setTaskData({ taskId: 'pending', conversationId: null, workspace, title: task.title || 'Remote task', status: 'pending', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastEvent: null, recentEvents: [], lastAnswer: null, error: null, completion: null });
    try {
      const res = await window.controlApp.bridgeApproveTask(task.id);
      setTaskData(null);
      if (res.routedTo === 'x') {
        // X tracks its own run progress via the X queue, not this
        // Antigravity-shaped task panel -- leave it showing no active task.
        setActiveTaskId(null);
        setReviewTask(null);
        flash(`Remote X task approved and queued (${res.taskId})`);
      } else {
        setActiveTaskId(res.taskId);
        setActiveTaskSource('Remote');
        setReviewTask(null);
        flash(`Remote task approved (${res.taskId})`);
      }
    } catch (err: any) {
      setTaskData(null);
      flash(`Failed to approve task: ${err?.message || 'Unknown error'}`);
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
                {group.items.map((item) => (
                  <button key={item.name} aria-label={item.name} aria-current={activeNav === item.name ? 'page' : undefined} title={item.name} className={activeNav === item.name ? 'active' : ''} onClick={() => navigate(item.name)}>
                    <Icon name={item.icon} />
                    <span>{item.name}</span>
                    {activeNav === item.name && <i />}
                  </button>
                ))}
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
        <div className="calm-topbar"><span>Hearth Control <span aria-hidden="true">/</span> <strong>{activeNav}</strong></span><span className="calm-server-state"><i className={running ? 'online' : ''} />{running ? 'Local server online' : 'Local server offline'}</span></div>
        {activeNav === 'Storage Audit' ? <StorageAudit /> : activeNav === 'Local Chat' ? (
          <div className="local-chat-view">
            <header className="page-header">
              <div>
                <p className="kicker">EXPERIMENTAL LOCAL CHAT</p>
                <h1>Local Chat.</h1>
                <p className="intro">Choose a provider explicitly for this request. No task or durable job is created by Local Chat.</p>
              </div>
              <div className="local-chat-header-actions"><button type="button" className="context-button" aria-expanded={showChatContext} onClick={() => void toggleChatContext()}>Context</button><div className={`connection-pill ${chatProvider === 'local' && chatHealth?.ok ? 'online' : ''}`}><span /> {chatProvider === 'local' ? `Ollama · ${chatHealth?.ok ? 'Available' : 'Unavailable'}` : 'External provider'}</div></div>
            </header>

            <section className="local-chat-panel">
              <div className="local-chat-controls">
                <div className="local-chat-field">
                  <label>Provider</label>
                  <div className="local-chat-toggle" role="group" aria-label="Chat provider">
                    <button type="button" className={chatProvider === 'local' ? 'selected' : ''} onClick={() => handleChatProviderChange('local')}>Local</button>
                    <button type="button" className={chatProvider === 'external' ? 'selected' : ''} onClick={() => handleChatProviderChange('external')}>External</button>
                  </div>
                </div>
                {chatProvider === 'local' ? (
                  <>
                    <div className="local-chat-field">
                      <label htmlFor="local-chat-model">Model</label>
                      <select id="local-chat-model" value={chatModel} onChange={(event) => setChatModel(event.target.value)} disabled={!chatHealth?.ok || chatModels.length === 0}>
                        {chatModels.length === 0 ? <option value={chatModel}>{chatHealth?.ok ? 'No local models found' : 'Ollama unavailable'}</option> : chatModels.map((model) => <option key={model} value={model}>{model}</option>)}
                      </select>
                    </div>
                    <div className="local-chat-field">
                      <label htmlFor="local-chat-profile">Profile</label>
                      <select id="local-chat-profile" value={chatProfile} onChange={(event) => setChatProfile(event.target.value as 'fast' | 'normal' | 'deep')}>
                        <option value="fast">FAST</option>
                        <option value="normal">NORMAL</option>
                        <option value="deep">DEEP</option>
                      </select>
                    </div>
                  </>
                ) : <p className="local-chat-external-note">External uses the existing provider path and its configured permission.</p>}
              </div>

              <div className="local-chat-field">
                <label htmlFor="local-chat-prompt">Prompt</label>
                <textarea id="local-chat-prompt" rows={6} value={chatPrompt} onChange={(event) => setChatPrompt(event.target.value)} placeholder="Write a message for the selected provider…" />
              </div>
              <div className="local-chat-actions">
                <span className={`local-chat-status ${chatProvider === 'local' && chatHealth?.ok ? 'available' : ''}`}>{chatProvider === 'local' ? (chatHealth?.ok ? 'Ollama available' : 'Ollama unavailable') : 'External selected'}</span>
                {chatStreaming ? <button type="button" className="local-chat-stop-button" onClick={handleLocalChatStop}>Stop</button> : <button type="button" className="run-task-button" disabled={chatBusy || !chatPrompt.trim() || (chatProvider === 'local' && !chatHealth?.ok)} onClick={() => void handleLocalChatSend()}>{chatBusy ? 'Sending…' : 'Send'}</button>}
              </div>
              {chatProvider === 'local' && <label className="local-chat-long-response"><input type="checkbox" checked={chatLongResponse} onChange={(event) => setChatLongResponse(event.target.checked)} /> Long response</label>}
              {chatStreaming && <div className="local-chat-generating" aria-live="polite">{chatTestApproval ? 'Waiting for test approval' : chatActivity.some((item) => item.type === 'test_running') ? 'Running test' : 'Generating…'} · {Math.round(chatElapsedMs / 1000)}s</div>}
              {chatTestApproval && <section className="local-chat-test-confirmation" aria-label="Run test confirmation"><div><strong>Run test?</strong><p>{chatTestApproval.label}</p><small>Profile: {chatTestApproval.profile} · Timeout: {Math.round(chatTestApproval.timeoutMs / 1000)}s</small></div><div className="local-chat-test-confirmation-actions"><button type="button" onClick={() => { window.controlApp.localChatTestApproval(chatTestApproval.requestId, false); setChatTestApproval(null); }}>Cancel</button><button type="button" onClick={() => { window.controlApp.localChatTestApproval(chatTestApproval.requestId, true); setChatTestApproval(null); }}>Run Test</button></div></section>}
              {chatActivity.length > 0 && <section className="local-chat-activity" aria-label="Local AI activity"><strong>{chatStreaming ? 'Working' : 'Activity'}</strong>{chatActivity.map((item, index) => <div key={`${item.skill}-${index}`} className="local-chat-activity-row"><span>{item.type === 'skill_completed' || item.type === 'evidence_complete' || item.type === 'test_finished' && item.status === 'passed' ? '✓' : item.type === 'skill_failed' || item.type === 'evidence_incomplete' || item.type === 'test_finished' && item.status !== 'passed' ? '!' : '●'}</span><span>{item.type === 'evidence_complete' ? 'Evidence trace complete' : item.type === 'evidence_incomplete' ? 'Evidence trace incomplete' : item.type === 'evidence_progress' ? `${item.stage || 'SOURCE'} · ${item.relativePath || item.skill}` : item.type === 'test_approval_requested' ? `Waiting for approval · ${item.label} · ${Math.round((item.elapsedMs || 0) / 1000)}s` : item.type === 'test_approval_cancelled' ? `Test not run · ${item.label}` : item.type === 'test_running' ? `Running ${item.label} · PID ${item.pid ?? 'pending'} · ${Math.round((item.elapsedMs || 0) / 1000)}s` : item.type === 'test_finished' ? `${item.label} ${item.status}${item.passedCount === undefined || item.testCount === undefined ? '' : ` · ${item.passedCount}/${item.testCount}`}${['cancelled', 'timed_out'].includes(item.status || '') || item.exitCode === null || item.exitCode === undefined ? '' : ` · exit ${item.exitCode}`}${item.processStillRunning ? ' · manual review required' : ''}` : item.type === 'skill_started' ? `Running ${item.skill}` : `${item.skill}${item.resultCount === undefined ? '' : ` · ${item.resultCount} results`}`}</span></div>)}</section>}
              {chatError && <div className="local-chat-error" role="alert">{chatError}</div>}
              {(chatStreamText || chatResult) && <section className="local-chat-result" aria-live="polite"><div className="local-chat-result-meta"><span>{chatResult?.provider || 'ollama'}</span><span>{chatResult?.model || chatModel}</span><span>{chatProvider === 'local' ? chatProfile.toUpperCase() : 'EXTERNAL'}</span><span>{chatStreaming ? `${Math.round(chatElapsedMs / 1000)}s` : `${chatResult?.elapsedMs || chatElapsedMs} ms`}</span></div><div ref={chatResponseRef} className="local-chat-response-viewer" onScroll={handleChatResponseScroll}><LocalChatResponse text={chatStreamText || chatResult?.response || ''} onExpand={(code, language) => setChatExpandedCode({ code, language })} /></div>{!chatFollowOutput && chatStreaming && <button type="button" className="local-chat-bottom-button" onClick={() => { setChatFollowOutput(true); if (chatResponseRef.current) chatResponseRef.current.scrollTop = chatResponseRef.current.scrollHeight; }}>↓ Bottom</button>}{chatResult?.doneReason === 'length' && <small className="local-chat-output-warning">Response reached the output limit.</small>}</section>}
              {showChatContext && <section className="local-chat-context-inspector" aria-label="Local AI context"><header><strong>Context supplied to Local AI</strong><button type="button" onClick={() => setShowChatContext(false)}>Close</button></header>{chatContextLoading ? <p>Loading current context…</p> : chatContextError ? <p role="alert">{chatContextError}</p> : chatContext && <div><h3>Runtime</h3><pre>{chatContext.runtime}</pre><h3>Capabilities</h3><p><strong>Available:</strong> {chatContext.capabilities.available.join('; ')}</p><p><strong>Not available:</strong> {chatContext.capabilities.unavailable.join('; ')}</p><h3>Project</h3><pre>{chatContext.project}</pre><h3>Safety</h3><p>{chatContext.safety}</p><h3>Response Style</h3><p>{chatContext.responseStyle}</p></div>}</section>}
              {chatExpandedCode && <div className="local-chat-code-modal" role="dialog" aria-modal="true"><div className="local-chat-code-modal-header"><span>{chatExpandedCode.language || 'code'}</span><button type="button" onClick={() => setChatExpandedCode(null)}>Close</button></div><pre><code>{chatExpandedCode.code}</code></pre></div>}
            </section>
          </div>
        ) : activeNav === 'Invest' ? (
          <div className="invest-view">
            <header className="page-header">
              <div>
                <p className="kicker">XAU/USD INVEST</p>
                <h1>Invest control.</h1>
                <p className="intro">Monitor XAU/USD, keep evidence, and control the demo-only execution boundary. Live-account execution is blocked.</p>
              </div>
              <div className={`connection-pill ${investStatus?.mode.mode !== 'OFF' ? 'online' : ''}`}><span /> {investStatus?.mode.mode.replace('_', ' ') || 'Loading'}</div>
            </header>

            <section className="invest-status-grid" aria-label="Invest services">
              <article><span className={`invest-status-dot ${investStatus?.mt5_bridge.snapshots.length ? 'ready' : ''}`} /><div><small>MT5 BRIDGE</small><strong>{investStatus?.mt5_bridge.snapshots.length ? 'Connected' : investStatus?.mt5_bridge.running ? 'Waiting for price' : 'Offline'}</strong><p>{investStatus?.mt5_bridge.snapshots.length ? `${investStatus.mt5_bridge.snapshots[0].broker_symbol} · ${investStatus.mt5_bridge.snapshots.map((item) => item.timeframe).join(', ')}` : 'Open the MT5 EA to stream XAUUSD data.'}</p></div></article>
              <article><span className={`invest-status-dot ${investStatus?.search_ai.ready ? 'ready' : ''}`} /><div><small>SEARCH AI</small><strong>{investStatus?.search_ai.ready ? investStatus.search_ai.approval_required ? 'Ask before research' : 'Ready' : 'Blocked'}</strong><p>Uses fixed-origin market sources. It does not require Browser automation.</p></div></article>
              <article><span className={`invest-status-dot ${investStatus?.invest_ai.ready ? 'ready' : ''}`} /><div><small>INVEST AI</small><strong>{investStatus?.monitor.state === 'analyzing' ? 'Analyzing' : investStatus?.invest_ai.ready ? 'Ready' : 'Unavailable'}</strong><p>AI narrative cannot change direction, confidence, entry, stop loss, or take profit.</p></div></article>
              <article><span className={`invest-status-dot ${investStatus?.execution.transport_ready && investStatus?.execution.enabled && investStatus?.execution.executor_account_type === 'demo' ? 'ready' : ''}`} /><div><small>DEMO EXECUTOR</small><strong>{investStatus?.execution.enabled ? investStatus.execution.transport_ready ? investStatus.execution.executor_account_type === 'demo' ? 'Armed' : 'Blocked: live account' : 'Waiting for V3 EA' : 'Inactive'}</strong><p>Only internal READY + Risk-approved V2 signals may use the demo command channel. No renderer order button exists.</p></div></article>
            </section>

            <section className="soft-panel invest-controller" aria-labelledby="invest-mode-title">
              <div className="panel-title"><div><p className="section-kicker">MODE CONTROLLER</p><h2 id="invest-mode-title">Operating mode</h2></div><span className="invest-session-label">Startup: {investStatus?.mode.startup_mode || 'OFF'}</span></div>
              <div className="invest-mode-buttons" role="group" aria-label="Invest operating mode">
                {(['OFF', 'MONITOR', 'DEMO_AUTO'] as InvestModeName[]).map((mode) => <button type="button" key={mode} className={investStatus?.mode.mode === mode ? 'selected' : ''} aria-pressed={investStatus?.mode.mode === mode} disabled={investBusy || !investStatus} onClick={() => void setInvestMode(mode)}>{mode === 'DEMO_AUTO' ? 'DEMO AUTO' : mode}</button>)}
              </div>
              <div className="invest-mode-explanation">
                <strong>{investStatus?.mode.mode === 'MONITOR' ? 'Monitor selected' : investStatus?.mode.mode === 'DEMO_AUTO' ? 'Demo Auto selected for this session' : 'Invest is off'}</strong>
                <p>{investStatus?.mode.mode === 'MONITOR' ? `Watching ${investStatus.monitor.timeframe} for a new MT5 bar. ${investStatus.monitor.state === 'waiting_for_permission' ? 'Waiting for Market Research approval.' : investStatus.monitor.state === 'permission_denied' ? 'Research was denied for this bar.' : investStatus.monitor.state === 'permission_blocked' ? 'Market Research is blocked.' : investStatus.monitor.state === 'waiting_for_price' ? 'Waiting for MT5 price data.' : investStatus.monitor.state === 'analyzing' ? 'Search AI and Invest AI are analyzing now.' : 'A Mac notification will appear after a new signal is saved.'}` : investStatus?.mode.mode === 'DEMO_AUTO' ? 'The demo execution latch is enabled only for this session. Orders still require an internal READY V2 signal bound to an APPROVE/RESIZE Risk decision and a connected demo-only V3 EA. Automatic V2 coordinator routing is not wired yet.' : 'Market data may still arrive, but Invest will not start analysis or trading.'}</p>
              </div>

              <div className="invest-permission-control">
                <div><strong>Market Research permission</strong><small>Separate from the unavailable Browser automation tool.</small></div>
                <div role="group" aria-label="Market Research permission">
                  {(['Allow', 'Ask', 'Blocked'] as Permission[]).map((value) => <button type="button" key={value} className={investStatus?.search_ai.permission === value ? 'selected' : ''} aria-pressed={investStatus?.search_ai.permission === value} onClick={() => setMarketResearchPermission(value)}>{value}</button>)}
                </div>
              </div>

              <div className="invest-safety-row">
                <div><strong>Startup safety is active</strong><p>DEMO AUTO always falls back to OFF after restart. KILL SWITCH blocks new demo orders but does not close an already-open position. Live accounts are rejected.</p></div>
                <button type="button" className="invest-kill-switch" disabled={investBusy || investStatus?.mode.mode === 'OFF'} onClick={() => void useInvestKillSwitch()}>KILL SWITCH</button>
              </div>
              {investError && <p className="invest-error" role="alert">{investError}</p>}
            </section>

            <section className="soft-panel invest-journal" aria-labelledby="invest-journal-title">
              <div className="panel-title"><div><p className="section-kicker">SIGNAL JOURNAL</p><h2 id="invest-journal-title">Latest analysis</h2></div><span className="invest-session-label">{investStatus?.signals.length || 0} saved</span></div>
              {investStatus?.signals.length ? <div className="invest-signal-list">{investStatus.signals.map((signal) => <article key={signal.id}>
                <div className="invest-signal-heading"><span className={`invest-direction direction-${signal.direction.toLowerCase()}`}>{signal.direction}</span><strong>{signal.confidence}%</strong><time>{new Date(signal.created_at).toLocaleString()}</time></div>
                <div className="invest-signal-levels"><span>Entry <strong>{signal.entry_zone.length ? signal.entry_zone.join('–') : '—'}</strong></span><span>SL <strong>{signal.stop_loss ?? '—'}</strong></span><span>TP <strong>{signal.targets[0] ?? '—'}</strong></span><span>Risk <strong>{signal.risk_level}</strong></span></div>
                {signal.summary && <p>{signal.summary}</p>}
                {signal.risks[0] && <small>Risk: {signal.risks[0]}</small>}
              </article>)}</div> : <div className="invest-journal-empty"><strong>No signals yet</strong><p>Set Market Research to Allow or approve the request, select MONITOR, and keep the MT5 EA streaming XAUUSD H1 data.</p></div>}
            </section>

            <section className="soft-panel invest-journal" aria-labelledby="invest-execution-title">
              <div className="panel-title"><div><p className="section-kicker">EXECUTION JOURNAL</p><h2 id="invest-execution-title">Demo execution evidence</h2></div><span className="invest-session-label">{investStatus?.executions.length || 0} saved</span></div>
              {investStatus?.executions.length ? <div className="invest-signal-list">{investStatus.executions.map((execution) => <article key={execution.request_id}>
                <div className="invest-signal-heading"><span className={`invest-direction direction-${execution.side === 'BUY' ? 'up' : 'down'}`}>{execution.side}</span><strong>{execution.state}</strong><time>{new Date(execution.updated_at).toLocaleString()}</time></div>
                <div className="invest-signal-levels"><span>Strategy <strong>{execution.strategy}</strong></span><span>Volume <strong>{execution.request.volume}</strong></span><span>SL <strong>{execution.request.stop_loss}</strong></span><span>TP <strong>{execution.request.take_profit}</strong></span></div>
                <small>{execution.receipt?.reason || execution.error || execution.request_id}</small>
              </article>)}</div> : <div className="invest-journal-empty"><strong>No demo executions yet</strong><p>Execution evidence appears here only after the internal V2 coordinator submits a READY, Risk-approved signal to the demo-only executor.</p></div>}
            </section>
          </div>
        ) : activeNav === 'Console' ? (
          <div className="operations-console-view">
            <header className="page-header" id="console">
              <div>
                <p className="kicker">OPERATIONAL CONSOLE</p>
                <h1>Console.</h1>
                <p className="intro">Read-only operational state for connections, approvals, and evidence.</p>
              </div>
              <div className={`connection-pill ${attentionConnections === 0 && healthyConnections > 0 ? 'online' : ''}`}>
                <span /> {healthyConnections}/{connections.length} connections healthy
              </div>
            </header>

            <section className="metrics console-metrics" aria-label="Operational overview">
              <article><div className="metric-icon sage"><Icon name="activity" /></div><div><span>Connections</span><strong>{healthyConnections} healthy</strong><small>{attentionConnections > 0 ? `${attentionConnections} require attention` : 'No provider errors reported'}</small></div></article>
              <article><div className="metric-icon sand"><Icon name="lock" /></div><div><span>Approvals</span><strong>{approvalQueue.length} pending</strong><small>Decisions remain in the existing approval dialog</small></div></article>
              <article><div className="metric-icon blue"><Icon name="terminal" /></div><div><span>Session evidence</span><strong>{logs.length + approvalEvidence.length} events</strong><small>Current app session only</small></div></article>
              <article><div className="metric-icon purple"><Icon name="flag" /></div><div><span>Durable evidence</span><strong>{durableGoalEvidence.length} checkpoints</strong><small>Latest persisted Goal checkpoints</small></div></article>
            </section>

            <div className="console-grid">
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

              <section className="soft-panel console-approvals-panel" aria-labelledby="console-approvals-title">
                <div className="panel-title">
                  <div><p className="section-kicker">APPROVALS</p><h2 id="console-approvals-title">Pending requests</h2></div>
                  <span className="panel-meta">Status only</span>
                </div>
                {approvalQueue.length === 0 ? (
                  <div className="console-empty"><Icon name="lock" /><p>No pending approvals</p><small>New requests still open the existing one-time approval dialog.</small></div>
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
                <p className="console-boundary-note">The Console cannot allow or deny requests. Decisions remain owned by the existing approval lifecycle.</p>
              </section>

              <section className="soft-panel console-evidence-panel" aria-labelledby="console-evidence-title">
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
            </div>
          </div>
        ) : activeNav === 'Task Console' ? (
          <div className="task-console-view">
            <header className="page-header">
              <div>
                <p className="kicker">ANTIGRAVITY TASK CONSOLE</p>
                <h1>Task Console.</h1>
                <p className="intro">Dispatch natural language instructions to Antigravity executor.</p>
              </div>
              <div className={`connection-pill ${executorStatus?.available ? 'online' : ''}`}>
                <span /> Executor · {executorStatus?.available ? 'Connected' : 'Unavailable'}
              </div>
            </header>

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

                <div className="task-live-summary"><strong>Latest</strong><span>{taskData.lastEvent?.summary || taskData.completion?.summary || (taskData.status === 'starting' ? 'Preparing executor…' : 'No progress update yet.')}</span><button type="button" onClick={() => document.querySelector('.task-progress-card')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })}>View Progress</button></div>

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

            {/* REMOTE INBOX SECTION */}
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
              ) : bridgeState.pendingTasks.length === 0 ? (
                <div className="remote-inbox-empty">
                  <Icon name="radio" />
                  <p>No pending remote tasks</p>
                  <small>Incoming tasks from connected clients will appear here for your review and approval.</small>
                </div>
              ) : (
                <div className="remote-tasks-list">
                  {bridgeState.pendingTasks.map((t) => (
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

              {/* PROJECT X REMOTE TASKS -- a separate connection/session from the Remote Bridge above */}
              <div className="remote-inbox-header" style={{ marginTop: '1.5rem' }}>
                <div>
                  <p className="kicker">PROJECT X</p>
                  <h2>Project X Remote Tasks</h2>
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
                    <span>A separate account from the Remote Bridge above. Your session is protected by macOS Keychain.</span>
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
                  <small>{publicXState.accountEmail}. Queued Project X tasks appear in the Remote Inbox above once approved.</small>
                </div>
              )}

              {/* PROJECT X REMOTE GOALS -- a dedicated, distinct transport from
                  the single-task Remote Tasks above. Importing only creates
                  the Goal locally (status 'ready'); it never runs anything and
                  never grants X approval -- open Goals, press Run, and the
                  existing Goal-level X approval prompt is still required. */}
              {publicXState?.signedIn && (
                <>
                  <div className="remote-inbox-header" style={{ marginTop: '1.5rem' }}>
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
              )}
            </section>
          </div>
        ) : activeNav === 'Goals' ? (
          <div className="goals-view">
            <header className="page-header">
              <div>
                <p className="kicker">HEARTH GOAL RUNNER V1</p>
                <h1>Goals.</h1>
                <p className="intro">Multi-step goal orchestration with checkpoints, lock guards, and step tracking.</p>
              </div>
              <div className={`connection-pill ${isGoalActive ? 'online' : ''}`}>
                <span /> Goal Runner · {isGoalActive ? 'Active' : 'Standing by'}
              </div>
            </header>

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
        ) : (
          <>
            <header className="page-header" id="overview">
              <div><p className="kicker">YOUR LOCAL CONTROL CENTER</p><h1>{activeNav === 'Overview' ? 'A clear view of your work.' : activeNav}</h1><p className="intro">{({ Overview: 'Monitor your workspace and choose where to work next.', Workspace: 'Choose the folder where Hearth can work.', Permissions: 'Decide which tools can act and which need your approval.', Logs: 'Follow activity from this app session.', 'AI Connectors': 'Manage the agents and services available to your workspace.', Updates: 'Check and prepare verified Hearth releases.' } as Partial<Record<NavItem, string>>)[activeNav]}</p></div>
              <div className={`connection-pill ${running ? 'online' : ''}`}><span /> MCP Server · {running ? 'Running' : 'Offline'}</div>
            </header>

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
              {([{ page: 'Task Console', title: 'Tasks', detail: 'Create and follow your work', icon: 'console' }, { page: 'Goals', title: 'Goals', detail: 'Plan work across multiple steps', icon: 'flag' }, { page: 'AI Connectors', title: 'AI Connectors', detail: 'Manage available agents', icon: 'activity' }, { page: 'Console', title: 'Connections & approvals', detail: 'Review system health and evidence', icon: 'lock' }] as Array<{page: NavItem; title: string; detail: string; icon: IconName}>).map(item => <button type="button" key={item.page} onClick={() => navigate(item.page)}><Icon name={item.icon}/><strong>{item.title}</strong><span>{item.detail}</span><Icon name="chevron"/></button>)}
            </section></>}

            <div className="dashboard-grid calm-system-page">
              {activeNav === 'Workspace' && <section className="soft-panel workspace-panel" id="workspace">
                <div className="panel-title"><div><p className="section-kicker">WORKSPACE</p><h2>Working directory</h2></div><button className="round-button" aria-label="Copy workspace path" onClick={async () => { await navigator.clipboard.writeText(workspace); flash('Workspace path copied'); }}><Icon name="copy" /></button></div>
                <div className="folder-well"><div className="folder-tab" /><div className="folder-icon"><Icon name="folder" /></div><label htmlFor="workspace-path">Current folder</label><input id="workspace-path" value={workspace} onChange={(event) => setWorkspace(event.target.value)} onBlur={() => void window.controlApp.saveSettings({ workspace })} disabled={isTaskRunning || isGoalActive} /><button onClick={chooseWorkspace} disabled={isTaskRunning || isGoalActive}>Choose folder <Icon name="chevron" /></button></div>
                <p className="panel-note">{isGoalActive ? <span style={{ color: '#8a724f' }}>🔒 Workspace is locked while a goal is active.</span> : <><span /> Changes are restricted to this directory.</>}</p>
              </section>

              }
              {activeNav === 'Permissions' && <section className="soft-panel permission-panel" id="permissions">
                <div className="panel-title"><div><p className="section-kicker">PERMISSIONS</p><h2>Tool access</h2></div><span className="panel-meta">Click to change</span></div>
                <div className="permission-list">{permissions.map((permission, index) => <button className={`permission-row${permission.disabled ? ' disabled' : ''}`} onClick={() => rotatePermission(index)} key={permission.name} disabled={permission.disabled} aria-disabled={permission.disabled}><span className="permission-copy"><strong>{permission.name}</strong><small>{permission.detail}</small></span><em className={`permission-value value-${permission.value.toLowerCase()}`}><i />{permission.value}{!permission.disabled && <Icon name="chevron" />}</em></button>)}</div>
              </section>

              }
              {activeNav === 'Updates' && <section className="soft-panel update-panel" aria-labelledby="updates-title">
                <div className="panel-title">
                  <div><p className="section-kicker">UPDATE</p><h2 id="updates-title">Hearth updates</h2></div>
                  <span className={`update-status ${updateCheck?.state ?? 'idle'}`}><i />{updateStatusText[updateCheck?.state ?? 'idle']}</span>
                </div>
                <dl className="update-facts">
                  <div><dt>Current version</dt><dd>v{updaterInfo?.currentVersion ?? '—'}</dd></div>
                  <div><dt>Current build</dt><dd title={updaterInfo?.currentBuildId}>{updaterInfo?.currentBuildId ?? '—'}</dd></div>
                  <div><dt>Build time</dt><dd>{updaterInfo?.builtAt ? new Date(updaterInfo.builtAt).toLocaleString() : 'Development build'}</dd></div>
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
              {activeNav === 'AI Connectors' && <AIConnectorPanel connectors={connectorItems} onToggle={setConnectorEnabled} />}

              {activeNav === 'Logs' && <section className="soft-panel logs-panel" id="logs">
                <div className="panel-title"><div><p className="section-kicker">ACTIVITY</p><h2>System log</h2></div><div className="log-actions"><span className="live-indicator"><i /> LIVE</span><button onClick={() => setLogs([])}>Clear log</button></div></div>
                <div className="log-well" aria-live="polite">{logs.length === 0 ? <div className="empty-state"><Icon name="terminal" /><p>No activity recorded</p><small>New system events will appear here.</small></div> : logs.map((log, index) => <div className={`log-line ${log.tone}`} key={`${log.time}-${index}`}><time>{log.time}</time><span className="log-source">{log.source}</span><p>{log.message}</p></div>)}</div>
              </section>
              }
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
