type PermissionValue = 'Allow' | 'Ask' | 'Blocked';
interface ControlSettings { workspace: string; port: number; theme: 'light' | 'dark'; permissions: Record<string, PermissionValue>; }

type ConnectionStatus = 'UNKNOWN' | 'CONNECTED' | 'DISCONNECTED' | 'EXPIRED' | 'NEEDS_REAUTH' | 'ERROR';
interface ConnectionSummary {
  id: string;
  alias: string;
  provider: 'github' | 'supabase' | 'vercel';
  label: string;
  target: Record<string, unknown>;
  capabilities: string[];
  status: ConnectionStatus;
  account: string | null;
  defaultRepository?: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ServerState { running: boolean; port: number; pid: number | null; }
type InvestModeName = 'OFF' | 'MONITOR' | 'DEMO_AUTO';
interface InvestModeState {
  version: 'invest-mode-v1';
  mode: InvestModeName;
  startup_mode: 'OFF' | 'MONITOR';
  automatic_analysis_enabled: boolean;
  demo_auto_enabled: boolean;
  trade_execution_enabled: boolean;
  demo_session_id: string | null;
  restore_reason: string;
}
interface InvestMonitorState {
  state: 'idle' | 'waiting_for_price' | 'waiting_for_permission' | 'permission_blocked' | 'permission_denied' | 'analyzing' | 'monitoring' | 'error' | 'unavailable';
  interval_ms: number;
  timeframe: string;
  last_checked_at: string | null;
  last_signal_at: string | null;
  last_bar_as_of: string | null;
  last_error: string | null;
}
interface DemoExecutionState {
  state: 'idle' | 'executing' | 'unavailable';
  demo_session_id: string | null;
  enabled: boolean;
  transport_ready: boolean;
  executor_account_type: 'demo' | 'live' | null;
  last_execution_at: string | null;
  last_error: string | null;
}
interface DemoExecutionRecord {
  version: 'demo-execution-journal-v1';
  request_id: string;
  proposal_id: string;
  risk_decision_id: string;
  demo_session_id: string;
  strategy: 'SMC_IDM' | 'HARMONIC_PRZ';
  side: 'BUY' | 'SELL';
  state: 'PREPARED' | 'SENT' | 'FILLED' | 'REJECTED' | 'DUPLICATE' | 'UNCERTAIN';
  attempts: number;
  created_at: string;
  updated_at: string;
  request: { volume: number; reference_price: number; stop_loss: number; take_profit: number };
  receipt: null | { status: 'FILLED' | 'REJECTED' | 'DUPLICATE'; reason: string; fill_price: number | null; volume: number | null };
  error: string | null;
}
interface InvestSignal {
  version: 'invest-signal-journal-v1';
  id: string;
  symbol: 'XAUUSD';
  timeframe: string;
  market_as_of: string;
  created_at: string;
  direction: 'UP' | 'DOWN' | 'NEUTRAL';
  confidence: number;
  entry_zone: number[];
  stop_loss: number | null;
  targets: number[];
  risk_level: 'low' | 'medium' | 'high';
  summary: string;
  risks: string[];
}
interface InvestStatus {
  mode: InvestModeState;
  monitor: InvestMonitorState;
  signals: InvestSignal[];
  execution: DemoExecutionState;
  executions: DemoExecutionRecord[];
  mt5_bridge: {
    running: boolean;
    host?: string;
    http_port?: number;
    ingest_port?: number;
    snapshots: Array<{ timeframe: string; broker_symbol: string; as_of: string; age_ms: number; bar_count: number }>;
    risk_snapshot?: { account_type: 'demo' | 'live'; broker_symbol: string; as_of: string; age_ms: number; open_risk_complete: boolean } | null;
    executor_ready?: boolean;
    executor_account_type?: 'demo' | 'live' | null;
    executor_broker_symbol?: string | null;
    executor_age_ms?: number | null;
  };
  search_ai: { permission: PermissionValue; ready: boolean; approval_required: boolean };
  invest_ai: { ready: boolean };
}
interface ServerEvent { type: 'state' | 'log' | 'approval' | 'approval:resolved' | 'bridge:state' | 'publicTasks:state' | 'goals:updated' | 'invest:updated'; state?: ServerState | BridgeState | PublicTasksState; status?: InvestStatus; goal?: Goal; source?: string; tone?: string; message?: string; requestId?: string; permission?: string; action?: string; allowed?: boolean; reason?: 'user' | 'timeout' | 'aborted' | 'shutdown'; }

interface AntigravityStatus {
  available: boolean;
  agentApiPath: string | null;
  appPath: string | null;
  reason: string | null;
}

interface AntigravityTaskEvent {
  stepIndex: number;
  type: string;
  status: string | null;
  createdAt: string;
  summary: string;
}

interface AntigravityCompletion {
  status: 'done' | 'waiting' | 'error';
  normalizedStatus: 'completed' | 'waiting' | 'error';
  summary: string;
  error: string | null;
  checks: { build: 'passed' | 'failed' | 'not_run'; tests: 'passed' | 'failed' | 'not_run' };
  artifacts: string[];
  interimReason?: string | null;
}

interface AntigravityTaskData {
  taskId: string;
  conversationId: string | null;
  status: 'pending' | 'starting' | 'running' | 'waiting' | 'paused' | 'done' | 'error' | 'recovery_required';
  workspace: string;
  title: string;
  source?: string;
  remoteTaskId?: string | null;
  requestId?: string | null;
  dismissed?: boolean;
  createdAt: string;
  updatedAt: string;
  lastEvent: AntigravityTaskEvent | null;
  recentEvents: AntigravityTaskEvent[];
  lastAnswer?: string | null;
  error?: string | null;
  completion?: AntigravityCompletion | null;
}

interface BridgeTask {
  id: string;
  deviceId: string;
  source: string;
  title: string;
  prompt: string;
  status: string;
  createdAt: string;
  requestId?: string | null;
  /** Present and 'x' only for a Project X (public.tasks) row -- routes Approve through the X queue instead of Antigravity. */
  routedTo?: 'x';
}

/** Display-shaped summary of a queued public.goal_requests row -- never the raw xTask JSON. */
interface GoalRequestCard {
  id: string;
  title: string;
  objective: string;
  workspace: string;
  constraints: string[];
  stepCount: number;
  xStepCount: number;
  stepTitles: string[];
  createdAt: string;
}

interface BridgeState {
  enabled: boolean;
  deviceId: string;
  connected: boolean;
  configured: boolean;
  signedIn: boolean;
  accountEmail: string | null;
  pairingReady: boolean;
  pendingTasks: BridgeTask[];
  activeRemoteTaskId: string | null;
  pendingGoalRequests: GoalRequestCard[];
  activeGoalRequestId: string | null;
}

/** Project X's OWN auth state -- a separate namespace from BridgeState/the legacy bridge. */
interface PublicTasksState {
  configured: boolean;
  signedIn: boolean;
  accountEmail: string | null;
}

type UpdateStatus = 'idle' | 'checking' | 'up_to_date' | 'update_available' | 'downloading' | 'verifying' | 'update_ready' | 'installing' | 'restarting' | 'rollback' | 'error';
type UpdateInstallBlocker = 'X_ACTIVE' | 'GOAL_ACTIVE' | 'DURABLE_JOB_ACTIVE' | 'UPDATER_BUSY' | 'RUNTIME_STATE_UNAVAILABLE';
interface UpdaterInfo { currentVersion: string; currentBuildId: string; builtAt: string | null; updateDirectory: string; }
interface UpdateCheck extends Pick<UpdaterInfo, 'currentVersion' | 'currentBuildId'> {
  state: UpdateStatus;
  available: { version: string; buildId: string; builtAt: string; platform: string; arch: string; dmgPath: string | null } | null;
  error: string | null;
}

type GoalStatus = 'draft' | 'ready' | 'running' | 'waiting' | 'paused' | 'error' | 'completed';
type StepStatus = 'pending' | 'running' | 'waiting' | 'paused' | 'error' | 'completed' | 'skipped';
type StepRoute = 'mcp' | 'antigravity' | 'manual';

interface GoalStep {
  id: string;
  title: string;
  description: string;
  route: StepRoute;
  tool?: string | null;
  status: StepStatus;
  result?: string | null;
  required: boolean;
  dependsOn?: string[];
  startedAt?: string | null;
  finishedAt?: string | null;
  evidence?: Record<string, any>;
}

interface GoalCheckpoint {
  id: string;
  goalId: string;
  stepId: string | null;
  timestamp: string;
  summary: string;
  completedSteps: number;
  evidence: Record<string, any>;
  filesChanged: string[];
  checks: Record<string, any>;
  nextStep: string | null;
  route: StepRoute;
}

interface Goal {
  id: string;
  title: string;
  objective: string;
  workspace: string;
  status: GoalStatus;
  currentStepId: string | null;
  steps: GoalStep[];
  checkpoints: GoalCheckpoint[];
  constraints: string[];
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  error: string | null;
  route: 'mcp' | 'antigravity' | 'hybrid';
}

interface Window { controlApp: {
  platform: string;
  getSettings: () => Promise<ControlSettings>;
  saveSettings: (settings: Partial<ControlSettings>) => Promise<ControlSettings>;
  investModeGet: () => Promise<InvestModeState>;
  investModeSet: (mode: InvestModeName) => Promise<InvestModeState>;
  investModeKillSwitch: () => Promise<InvestModeState>;
  investStatusGet: () => Promise<InvestStatus>;
  connectionsList: () => Promise<ConnectionSummary[]>;
  connectionsRefresh: (alias?: string) => Promise<ConnectionSummary[]>;
  githubConnect: (request: { alias: 'github:personal' | 'github:work'; token: string; allowPullRequestCreate?: boolean }) => Promise<ConnectionSummary>;
  githubDisconnect: (alias: 'github:personal' | 'github:work') => Promise<ConnectionSummary>;
  githubRepositories: (alias: 'github:personal' | 'github:work') => Promise<{ repositories: Array<{ id: number | null; name: string | null; fullName: string | null; private: boolean; archived: boolean; defaultBranch: string | null; owner: string | null }> }>;
  githubSetDefaultRepository: (request: { alias: 'github:personal' | 'github:work'; fullName: string | null }) => Promise<ConnectionSummary>;
  vercelConnect: (request: { alias: 'vercel:main'; token: string; teamId?: string }) => Promise<ConnectionSummary>;
  vercelDisconnect: (alias: 'vercel:main') => Promise<ConnectionSummary>;
  localChatStatus: () => Promise<{ health: any; models: any }>;
  localChatContext: (request?: { model?: string; profile?: string; longResponse?: boolean; ollamaAvailable?: boolean }) => Promise<{ runtime: string; capabilities: { available: string[]; unavailable: string[] }; project: string; safety: string; responseStyle: string }>;
  storageAuditScan: () => Promise<any>;
  storageAuditReveal: (id: string) => Promise<{ ok: boolean; error?: string }>;
  onStorageAuditProgress: (callback: (progress: { area: string; path: string }) => void) => () => void;
  localChatSend: (request: { provider: 'local' | 'external'; messages: Array<{ role: string; content: string }>; model?: string; profile?: 'fast' | 'normal' | 'deep' | 'light' | 'medium' | 'high'; longResponse?: boolean; timeoutMs?: number; options?: Record<string, unknown>; think?: boolean; num_ctx?: number; num_predict?: number; temperature?: number }) => Promise<any>;
  localChatStreamStart: (request: { requestId: string; provider: 'local'; messages: Array<{ role: string; content: string }>; model?: string; profile?: 'fast' | 'normal' | 'deep' | 'light' | 'medium' | 'high'; longResponse?: boolean; timeoutMs?: number; ollamaAvailable?: boolean }) => void;
  localChatStreamStop: (requestId: string) => void;
  localChatTestApproval: (requestId: string, approved: boolean) => void;
  onLocalChatStream: (callback: (event: { type: 'chunk' | 'done' | 'error' | 'activity'; requestId: string; content?: string; result?: any; activity?: { type: string; skill: string; elapsedMs?: number; resultCount?: number; profile?: string; label?: string; timeoutMs?: number; pid?: number | null; status?: string; exitCode?: number | null; rawExitCode?: number | null; passedCount?: number; testCount?: number; outputTruncated?: boolean; processStillRunning?: boolean } }) => void) => () => void;
  chooseWorkspace: () => Promise<string | null>;
  validateWorkspace: (path: string) => Promise<{ valid: boolean; reason?: string }>;
  getServerState: () => Promise<ServerState>;
  startServer: (options: { workspace: string; port: number }) => Promise<ServerState>;
  stopServer: () => Promise<ServerState>;
  respondToApproval: (response: { requestId: string; allowed: boolean }) => Promise<boolean>;
  antigravityStatus: () => Promise<AntigravityStatus>;
  antigravityStart: (options: { prompt: string; title?: string }) => Promise<{ taskId: string; conversationId: string; status: string; startedAt: string; workspace: string }>;
  antigravityTask: (taskId: string) => Promise<AntigravityTaskData>;
  antigravitySend: (options: { taskId: string; message: string }) => Promise<{ taskId: string; conversationId: string; status: string; sentAt: string }>;
  antigravityResume: (taskId: string) => Promise<{ taskId: string; conversationId: string; status: string; resumedAt: string; workspace: string }>;
  antigravityMarkFailed: (options: { taskId: string; reason?: string }) => Promise<AntigravityTaskData>;
  antigravityDismiss: (taskId: string) => Promise<AntigravityTaskData>;
  antigravityListTasks: () => Promise<AntigravityTaskData[]>;
  updaterGetInfo: () => Promise<UpdaterInfo>;
  updaterCheck: () => Promise<UpdateCheck>;
  updaterPrepare: () => Promise<UpdateCheck>;
  updaterCheckLocal: () => Promise<UpdateCheck>;
  updaterChooseDirectory: () => Promise<UpdaterInfo>;
  updaterInstall: () => Promise<
    | { state: 'restarting'; target: string; backup: string; token: string; cancelled?: false; blocked?: false }
    | { state: 'update_ready'; cancelled: true; blocked?: false }
    | { state: 'update_ready'; blocked: true; blocker: UpdateInstallBlocker; message: string; cancelled?: false }
  >;
  bridgeGetState: () => Promise<BridgeState>;
  bridgeSignUp: (credentials: { email: string; password: string }) => Promise<{ signedIn: boolean; needsEmailVerification: boolean }>;
  bridgeSignIn: (credentials: { email: string; password: string }) => Promise<BridgeState>;
  bridgeSignOut: () => Promise<BridgeState>;
  bridgeGetPairingSecret: () => Promise<string>;
  bridgeSetEnabled: (enabled: boolean) => Promise<BridgeState>;
  bridgeApproveTask: (taskId: string) => Promise<{ success: boolean; taskId: string; conversationId?: string; routedTo?: 'x'; queueId?: string }>;
  bridgeRejectTask: (taskId: string) => Promise<boolean>;
  bridgeApproveGoalRequest: (requestId: string) => Promise<{ success: boolean; goalId: string }>;
  bridgeRejectGoalRequest: (requestId: string) => Promise<{ success: boolean }>;
  publicTasksGetState: () => Promise<PublicTasksState>;
  publicTasksSaveAnonKey: (anonKey: string) => Promise<PublicTasksState>;
  publicTasksSignUp: (credentials: { email: string; password: string }) => Promise<{ signedIn: boolean; needsEmailVerification: boolean }>;
  publicTasksSignIn: (credentials: { email: string; password: string }) => Promise<PublicTasksState>;
  publicTasksSignOut: () => Promise<PublicTasksState>;
  goalsList: () => Promise<Goal[]>;
  codexStatus: () => Promise<{ available: boolean }>;
  goalsClearHistory: () => Promise<{ removedIds: string[]; remaining: Goal[] }>;
  goalsGet: (goalId: string) => Promise<Goal | null>;
  goalsCreate: (data: { title: string; objective: string; workspace?: string; steps: Partial<GoalStep>[]; constraints?: string[]; route?: 'mcp' | 'antigravity' | 'hybrid' }) => Promise<Goal>;
  goalsRun: (goalId: string) => Promise<Goal>;
  goalsPause: (goalId: string) => Promise<Goal>;
  goalsResume: (goalId: string) => Promise<Goal>;
  goalsSignoffStep: (options: { goalId: string; stepId: string; action?: 'complete' | 'fail'; note?: string; autoRun?: boolean }) => Promise<Goal>;
  goalsReviewAcknowledge: (options: { goalId: string; reviewItemId: string; actor?: string; note?: string }) => Promise<{ goal: Goal; item: any; alreadyAcknowledged?: boolean }>;
  goalsReviewResolve: (options: { goalId: string; reviewItemId: string; action?: 'accept'; note?: string }) => Promise<{ goal: Goal; item: any; alreadyResolved?: boolean }>;
  goalsIsActive: () => Promise<boolean>;
  onServerEvent: (callback: (event: ServerEvent) => void) => () => void;
}; }
