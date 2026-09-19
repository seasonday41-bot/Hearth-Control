type PermissionValue = 'Allow' | 'Ask' | 'Blocked';
interface ControlSettings { workspace: string; port: number; theme: 'light' | 'dark'; permissions: Record<string, PermissionValue>; }
interface ServerState { running: boolean; port: number; pid: number | null; }
interface ServerEvent { type: 'state' | 'log' | 'approval' | 'approval:resolved' | 'bridge:state' | 'publicTasks:state' | 'goals:updated'; state?: ServerState | BridgeState | PublicTasksState; goal?: Goal; source?: string; tone?: string; message?: string; requestId?: string; permission?: string; action?: string; allowed?: boolean; reason?: 'user' | 'timeout' | 'aborted' | 'shutdown'; }

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
