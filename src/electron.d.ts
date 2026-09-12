type PermissionValue = 'Allow' | 'Ask' | 'Blocked';
interface ControlSettings { workspace: string; port: number; theme: 'light' | 'dark'; permissions: Record<string, PermissionValue>; }
interface ServerState { running: boolean; port: number; pid: number | null; }
interface ServerEvent { type: 'state' | 'log' | 'approval' | 'bridge:state' | 'goals:updated'; state?: ServerState | BridgeState; goal?: Goal; source?: string; tone?: string; message?: string; requestId?: string; permission?: string; action?: string; }

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
}

type UpdateStatus = 'idle' | 'checking' | 'up_to_date' | 'update_ready' | 'installing' | 'restarting' | 'rollback' | 'error';
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
  updaterChooseDirectory: () => Promise<UpdaterInfo>;
  updaterInstall: () => Promise<{ state: UpdateStatus; target: string; backup: string; token: string }>;
  bridgeGetState: () => Promise<BridgeState>;
  bridgeSignUp: (credentials: { email: string; password: string }) => Promise<{ signedIn: boolean; needsEmailVerification: boolean }>;
  bridgeSignIn: (credentials: { email: string; password: string }) => Promise<BridgeState>;
  bridgeSignOut: () => Promise<BridgeState>;
  bridgeGetPairingSecret: () => Promise<string>;
  bridgeSetEnabled: (enabled: boolean) => Promise<BridgeState>;
  bridgeApproveTask: (taskId: string) => Promise<{ success: boolean; taskId: string; conversationId?: string }>;
  bridgeRejectTask: (taskId: string) => Promise<boolean>;
  goalsList: () => Promise<Goal[]>;
  goalsGet: (goalId: string) => Promise<Goal | null>;
  goalsCreate: (data: { title: string; objective: string; workspace?: string; steps: Partial<GoalStep>[]; constraints?: string[]; route?: 'mcp' | 'antigravity' | 'hybrid' }) => Promise<Goal>;
  goalsRun: (goalId: string) => Promise<Goal>;
  goalsPause: (goalId: string) => Promise<Goal>;
  goalsResume: (goalId: string) => Promise<Goal>;
  goalsSignoffStep: (options: { goalId: string; stepId: string; action?: 'complete' | 'fail'; note?: string; autoRun?: boolean }) => Promise<Goal>;
  goalsIsActive: () => Promise<boolean>;
  onServerEvent: (callback: (event: ServerEvent) => void) => () => void;
}; }
