import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { spawn } from 'node:child_process';
import os from 'node:os';
import * as z from 'zod/v4';
import { createWorkspaceGuard } from './workspace.mjs';
import { JobManager, redactSecrets } from './runtime/job-manager.mjs';
import { layaStatus, layaConsult, layaReview } from './laya.mjs';

const execFileAsync = promisify(execFile);
export const toolNames = [
  'workspace_info',
  'list_files',
  'search_files',
  'read_file',
  'write_file',
  'apply_patch',
  'git_status',
  'git_diff',
  'run_command',
  'job_start',
  'job_status',
  'job_output',
  'job_stop',
  'laya_status',
  'laya_consult',
  'laya_review',
  'github_connections_list',
  'github_repositories_list',
  'github_repository_get',
  'github_pull_requests_list',
  'github_pull_request_create',
  'vercel_projects_list',
  'vercel_project_get',
  'vercel_deployments_list',
  'vercel_deployment_get',

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
  command = path.basename(command);
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
const PATCH_MAX_BYTES = 1024 * 1024;
const jobManager = new JobManager({ storagePath: process.env.CONTROL_JOB_STORE || path.join(os.homedir(), 'Library', 'Application Support', 'Hearth Control', 'generic-jobs.json') });
jobManager.reconcileStartupState();

const gitApply = (cwd, patch, check) => new Promise((resolve, reject) => {
  const child = spawn('git', ['-C', cwd, 'apply', ...(check ? ['--check'] : []), '-'], { cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-4096); });
  child.on('error', reject);
  child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || `Patch failed (exit ${code}).`)));
  child.stdin.on('error', () => {});
  child.stdin.end(patch);
});

const jobView = (job) => ({
  job_id: job.id, status: job.status, pid: job.pid,
  created_at: job.createdAt, started_at: job.startedAt, completed_at: job.completedAt,
  exit_code: job.exitCode, duration: job.durationMs, error: job.error,
});
export const recentJobViews = (workspace) => {
  const root = path.resolve(workspace);
  const all = jobManager.listJobs().filter((job) => job.cwd === root || job.cwd?.startsWith(`${root}${path.sep}`));
  const active = all.filter((job) => ['running', 'queued'].includes(job.status));
  return [...new Map([...active, ...all.slice(-20).reverse()].map((job) => [job.id, job])).values()]
    .map((job) => ({
      ...jobView(job), command: path.basename(job.command),
      output_preview: redactSecrets(job.stderr || job.stdout || '').slice(-240),
      process_stopped: jobManager.isJobProcessStopped(job.id),
    }));
};

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------
export const registerWorkspaceTools = (server, options) => {
  const guard = createWorkspaceGuard(options.workspace);
  const permissions = options.permissions ?? {};
  const requirePermission = async (name, action) => {
    const level = permissions[name] ?? 'Blocked';
    if (level === 'Allow') return;
    if (level === 'Ask' && options.requestApproval) {
      const allowed = await options.requestApproval({ permission: name, action });
      if (allowed) return;
      throw new Error(`User denied ${name} access for this request.`);
    }
    throw new Error(`${name} permission is ${level}. Change it to Allow in Hearth Control before using this tool.`);
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

  server.registerTool('apply_patch', {
    title: 'Apply unified patch',
    description: 'Apply a standard unified diff to existing files inside the workspace. Rejects new files, deletions, renames and unmatched context.',
    inputSchema: { patch: z.string().min(1).max(PATCH_MAX_BYTES) },
    annotations: { destructiveHint: true },
  }, async ({ patch }) => {
    try {
      await requirePermission('Files', 'Apply a repository patch');
      if (Buffer.byteLength(patch, 'utf8') > PATCH_MAX_BYTES || /^(?:GIT binary patch|Binary files |rename (?:from|to) |new file mode |deleted file mode )/m.test(patch)) {
        throw new Error('Patch size or operation is unsupported.');
      }
      const headers = [...patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)];
      const oldPaths = [...patch.matchAll(/^--- a\/(\S+)$/gm)];
      const newPaths = [...patch.matchAll(/^\+\+\+ b\/(\S+)$/gm)];
      if (!headers.length || headers.length !== oldPaths.length || headers.length !== newPaths.length || /^--- \/dev\/null$|^\+\+\+ \/dev\/null$/m.test(patch)) {
        throw new Error('Expected a unified diff for existing files.');
      }
      const changed = [];
      for (let i = 0; i < headers.length; i++) {
        const file = headers[i][1];
        if (file !== headers[i][2] || file !== oldPaths[i][1] || file !== newPaths[i][1] || file.startsWith('-')) {
          throw new Error('Patch paths must refer to the same existing file.');
        }
        if ((await fs.lstat(guard.resolvePath(file))).isSymbolicLink()) throw new Error(`Patch target is a symbolic link: ${file}`);
        const resolved = await guard.resolveExistingPath(file);
        if (!(await fs.stat(resolved)).isFile()) throw new Error(`Patch target is not a regular file: ${file}`);
        changed.push(file);
      }
      const root = await guard.resolveExistingPath('.');
      await gitApply(root, patch, true);
      await gitApply(root, patch, false);
      return text(JSON.stringify({ changed_files: [...new Set(changed)] }));
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

  server.registerTool('job_start', {
    title: 'Start background command',
    description: 'Start one shell-free command in the workspace under Hearth process ownership.',
    inputSchema: {
      command: z.string().min(1), args: z.array(z.string()).default([]),
      cwd: z.string().default('.'), timeoutSeconds: z.number().int().min(1).max(86400).optional(),
    },
    annotations: { destructiveHint: true },
  }, async ({ command, args, cwd, timeoutSeconds }) => {
    try {
      const reason = isDestructiveCommand(command, args);
      if (reason) throw new Error(`BLOCKED: ${reason}`);
      await requirePermission('Terminal', `Start background command: ${[command, ...args].join(' ')}`);
      const directory = await guard.resolveExistingPath(cwd);
      if (!(await fs.stat(directory)).isDirectory()) throw new Error('Job cwd must be a directory.');
      const job = jobManager.startJob({ command, args, cwd: directory, shell: false, timeoutMs: timeoutSeconds ? timeoutSeconds * 1000 : null, metadata: { genericMcp: true } });
      return text(JSON.stringify(jobView(job)));
    } catch (error) { return failure(error); }
  });

  server.registerTool('job_status', {
    title: 'Background job status', description: 'Get persisted status of a Hearth-owned background job.',
    inputSchema: { job_id: z.string().min(1) },
  }, async ({ job_id }) => {
    try {
      await requirePermission('Terminal', `Read job status: ${job_id}`);
      const job = jobManager.getJob(job_id);
      if (!job || job.cwd !== await guard.resolveExistingPath('.')) {
        // Nested directories are also valid, but never disclose jobs from another workspace.
        if (!job || !job.cwd?.startsWith(`${await guard.resolveExistingPath('.')}${path.sep}`)) throw new Error('Job not found in this workspace.');
      }
      return text(JSON.stringify(jobView(job)));
    } catch (error) { return failure(error); }
  });

  server.registerTool('job_output', {
    title: 'Background job output', description: 'Read bounded recent stdout and stderr from a job in this workspace.',
    inputSchema: { job_id: z.string().min(1), max_chars: z.number().int().min(1).max(16000).default(4000) },
  }, async ({ job_id, max_chars }) => {
    try {
      await requirePermission('Terminal', `Read job output: ${job_id}`);
      const job = jobManager.getJob(job_id);
      const root = await guard.resolveExistingPath('.');
      if (!job || (job.cwd !== root && !job.cwd?.startsWith(`${root}${path.sep}`))) throw new Error('Job not found in this workspace.');
      return text(JSON.stringify({ job_id, stdout: redactSecrets(job.stdout).slice(-max_chars), stderr: redactSecrets(job.stderr).slice(-max_chars) }));
    } catch (error) { return failure(error); }
  });

  server.registerTool('job_stop', {
    title: 'Stop background job', description: 'Gracefully terminate only a child process owned by this Hearth MCP process.',
    inputSchema: { job_id: z.string().min(1) }, annotations: { destructiveHint: true },
  }, async ({ job_id }) => {
    try {
      await requirePermission('Terminal', `Stop background job: ${job_id}`);
      const job = jobManager.getJob(job_id);
      const root = await guard.resolveExistingPath('.');
      if (!job || (job.cwd !== root && !job.cwd?.startsWith(`${root}${path.sep}`))) throw new Error('Job not found in this workspace.');
      if (!jobManager.children.has(job_id)) throw new Error('Job is not owned by this process or is no longer running.');
      return text(JSON.stringify({ job_id, stopped: jobManager.cancelJob(job_id) }));
    } catch (error) { return failure(error); }
  });

  server.registerTool('laya_status', {
    title: 'LAYA status', description: 'Check optional advisory provider availability without credentials.', inputSchema: {},
  }, async () => text(JSON.stringify(await layaStatus())));

  server.registerTool('laya_consult', {
    title: 'Consult LAYA', description: 'Ask an optional specialist for advice only; no file or shell access.',
    inputSchema: { prompt: z.string().min(1).max(16000) },
  }, async ({ prompt }) => {
    try { await requirePermission('LAYA', 'Consult LAYA'); return text(JSON.stringify(await layaConsult(prompt))); }
    catch (error) { return failure(error); }
  });

  server.registerTool('laya_review', {
    title: 'Review with LAYA', description: 'Request advisory review of work already produced; does not edit files.',
    inputSchema: {
      objective: z.string().min(1).max(4000), changed_files: z.array(z.string().max(500)).max(100),
      diff: z.string().max(60000).optional(), summary: z.string().max(8000).optional(),
      validation: z.string().max(8000).optional(), focus: z.enum(['code', 'ui', 'ux', 'accessibility', 'architecture']),
    },
  }, async (input) => {
    try { await requirePermission('LAYA', 'Review work with LAYA'); return text(JSON.stringify(await layaReview(input))); }
    catch (error) { return failure(error); }
  });

  const githubAliases = z.enum(['github:personal', 'github:work']);

  server.registerTool('github_connections_list', {
    title: 'List GitHub connections',
    description: 'Read-only: lists renderer-safe Hearth GitHub connection summaries. Never returns tokens, credential refs, ciphertext, or GitHub CLI/keyring state.',
    inputSchema: {},
  }, async () => {
    if (!options.githubTransport?.listConnections) return text(JSON.stringify({ connections: [], reason: 'transport_unavailable' }));
    try {
      await requirePermission('Git', 'List Hearth GitHub connections');
      const result = await options.githubTransport.listConnections();
      return text(JSON.stringify(result, null, 2));
    } catch (error) { return failure(error); }
  });

  server.registerTool('github_repositories_list', {
    title: 'List GitHub repositories',
    description: 'Read-only: lists repositories accessible through one explicit Hearth GitHub connection alias. Never falls back to another account.',
    inputSchema: {
      connection: githubAliases,
      page: z.number().int().min(1).max(10000).default(1),
      per_page: z.number().int().min(1).max(100).default(30),
    },
  }, async ({ connection, page, per_page }) => {
    if (!options.githubTransport?.listRepositories) return text(JSON.stringify({ repositories: [], reason: 'transport_unavailable' }));
    try {
      await requirePermission('Git', `Read GitHub repositories via ${connection}`);
      const result = await options.githubTransport.listRepositories({ connection, page, perPage: per_page });
      if (result?.ok === false) throw new Error(result.error || 'github_request_failed');
      return text(JSON.stringify(result, null, 2));
    } catch (error) { return failure(error); }
  });

  server.registerTool('github_repository_get', {
    title: 'Get GitHub repository',
    description: 'Read-only: reads one repository through one explicit Hearth GitHub connection alias.',
    inputSchema: {
      connection: githubAliases,
      owner: z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/),
      repo: z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/),
    },
  }, async ({ connection, owner, repo }) => {
    if (!options.githubTransport?.getRepository) return text(JSON.stringify({ repository: null, reason: 'transport_unavailable' }));
    try {
      await requirePermission('Git', `Read GitHub repository ${owner}/${repo} via ${connection}`);
      const result = await options.githubTransport.getRepository({ connection, owner, repo });
      if (result?.ok === false) throw new Error(result.error || 'github_request_failed');
      return text(JSON.stringify(result, null, 2));
    } catch (error) { return failure(error); }
  });

  server.registerTool('github_pull_requests_list', {
    title: 'List GitHub pull requests',
    description: 'Read-only: lists pull requests for one repository through one explicit Hearth GitHub connection alias.',
    inputSchema: {
      connection: githubAliases,
      owner: z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/),
      repo: z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/),
      state: z.enum(['open', 'closed', 'all']).default('open'),
      page: z.number().int().min(1).max(10000).default(1),
      per_page: z.number().int().min(1).max(100).default(30),
    },
  }, async ({ connection, owner, repo, state, page, per_page }) => {
    if (!options.githubTransport?.listPullRequests) return text(JSON.stringify({ pullRequests: [], reason: 'transport_unavailable' }));
    try {
      await requirePermission('Git', `Read GitHub pull requests for ${owner}/${repo} via ${connection}`);
      const result = await options.githubTransport.listPullRequests({ connection, owner, repo, state, page, perPage: per_page });
      if (result?.ok === false) throw new Error(result.error || 'github_request_failed');
      return text(JSON.stringify(result, null, 2));
    } catch (error) { return failure(error); }
  });

  server.registerTool('github_pull_request_create', {
    title: 'Create GitHub pull request',
    description: 'Creates one pull request through one explicit Hearth GitHub connection. Requires pull_request.create capability plus Hearth Git permission; Ask mode requires exact local approval. Does not merge, push, delete, publish releases, or mutate repository administration.',
    inputSchema: {
      connection: githubAliases,
      owner: z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/),
      repo: z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/),
      title: z.string().min(1).max(256),
      head: z.string().min(1).max(256),
      base: z.string().min(1).max(256),
      body: z.string().max(65536).optional(),
      draft: z.boolean().default(false),
    },
    annotations: { destructiveHint: true },
  }, async ({ connection, owner, repo, title, head, base, body, draft }) => {
    if (!options.githubTransport?.createPullRequest) return text(JSON.stringify({ ok: false, reason: 'transport_unavailable' }));
    try {
      await requirePermission('Git', `Create GitHub PR in ${owner}/${repo} via ${connection}: ${head} -> ${base} · ${title}`);
      const result = await options.githubTransport.createPullRequest({ connection, owner, repo, title, head, base, body, draft });
      if (result?.ok === false) throw new Error(result.error || 'github_request_failed');
      return text(JSON.stringify(result, null, 2));
    } catch (error) { return failure(error); }
  });

  const vercelAlias = z.literal('vercel:main');
  const vercelTeamId = z.string().regex(/^team_[A-Za-z0-9_-]{3,200}$/).optional();

  server.registerTool('vercel_projects_list', {
    title: 'List Vercel projects',
    description: 'Read-only: lists Vercel projects through the explicit Hearth vercel:main connection. Never uses Vercel CLI/global auth and never returns credentials.',
    inputSchema: {
      connection: vercelAlias,
      team_id: vercelTeamId,
      limit: z.number().int().min(1).max(100).default(20),
    },
  }, async ({ connection, team_id, limit }) => {
    if (!options.vercelTransport?.listProjects) return text(JSON.stringify({ projects: [], reason: 'transport_unavailable' }));
    try {
      await requirePermission('Vercel', `Read Vercel projects via ${connection}`);
      const result = await options.vercelTransport.listProjects({ connection, teamId: team_id, limit });
      if (result?.ok === false) throw new Error(result.error || 'vercel_request_failed');
      return text(JSON.stringify(result, null, 2));
    } catch (error) { return failure(error); }
  });

  server.registerTool('vercel_project_get', {
    title: 'Get Vercel project',
    description: 'Read-only: gets one Vercel project through the explicit Hearth vercel:main connection.',
    inputSchema: {
      connection: vercelAlias,
      id_or_name: z.string().min(1).max(256).regex(/^[^\s/?#]+$/),
      team_id: vercelTeamId,
    },
  }, async ({ connection, id_or_name, team_id }) => {
    if (!options.vercelTransport?.getProject) return text(JSON.stringify({ project: null, reason: 'transport_unavailable' }));
    try {
      await requirePermission('Vercel', `Read Vercel project ${id_or_name} via ${connection}`);
      const result = await options.vercelTransport.getProject({ connection, idOrName: id_or_name, teamId: team_id });
      if (result?.ok === false) throw new Error(result.error || 'vercel_request_failed');
      return text(JSON.stringify(result, null, 2));
    } catch (error) { return failure(error); }
  });

  server.registerTool('vercel_deployments_list', {
    title: 'List Vercel deployments',
    description: 'Read-only: lists Vercel deployments through the explicit Hearth vercel:main connection. This tool cannot create, promote, rollback, or delete deployments.',
    inputSchema: {
      connection: vercelAlias,
      project_id: z.string().min(1).max(256).regex(/^[^\s/?#]+$/).optional(),
      team_id: vercelTeamId,
      target: z.enum(['production', 'preview']).optional(),
      limit: z.number().int().min(1).max(100).default(20),
    },
  }, async ({ connection, project_id, team_id, target, limit }) => {
    if (!options.vercelTransport?.listDeployments) return text(JSON.stringify({ deployments: [], reason: 'transport_unavailable' }));
    try {
      await requirePermission('Vercel', `Read Vercel deployments via ${connection}`);
      const result = await options.vercelTransport.listDeployments({
        connection,
        projectId: project_id,
        teamId: team_id,
        target,
        limit,
      });
      if (result?.ok === false) throw new Error(result.error || 'vercel_request_failed');
      return text(JSON.stringify(result, null, 2));
    } catch (error) { return failure(error); }
  });

  server.registerTool('vercel_deployment_get', {
    title: 'Get Vercel deployment',
    description: 'Read-only: gets one Vercel deployment through the explicit Hearth vercel:main connection.',
    inputSchema: {
      connection: vercelAlias,
      id_or_url: z.string().min(1).max(512).regex(/^[^\s/?#]+$/),
      team_id: vercelTeamId,
    },
  }, async ({ connection, id_or_url, team_id }) => {
    if (!options.vercelTransport?.getDeployment) return text(JSON.stringify({ deployment: null, reason: 'transport_unavailable' }));
    try {
      await requirePermission('Vercel', `Read Vercel deployment ${id_or_url} via ${connection}`);
      const result = await options.vercelTransport.getDeployment({ connection, idOrUrl: id_or_url, teamId: team_id });
      if (result?.ok === false) throw new Error(result.error || 'vercel_request_failed');
      return text(JSON.stringify(result, null, 2));
    } catch (error) { return failure(error); }
  });

};
