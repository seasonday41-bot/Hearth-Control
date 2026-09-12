import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import { createWorkspaceGuard } from '../workspace.mjs';
import {
  redactSecrets,
  taskRegistry,
  syncTaskToStore,
  startAntigravityTask,
} from './antigravity.mjs';

const execFileAsync = promisify(execFile);

/** Resolves to true if ripgrep is available in $PATH. */
const rgAvailable = execFileAsync('rg', ['--version'], { timeout: 3000 }).then(() => true).catch(() => false);

/**
 * Built-in Node.js search fallback when ripgrep is absent.
 */
const nodeSearch = async (searchRoot, query, maxResults = 100) => {
  const results = [];
  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.nuxt']);

  const searchDir = async (dirPath) => {
    if (results.length >= maxResults) return;
    const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (results.length >= maxResults) break;
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await searchDir(fullPath);
      } else if (entry.isFile()) {
        const content = await fs.readFile(fullPath, 'utf8').catch(() => null);
        if (content === null) continue;
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

/**
 * Executes a task using local MCP read-only tools.
 * Preserves strict completion contract, permission boundaries, and persistence.
 *
 * @param {object} options
 * @param {string} options.workspace
 * @param {string} options.prompt
 * @param {string} [options.title]
 * @param {string} [options.toolHint]
 * @param {Record<string, any>} [options.params={}]
 * @param {Record<string, string>} [options.permissions={}]
 * @param {Function} [options.requestApproval]
 * @param {string} [options.requestedRoute='auto']
 * @param {string} [options.routeReason]
 * @param {string} [options.source='local']
 * @param {string} [options.remoteTaskId=null]
 * @param {string} [options.requestId=null]
 * @param {boolean} [options.isUnsupportedMcp=false]
 * @param {string} [options.unsupportedReason=null]
 * @param {boolean} [options.allowFallback=false]
 * @param {Function} [options.antigravityRunner]
 * @returns {Promise<object>} task record
 */
export const startMcpTask = async ({
  workspace,
  prompt,
  title,
  toolHint,
  params = {},
  permissions = {},
  requestApproval,
  requestedRoute = 'auto',
  routeReason,
  source = 'local',
  remoteTaskId = null,
  requestId = null,
  isUnsupportedMcp = false,
  unsupportedReason = null,
  allowFallback = false,
  antigravityRunner,
}) => {
  if (!workspace || typeof workspace !== 'string') {
    throw new Error('Workspace path is required.');
  }

  const guard = createWorkspaceGuard(workspace);
  const realRoot = await guard.resolveExistingPath('.');

  const taskId = crypto.randomUUID();
  const now = new Date().toISOString();
  const cleanTitle = (title || prompt || '').slice(0, 60) || 'MCP Task';

  const task = {
    taskId,
    conversationId: null,
    workspace: realRoot,
    title: cleanTitle,
    source,
    remoteTaskId,
    requestId,
    dismissed: false,
    status: 'starting',
    requestedRoute,
    resolvedRoute: 'mcp',
    routeReason: routeReason || 'MCP · read-only tool execution',
    routeTransitions: [],
    createdAt: now,
    updatedAt: now,
    lastEvent: null,
    recentEvents: [],
    lastAnswer: null,
    error: null,
    completion: null,
  };

  taskRegistry.set(taskId, task);
  syncTaskToStore(task);

  // 1. Check if task is unsupported by MCP read-only capability
  if (isUnsupportedMcp) {
    // If manual override was requested for an unsupported task:
    // Fail safely without modifying files or silently doing wrong action.
    if (requestedRoute === 'mcp') {
      const errMessage = unsupportedReason || 'Capability insufficient: MCP cannot perform code modifications or complex engineering tasks.';
      task.status = 'error';
      task.error = redactSecrets(errMessage);
      task.completion = {
        status: 'error',
        normalizedStatus: 'error',
        summary: task.error,
        error: task.error,
        checks: { build: 'not_run', tests: 'not_run' },
        artifacts: [],
      };
      task.updatedAt = new Date().toISOString();
      syncTaskToStore(task);
      return task;
    }

    // If auto route or explicit fallback is permitted:
    if (allowFallback) {
      task.routeTransitions.push({
        from: 'mcp',
        to: 'antigravity',
        reason: redactSecrets(unsupportedReason || 'Capability insufficient for MCP tools'),
        timestamp: new Date().toISOString(),
      });
      task.resolvedRoute = 'antigravity';
      task.routeReason = 'Antigravity · capability fallback from MCP';
      task.status = 'starting';
      task.updatedAt = new Date().toISOString();
      syncTaskToStore(task);

      // Transition to Antigravity runner using existing task record (no duplicate task!)
      return await startAntigravityTask({
        workspace: realRoot,
        prompt,
        title: cleanTitle,
        runner: antigravityRunner,
        source,
        remoteTaskId,
        requestId,
        requestedRoute,
        resolvedRoute: 'antigravity',
        routeReason: task.routeReason,
        routeTransitions: task.routeTransitions,
        existingTaskId: taskId,
      });
    }
  }

  // 2. Permission enforcement
  // MCP failure must NEVER silently fall through to Antigravity when permission/safety is denied!
  const requirePermission = async (name, action) => {
    const level = permissions[name] ?? 'Allow';
    if (level === 'Allow') return;
    if (level === 'Ask') {
      if (requestApproval) {
        const allowed = await requestApproval({ permission: name, action });
        if (allowed) return;
        throw new Error(`User denied ${name} access for this request.`);
      }
      throw new Error(`${name} requires permission approval.`);
    }
    throw new Error(`${name} permission is ${level}. Change it to Allow in Hearth Control before using this tool.`);
  };

  task.status = 'running';
  task.updatedAt = new Date().toISOString();
  syncTaskToStore(task);

  try {
    let outputText = '';
    const hint = toolHint || 'workspace_info';

    if (hint === 'workspace_info') {
      outputText = JSON.stringify({ workspace: realRoot, permissions }, null, 2);
    } else if (hint === 'list_files') {
      await requirePermission('Files', `List files in ${params.path || '.'}`);
      const dirPath = await guard.resolveExistingPath(params.path || '.');
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const limit = params.limit || 200;
      const lines = entries.slice(0, limit).map((e) => `${e.isDirectory() ? 'directory' : 'file'}\t${e.name}`);
      if (entries.length > limit) lines.push(`… ${entries.length - limit} more entries`);
      outputText = lines.join('\n') || '(empty directory)';
    } else if (hint === 'read_file') {
      const relPath = params.path;
      if (!relPath) throw new Error('No target file path specified to read.');
      await requirePermission('Files', `Read ${relPath}`);
      const filePath = await guard.resolveExistingPath(relPath);
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) throw new Error('The requested path is not a file.');
      const content = await fs.readFile(filePath, 'utf8');
      const maxChars = params.maxCharacters || 100000;
      outputText = content.length > maxChars ? `${content.slice(0, maxChars)}\n\n[truncated]` : content;
    } else if (hint === 'search_files') {
      const query = params.query;
      if (!query) throw new Error('No search query specified.');
      await requirePermission('Files', `Search for "${query}"`);
      const searchRoot = await guard.resolveExistingPath(params.path || '.');

      if (await rgAvailable) {
        const args = ['--line-number', '--no-heading', '--color', 'never', '--max-count', String(params.maxResults || 100)];
        if (params.glob) args.push('--glob', params.glob);
        args.push(query, searchRoot);
        try {
          const { stdout } = await execFileAsync('rg', args, { timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
          outputText = stdout.trim() || 'No matches';
        } catch (err) {
          if (err && typeof err === 'object' && err.code === 1) outputText = 'No matches';
          else throw err;
        }
      } else {
        outputText = await nodeSearch(searchRoot, query, params.maxResults || 100);
      }
    } else if (hint === 'git_status') {
      await requirePermission('Git', 'Read Git status');
      const { stdout } = await execFileAsync('git', ['-C', realRoot, 'status', '--short'], { timeout: 10000, maxBuffer: 1024 * 1024 });
      outputText = stdout.trim() || 'Working tree clean';
    } else if (hint === 'git_diff') {
      await requirePermission('Git', params.staged ? 'Read staged Git diff' : 'Read working tree Git diff');
      const args = ['-C', realRoot, 'diff'];
      if (params.staged) args.push('--staged');
      const { stdout } = await execFileAsync('git', args, { timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
      outputText = stdout.trim() || 'No changes';
    } else {
      throw new Error(`Unsupported MCP tool hint: ${hint}`);
    }

    // Success: strict completion contract
    const cleanOutput = redactSecrets(outputText);
    task.lastAnswer = cleanOutput;
    const event = {
      stepIndex: 1,
      type: 'DONE',
      status: 'DONE',
      createdAt: new Date().toISOString(),
      summary: cleanOutput.slice(0, 500),
    };
    task.lastEvent = event;
    task.recentEvents.push(event);

    task.completion = {
      status: 'done',
      normalizedStatus: 'completed',
      summary: `MCP completed: ${hint}`,
      error: null,
      checks: { build: 'not_run', tests: 'not_run' },
      artifacts: [],
    };
    task.status = 'done';
    task.updatedAt = new Date().toISOString();
    syncTaskToStore(task);
    return task;
  } catch (err) {
    const cleanErr = redactSecrets(err.message || 'MCP execution failed');
    task.status = 'error';
    task.error = cleanErr;
    task.completion = {
      status: 'error',
      normalizedStatus: 'error',
      summary: cleanErr,
      error: cleanErr,
      checks: { build: 'not_run', tests: 'not_run' },
      artifacts: [],
    };
    task.updatedAt = new Date().toISOString();
    syncTaskToStore(task);

    // CRITICAL: Do NOT fall through to Antigravity on permission or safety denial!
    return task;
  }
};
