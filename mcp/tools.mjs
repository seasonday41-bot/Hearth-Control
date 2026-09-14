import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as z from 'zod/v4';
import { createWorkspaceGuard } from './workspace.mjs';
import {
  detectAntigravity,
  startAntigravityTask,
  getAntigravityTask,
  sendAntigravityMessage,
} from './executors/antigravity.mjs';
import { runXTask } from './x/run-x-task.mjs';
import { getProductionXRuntime } from './x/production-runtime.mjs';

const execFileAsync = promisify(execFile);
export const toolNames = [
  'workspace_info',
  'list_files',
  'search_files',
  'read_file',
  'write_file',
  'git_status',
  'git_diff',
  'run_command',
  'antigravity_status',
  'antigravity_start',
  'antigravity_task',
  'antigravity_send',
  'x_start',
  'x_task',
];

const text = (value) => ({ content: [{ type: 'text', text: String(value) }] });
const failure = (error) => ({ isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] });

// ---------------------------------------------------------------------------
// run_command — blocked command policy
// ---------------------------------------------------------------------------
/** Commands that are unconditionally blocked regardless of permissions. */
const BLOCKED_COMMANDS = new Set([
  'sudo', 'su', 'doas',                          // privilege escalation
  'shutdown', 'reboot', 'halt', 'poweroff', 'init', // system lifecycle
  'mkfs', 'mke2fs', 'mkswap',                    // filesystem formatting
  'dd',                                           // raw disk I/O (block entirely in v1)
]);

/**
 * Returns a human-readable block reason if the command is destructive, or
 * null if the command is permitted to proceed to permission checks.
 * @param {string} command
 * @param {string[]} args
 * @returns {string | null}
 */
const isDestructiveCommand = (command, args) => {
  if (BLOCKED_COMMANDS.has(command)) {
    return `'${command}' is blocked — high-risk system command not permitted by Hearth`;
  }
  if (command === 'rm') {
    const recursive = args.some((a) => /^-[a-zA-Z]*r/i.test(a) || a === '--recursive');
    const force = args.some((a) => /^-[a-zA-Z]*f/i.test(a) || a === '--force');
    if (recursive && force) return "'rm -rf' is blocked — irreversible recursive forced deletion";
    if (recursive) return "'rm -r' is blocked — recursive deletion is not permitted; remove individual files instead";
  }
  if (command === 'diskutil') {
    const destructiveSubcmds = ['erase', 'erasedisk', 'erasevolume', 'reformat', 'zerodisk', 'randomdisk', 'secureerase'];
    if (args[0] && destructiveSubcmds.includes(args[0].toLowerCase())) {
      return `'diskutil ${args[0]}' is blocked — destructive disk operation`;
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// search_files — ripgrep availability (cached at module load)
// ---------------------------------------------------------------------------
/** Resolves to true if ripgrep is available in $PATH. */
const rgAvailable = execFileAsync('rg', ['--version'], { timeout: 3000 }).then(() => true).catch(() => false);

/**
 * Node.js-based recursive text search — used as fallback when rg is absent.
 * Skips hidden entries, node_modules, .git, dist, build, and binary files.
 * @param {string} searchRoot   Absolute path to search within.
 * @param {string} query        Literal string to match.
 * @param {number} maxResults
 * @returns {Promise<string>}
 */
const nodeSearch = async (searchRoot, query, maxResults) => {
  const results = [];
  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.nuxt']);

  const searchDir = async (dirPath) => {
    if (results.length >= maxResults) return;
    const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (results.length >= maxResults) break;
      if (entry.name.startsWith('.') && entry.name !== '.') continue; // skip hidden
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await searchDir(fullPath);
      } else if (entry.isFile()) {
        const content = await fs.readFile(fullPath, 'utf8').catch(() => null);
        if (content === null) continue; // binary or unreadable
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (results.length >= maxResults) break;
          if (lines[i].includes(query)) {
            const rel = path.relative(searchRoot, fullPath);
            results.push(`${rel}:${i + 1}:${lines[i].slice(0, 200)}`);
          }
        }
      }
    }
  };

  await searchDir(searchRoot);
  return results.join('\n') || 'No matches';
};

// ---------------------------------------------------------------------------
// write_file — limits
// ---------------------------------------------------------------------------
const WRITE_FILE_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------
export const registerWorkspaceTools = (server, options) => {
  const guard = createWorkspaceGuard(options.workspace);
  const permissions = options.permissions ?? {};
  const requirePermission = async (name, action) => {
    const level = permissions[name] ?? (name === 'Antigravity' ? 'Ask' : 'Blocked');
    if (level === 'Allow') return;
    if (level === 'Ask' && options.requestApproval) {
      const allowed = await options.requestApproval({ permission: name, action });
      if (allowed) return;
      throw new Error(`User denied ${name} access for this request.`);
    }
    throw new Error(`${name} permission is ${level}. Change it to Allow in Hearth Control before using this tool.`);
  };

  // X production dependencies: real, SQLite-backed, shared across every MCP
  // process via the same resolved runtime database file. `options.xRuntime`
  // exists solely so tests can inject fixtures (temp SQLite path, a
  // deterministic fake ModelAdapter) without touching a real Ollama
  // instance or the real per-user runtime path -- production callers never
  // set it, and instead get the lazy per-process singleton.
  const xRuntime = options.xRuntime ?? getProductionXRuntime();

  const X_RUN_TERMINAL_EVENT_STATUSES = new Set(['completed', 'needs_review', 'failed']);

  // Best-effort transport notification for a run whose terminal truth is
  // ALREADY persisted -- `outcome.run` is exactly the row
  // XRunStore.completeRunFenced()/failRunFenced() itself just wrote (see
  // mcp/x/run-x-task.mjs's `done`). This function only ever reads that
  // already-persisted row; it never writes to XRunStore, never retries
  // persistence, and never changes `outcome`. `outcome.run` is null for
  // every non-terminal-write outcome (cancelled, ownership_lost/uncertain,
  // persistence_error, fence_rejected), so those are silently skipped by
  // construction, not by a status-name allowlist alone. Any failure here
  // (no IPC channel, a throwing `process.send`) is swallowed: a
  // notification failure must never crash the MCP process, must never be
  // mistaken for a persistence failure, and must never propagate back to
  // `admitted.done`'s own (already-settled) resolution.
  const emitXRunTerminalEvent = (outcome) => {
    try {
      const run = outcome?.run;
      if (!run || !X_RUN_TERMINAL_EVENT_STATUSES.has(run.status)) return;
      if (typeof process.send !== 'function') return;
      process.send({
        type: 'x_run_terminal',
        runId: run.runId,
        taskId: run.taskId,
        status: run.status,
        gateStatus: run.gateStatus,
        hearthOutcome: run.hearthOutcome,
        result: run.result,
        error: run.error,
      });
    } catch {
      // Best-effort notification only; never surfaces, never retried.
    }
  };
  // Attaches an observer to `done` synchronously, in the same tick
  // `runXTask` returns -- `done` is documented to always resolve, never
  // reject, but this guarantees no window exists where it could be left
  // completely unattached (e.g. if the MCP caller disconnects) and become
  // an unhandled rejection. Persistence has already fully happened by the
  // time this observer's callback runs (`done` cannot resolve until after
  // its own completeRunFenced/failRunFenced call returns) -- this callback
  // never persists anything itself, it only observes and notifies.
  const observeBackgroundCompletion = (admitted) => {
    if (admitted?.accepted && admitted.done && typeof admitted.done.then === 'function') {
      admitted.done.then(emitXRunTerminalEvent, () => {});
    }
  };

  server.registerTool('workspace_info', {
    title: 'Workspace information',
    description: 'Show the workspace root and active permission levels.',
    inputSchema: {},
  }, async () => text(JSON.stringify({ workspace: guard.root || null, permissions }, null, 2)));

  server.registerTool('list_files', {
    title: 'List files',
    description: 'List files and folders inside the configured workspace.',
    inputSchema: { path: z.string().default('.').describe('Path relative to the workspace'), limit: z.number().int().min(1).max(500).default(200) },
  }, async ({ path: relativePath, limit }) => {
    try {
      await requirePermission('Files', `List files in ${relativePath}`);
      const directory = await guard.resolveExistingPath(relativePath);
      const entries = await fs.readdir(directory, { withFileTypes: true });
      const lines = entries.slice(0, limit).map((entry) => `${entry.isDirectory() ? 'directory' : 'file'}\t${entry.name}`);
      if (entries.length > limit) lines.push(`… ${entries.length - limit} more entries`);
      return text(lines.join('\n') || '(empty directory)');
    } catch (error) { return failure(error); }
  });

  server.registerTool('read_file', {
    title: 'Read file',
    description: 'Read a UTF-8 text file inside the configured workspace.',
    inputSchema: { path: z.string().min(1).describe('File path relative to the workspace'), maxCharacters: z.number().int().min(1).max(500000).default(100000) },
  }, async ({ path: relativePath, maxCharacters }) => {
    try {
      await requirePermission('Files', `Read ${relativePath}`);
      const filePath = await guard.resolveExistingPath(relativePath);
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) throw new Error('The requested path is not a file.');
      const content = await fs.readFile(filePath, 'utf8');
      return text(content.length > maxCharacters ? `${content.slice(0, maxCharacters)}\n\n[truncated]` : content);
    } catch (error) { return failure(error); }
  });

  server.registerTool('search_files', {
    title: 'Search files',
    description: 'Search text inside the configured workspace. Uses ripgrep when available, falls back to a built-in Node.js search otherwise.',
    inputSchema: {
      query: z.string().min(1).describe('Text or regular expression to search for'),
      path: z.string().default('.').describe('Directory relative to the workspace'),
      glob: z.string().optional().describe('Optional glob such as *.ts (only applied when ripgrep is available)'),
      maxResults: z.number().int().min(1).max(500).default(100),
    },
  }, async ({ query, path: relativePath, glob, maxResults }) => {
    try {
      await requirePermission('Files', `Search for "${query}" in ${relativePath}`);
      const searchRoot = await guard.resolveExistingPath(relativePath);

      if (await rgAvailable) {
        // Fast path — ripgrep
        const args = ['--line-number', '--no-heading', '--color', 'never', '--max-count', String(maxResults)];
        if (glob) args.push('--glob', glob);
        args.push(query, searchRoot);
        try {
          const { stdout } = await execFileAsync('rg', args, { timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
          return text(stdout.trim() || 'No matches');
        } catch (error) {
          if (error && typeof error === 'object' && error.code === 1) return text('No matches');
          throw error;
        }
      } else {
        // Fallback — Node.js built-in search (literal match only)
        const result = await nodeSearch(searchRoot, query, maxResults);
        return text(result);
      }
    } catch (error) { return failure(error); }
  });

  server.registerTool('write_file', {
    title: 'Write file',
    description: 'Write UTF-8 content to a file inside the configured workspace. Files permission must be Allow.',
    inputSchema: { path: z.string().min(1).describe('File path relative to the workspace'), content: z.string().describe('Complete replacement content') },
    annotations: { destructiveHint: true },
  }, async ({ path: relativePath, content }) => {
    try {
      // 1. Permission check (Allow required for writes)
      await requirePermission('Files', `Write ${relativePath}`);

      // 2. Size guard — reject payloads larger than 10 MB
      const byteLength = Buffer.byteLength(content, 'utf8');
      if (byteLength > WRITE_FILE_MAX_BYTES) {
        throw new Error(`Content too large (${(byteLength / 1024 / 1024).toFixed(1)} MB). Maximum allowed is 10 MB.`);
      }

      // 3. Resolve writable path (workspace boundary enforced by guard)
      const filePath = await guard.resolveWritablePath(relativePath);

      // 4. Overwrite approval — if file already exists and permission is not Allow, ask
      const level = permissions['Files'] ?? 'Blocked';
      if (level !== 'Allow') {
        const exists = await fs.stat(filePath).then((s) => s.isFile()).catch(() => false);
        if (exists && options.requestApproval) {
          const allowed = await options.requestApproval({ permission: 'Files', action: `Overwrite existing file: ${path.relative(guard.root, filePath)}` });
          if (!allowed) throw new Error('User denied permission to overwrite existing file.');
        }
      }

      // 5. Write
      await fs.writeFile(filePath, content, 'utf8');
      return text(`Wrote ${byteLength} bytes to ${path.relative(guard.root, filePath)}`);
    } catch (error) { return failure(error); }
  });

  server.registerTool('git_status', {
    title: 'Git status',
    description: 'Show concise Git status for the configured workspace.',
    inputSchema: {},
  }, async () => {
    try {
      await requirePermission('Git', 'Read Git status');
      const root = await guard.resolveExistingPath('.');
      const { stdout } = await execFileAsync('git', ['-C', root, 'status', '--short'], { timeout: 10000, maxBuffer: 1024 * 1024 });
      return text(stdout.trim() || 'Working tree clean');
    } catch (error) { return failure(error); }
  });

  server.registerTool('git_diff', {
    title: 'Git diff',
    description: 'Show the current unstaged or staged Git diff inside the workspace.',
    inputSchema: { staged: z.boolean().default(false) },
  }, async ({ staged }) => {
    try {
      await requirePermission('Git', staged ? 'Read staged Git diff' : 'Read working tree Git diff');
      const root = await guard.resolveExistingPath('.');
      const args = ['-C', root, 'diff'];
      if (staged) args.push('--staged');
      const { stdout } = await execFileAsync('git', args, { timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
      return text(stdout.trim() || 'No changes');
    } catch (error) { return failure(error); }
  });

  server.registerTool('run_command', {
    title: 'Run command',
    description: 'Run one executable without a shell inside the configured workspace. Terminal permission is required. Destructive system commands are always blocked.',
    inputSchema: {
      command: z.string().min(1).describe('Executable name'),
      args: z.array(z.string()).default([]).describe('Arguments passed directly to the executable'),
      cwd: z.string().default('.').describe('Working directory relative to the workspace'),
      timeoutSeconds: z.number().int().min(1).max(60).default(30),
    },
    annotations: { destructiveHint: true },
  }, async ({ command, args, cwd, timeoutSeconds }) => {
    const commandLine = [command, ...args].join(' ');
    try {
      // 1. Blocked command check — always enforced, before permission check
      const blockReason = isDestructiveCommand(command, args);
      if (blockReason) {
        throw new Error(`BLOCKED: ${blockReason}`);
      }

      // 2. Permission check
      await requirePermission('Terminal', `Run: ${commandLine}`);

      // 3. Resolve working directory inside workspace
      const workingDirectory = await guard.resolveExistingPath(cwd);

      // 4. Execute
      try {
        const result = await execFileAsync(command, args, { cwd: workingDirectory, timeout: timeoutSeconds * 1000, maxBuffer: 2 * 1024 * 1024 });
        const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim() || 'Command completed with no output';
        return text(output);
      } catch (error) {
        const output = [error.stdout, error.stderr].filter(Boolean).join('\n').trim();
        throw new Error(output || error.message);
      }
    } catch (error) { return failure(error); }
  });

  server.registerTool('antigravity_status', {
    title: 'Antigravity status',
    description: 'Check availability and installation status of Antigravity and agentapi on this system.',
    inputSchema: {},
  }, async () => {
    try {
      const status = await detectAntigravity();
      return text(JSON.stringify(status, null, 2));
    } catch (error) { return failure(error); }
  });

  server.registerTool('antigravity_start', {
    title: 'Start Antigravity task',
    description: 'Start a new programmatic task in Antigravity via agentapi. Operates strictly within the active Hearth workspace.',
    inputSchema: {
      prompt: z.string().min(1).describe('The instruction or goal for the Antigravity agent (max 64 KiB)'),
      title: z.string().optional().describe('Optional short title for this task'),
    },
    annotations: { destructiveHint: true },
  }, async ({ prompt, title }) => {
    try {
      await requirePermission('Antigravity', `Start Antigravity task: ${title || prompt.slice(0, 60)}`);
      const activeWorkspace = await guard.resolveExistingPath('.');
      const result = await startAntigravityTask({
        workspace: activeWorkspace,
        prompt,
        title,
        runner: options?.antigravityRunner,
        customAgyPath: options?.customAgyPath,
        customAgentApiPath: options?.customAgentApiPath,
        awaitCompletion: false,
        claimStore: xRuntime.claimStore,
      });
      return text(JSON.stringify(result, null, 2));
    } catch (error) { return failure(error); }
  });

  server.registerTool('antigravity_task', {
    title: 'Get Antigravity task',
    description: 'Get live status, recent events, and progress of an Antigravity task created by Hearth.',
    inputSchema: {
      taskId: z.string().min(1).describe('Hearth Task ID'),
    },
  }, async ({ taskId }) => {
    try {
      const task = getAntigravityTask(taskId);
      return text(JSON.stringify(task, null, 2));
    } catch (error) { return failure(error); }
  });

  server.registerTool('antigravity_send', {
    title: 'Send message to Antigravity task',
    description: 'Send a follow-up message to an existing running or waiting Antigravity task.',
    inputSchema: {
      taskId: z.string().min(1).describe('Hearth Task ID'),
      message: z.string().min(1).describe('Message or follow-up prompt to send (max 64 KiB)'),
    },
    annotations: { destructiveHint: true },
  }, async ({ taskId, message }) => {
    try {
      await requirePermission('Antigravity', `Send message to Antigravity task ${taskId}`);
      const result = await sendAntigravityMessage({ taskId, message });
      return text(JSON.stringify(result, null, 2));
    } catch (error) { return failure(error); }
  });

  server.registerTool('x_start', {
    title: 'Start X coding task',
    description: 'Admit one x-task-v1 payload into the local X coding pipeline (bounded repair loop -> deterministic Result Gate -> x-result-v1). Returns immediately with a run_id and never waits for model execution; poll x_task with that run_id for status and, once terminal, the full result. Never retries outside X\'s own bounded repair policy and never routes a result to Codex or Claude.',
    inputSchema: {
      task: z.any().describe('A complete x-task-v1 payload (see mcp/x/task-contract.mjs). Validated internally; a malformed payload returns an error.'),
    },
    annotations: { destructiveHint: true },
  }, async ({ task }) => {
    try {
      const admitted = await runXTask(task, xRuntime.modelAdapter, {
        claimStore: xRuntime.claimStore, runStore: xRuntime.runStore, ownerId: xRuntime.ownerId,
      });
      observeBackgroundCompletion(admitted);
      if (!admitted.accepted) {
        return text(JSON.stringify({ accepted: false, reason: admitted.reason, run_id: null }, null, 2));
      }
      return text(JSON.stringify({ accepted: true, run_id: admitted.runId, task_id: admitted.taskId, status: 'running' }, null, 2));
    } catch (error) { return failure(error); }
  });

  server.registerTool('x_task', {
    title: 'Get X task run status',
    description: 'Read the current persisted status of an X coding run by run_id: queued, running, completed, needs_review, failed, or interrupted. Includes the full x-result-v1 once terminal. Reads only persisted XRunStore state, never an in-memory completion promise.',
    inputSchema: {
      run_id: z.string().min(1).describe('The run_id returned by x_start'),
    },
  }, async ({ run_id }) => {
    try {
      const run = xRuntime.runStore.getRun(run_id);
      if (!run) throw new Error(`No X run found for run_id '${run_id}'.`);
      return text(JSON.stringify({
        run_id: run.runId,
        task_id: run.taskId,
        status: run.status,
        gate_status: run.gateStatus,
        hearth_outcome: run.hearthOutcome,
        error: run.error,
        result: run.result,
      }, null, 2));
    } catch (error) { return failure(error); }
  });
};

