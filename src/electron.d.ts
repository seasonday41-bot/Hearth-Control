type PermissionValue = 'Allow' | 'Ask' | 'Blocked';
interface ControlSettings { workspace: string; port: number; theme: 'light' | 'dark'; permissions: Record<string, PermissionValue>; updateDirectory: string; }
interface ConnectionSummary {
  id: string; alias: string; provider: 'github' | 'vercel'; label: string;
  status: 'UNKNOWN' | 'CONNECTED' | 'DISCONNECTED' | 'EXPIRED' | 'NEEDS_REAUTH' | 'ERROR';
  account: string | null; target: Record<string, unknown>; capabilities: string[];
  lastCheckedAt: string | null; lastError: string | null;
}
interface ServerState { running: boolean; port: number; pid: number | null; }
interface ServerEvent { type: 'state' | 'log' | 'approval' | 'approval:resolved' | 'updater:state'; state?: ServerState | string; source?: string; message?: string; requestId?: string; permission?: string; action?: string; }
interface UpdaterInfo { currentVersion: string; currentBuildId: string; currentCommit: string | null; builtAt: string | null; updateDirectory: string; }
type UpdateCheck = { state: string; error?: string | null; available?: { version: string } | null };
interface ControlApp {
  platform: string;
  getSettings(): Promise<ControlSettings>;
  saveSettings(settings: Partial<ControlSettings>): Promise<ControlSettings>;
  chooseWorkspace(): Promise<string | null>;
  validateWorkspace(path: string): Promise<{ valid: boolean; reason?: string }>;
  getWorkspaceSummary(): Promise<{ path: string; branch: string | null; dirty: boolean | null; files: Array<{ name: string; directory: boolean }> }>;
  getServerState(): Promise<ServerState>;
  getToolNames(): Promise<string[]>;
  getJobs(): Promise<Array<{ job_id: string; command: string; status: string; duration: number | null; exit_code: number | null; output_preview: string }>>;
  getLayaStatus(): Promise<{ available: boolean; connected: boolean; mode: string; provider?: string | null; model?: string | null; last_error: string | null }>;
  layaConsult(prompt: string): Promise<unknown>;
  layaReview(input: { objective: string; focus: 'ui' | 'code' }): Promise<unknown>;
  startServer(options: { workspace: string; port: number }): Promise<ServerState>;
  stopServer(): Promise<ServerState>;
  respondToApproval(response: { requestId: string; allowed: boolean }): Promise<boolean>;
  connectionsList(): Promise<ConnectionSummary[]>;
  connectionsRefresh(alias?: string): Promise<ConnectionSummary[]>;
  githubConnect(request: { alias: 'github:personal' | 'github:work'; token: string; allowPullRequestCreate?: boolean }): Promise<ConnectionSummary>;
  githubDisconnect(alias: 'github:personal' | 'github:work'): Promise<ConnectionSummary>;
  githubRepositories(alias: 'github:personal' | 'github:work'): Promise<unknown>;
  githubSetDefaultRepository(request: { alias: 'github:personal' | 'github:work'; fullName: string | null }): Promise<ConnectionSummary>;
  vercelConnect(request: { alias: 'vercel:main'; token: string; teamId?: string }): Promise<ConnectionSummary>;
  vercelDisconnect(alias: 'vercel:main'): Promise<ConnectionSummary>;
  updaterGetInfo(): Promise<UpdaterInfo>;
  updaterCheck(): Promise<UpdateCheck>;
  updaterPrepare(): Promise<UpdateCheck>;
  updaterCheckLocal(): Promise<UpdateCheck>;
  updaterChooseDirectory(): Promise<UpdaterInfo>;
  updaterInstall(): Promise<unknown>;
  onServerEvent(callback: (event: ServerEvent) => void): () => void;
}
interface Window { controlApp: ControlApp; }
