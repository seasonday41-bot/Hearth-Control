import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_MAX_MATCHES = 100;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.cache', '.vite', 'release']);
const PROTECTED_BASENAMES = new Set(['.env', 'credentials', 'credential', 'tokens', 'token', 'oauth', 'session', 'cookies', 'transcript.jsonl', 'id_rsa', 'id_ed25519', 'id_ecdsa', 'authorized_keys', 'known_hosts']);
const PROTECTED_PARTS = /(?:^|[-_.])(credentials?|tokens?|oauth|sessions?|cookies?|private|secrets?)(?:[-_.]|$)/i;
const PROTECTED_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx']);

const eventResult = (ok, skill, value, error = null) => ({ ok, skill, ...(ok ? { result: value, evidence: { status: 'candidate', instruction: 'Verify semantic relevance against the user question before treating this as confirmed.' } } : { error: { code: error?.code || 'SKILL_ERROR', message: String(error?.message || error || 'Skill failed') } }) });
const isProtected = (relativePath) => {
  const parts = relativePath.split(/[\\/]/).filter(Boolean);
  const basename = parts.at(-1)?.toLowerCase() || '';
  return PROTECTED_BASENAMES.has(basename) || basename.startsWith('.env.') || PROTECTED_EXTENSIONS.has(path.extname(basename).toLowerCase()) || parts.some((part) => PROTECTED_PARTS.test(part));
};
const safeRelative = (value) => typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && value !== '.' && !value.split(/[\\/]/).includes('..');

export class ReadOnlyToolGateway {
  constructor({ workspace, maxToolSteps = 6, fsApi = fs } = {}) {
    this.workspace = workspace ? path.resolve(workspace) : null;
    this.maxToolSteps = Math.max(1, Math.min(6, Number(maxToolSteps) || 6));
    this.fs = fsApi;
  }

  async root() {
    if (!this.workspace) throw Object.assign(new Error('No workspace is selected'), { code: 'WORKSPACE_REQUIRED' });
    const root = await this.fs.realpath(this.workspace);
    const stat = await this.fs.stat(root);
    if (!stat.isDirectory()) throw Object.assign(new Error('Selected workspace is not a directory'), { code: 'INVALID_WORKSPACE' });
    return root;
  }

  async resolve(relativePath, { allowDirectory = true } = {}) {
    if (!safeRelative(relativePath)) throw Object.assign(new Error('Path must stay inside the selected workspace'), { code: 'PATH_REJECTED' });
    const root = await this.root();
    const candidate = path.resolve(root, relativePath);
    let real;
    try {
      real = await this.fs.realpath(candidate);
    } catch (error) {
      const parentReal = await this.fs.realpath(path.dirname(candidate)).catch(() => null);
      if (parentReal) {
        const parentRelative = path.relative(root, parentReal);
        if (parentRelative.startsWith(`..${path.sep}`) || path.isAbsolute(parentRelative)) throw Object.assign(new Error('Path must stay inside the selected workspace'), { code: 'PATH_REJECTED' });
      }
      throw error;
    }
    const relative = path.relative(root, real);
    if (relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw Object.assign(new Error('Path must stay inside the selected workspace'), { code: 'PATH_REJECTED' });
    const stat = await this.fs.stat(real);
    if (!allowDirectory && stat.isDirectory()) throw Object.assign(new Error('A file path is required'), { code: 'NOT_A_FILE' });
    return { root, absolute: real, relative: relative.split(path.sep).join('/'), stat };
  }

  async repoList({ maxDepth = DEFAULT_MAX_DEPTH, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
    const root = await this.root();
    const entries = [];
    const walk = async (directory, depth) => {
      if (depth > Math.min(DEFAULT_MAX_DEPTH, Math.max(0, Number(maxDepth) || DEFAULT_MAX_DEPTH)) || entries.length >= Math.min(DEFAULT_MAX_ENTRIES, Math.max(1, Number(maxEntries) || DEFAULT_MAX_ENTRIES))) return;
      const children = await this.fs.readdir(directory, { withFileTypes: true });
      for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entries.length >= Math.min(DEFAULT_MAX_ENTRIES, Math.max(1, Number(maxEntries) || DEFAULT_MAX_ENTRIES))) break;
        if (child.isDirectory() && SKIPPED_DIRECTORIES.has(child.name)) continue;
        const absolute = path.join(directory, child.name);
        const relative = path.relative(root, absolute).split(path.sep).join('/');
        if (isProtected(relative)) { entries.push({ path: relative, type: child.isDirectory() ? 'directory' : 'file', protected: true }); continue; }
        if (child.isSymbolicLink()) continue;
        entries.push({ path: relative, type: child.isDirectory() ? 'directory' : 'file' });
        if (child.isDirectory()) await walk(absolute, depth + 1);
      }
    };
    await walk(root, 0);
    return { root: path.basename(root), entries, truncated: entries.length >= Math.min(DEFAULT_MAX_ENTRIES, Math.max(1, Number(maxEntries) || DEFAULT_MAX_ENTRIES)) };
  }

  async repoReadFile({ path: relativePath } = {}) {
    const resolved = await this.resolve(relativePath, { allowDirectory: false });
    if (isProtected(resolved.relative)) return { path: resolved.relative, protected: true, message: 'Protected file. Contents were not read.' };
    if (resolved.stat.size > MAX_FILE_BYTES) {
      const handle = await this.fs.open(resolved.absolute, 'r');
      try { const buffer = Buffer.alloc(MAX_FILE_BYTES); const { bytesRead } = await handle.read(buffer, 0, MAX_FILE_BYTES, 0); return { path: resolved.relative, partial: true, truncated: true, content: buffer.subarray(0, bytesRead).toString('utf8').split('\n').map((line, index) => `${index + 1}: ${line}`).join('\n') }; } finally { await handle.close(); }
    }
    const content = await this.fs.readFile(resolved.absolute, 'utf8');
    if (content.includes('\u0000')) return { path: resolved.relative, skipped: true, message: 'Binary file was not read.' };
    return { path: resolved.relative, partial: false, content: content.split('\n').map((line, index) => `${index + 1}: ${line}`).join('\n') };
  }

  async fileSearch({ query, path: scope = '' } = {}) {
    if (typeof query !== 'string' || !query.trim()) throw Object.assign(new Error('A search query is required'), { code: 'INVALID_REQUEST' });
    const root = await this.root();
    const base = scope ? await this.resolve(scope) : { absolute: root, relative: '' };
    if (scope && isProtected(base.relative)) return { matches: [], truncated: false, protected: true, message: 'Protected path. Contents were not searched.' };
    const matches = [];
    const walk = async (directory) => {
      if (matches.length >= DEFAULT_MAX_MATCHES) return;
      for (const child of (await this.fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (matches.length >= DEFAULT_MAX_MATCHES) break;
        if (child.isDirectory() && SKIPPED_DIRECTORIES.has(child.name)) continue;
        if (child.isSymbolicLink()) continue;
        const absolute = path.join(directory, child.name);
        const relative = path.relative(root, absolute).split(path.sep).join('/');
        if (isProtected(relative)) continue;
        if (child.isDirectory()) { await walk(absolute); continue; }
        const stat = await this.fs.stat(absolute);
        if (stat.size > MAX_FILE_BYTES) continue;
        const content = await this.fs.readFile(absolute, 'utf8').catch(() => null);
        if (content === null || content.includes('\u0000')) continue;
        content.split('\n').forEach((line, index) => {
          if (matches.length >= DEFAULT_MAX_MATCHES || !line.toLowerCase().includes(query.toLowerCase())) return;
          matches.push({ path: relative, line: index + 1, excerpt: line.trim().slice(0, 240) });
        });
      }
    };
    const stat = await this.fs.stat(base.absolute);
    if (stat.isDirectory()) await walk(base.absolute); else if (!isProtected(base.relative)) {
      const content = await this.fs.readFile(base.absolute, 'utf8');
      content.split('\n').forEach((line, index) => { if (matches.length < DEFAULT_MAX_MATCHES && line.toLowerCase().includes(query.toLowerCase())) matches.push({ path: base.relative, line: index + 1, excerpt: line.trim().slice(0, 240) }); });
    }
    return { matches, truncated: matches.length >= DEFAULT_MAX_MATCHES };
  }

  async gitInspect({ operation = 'status' } = {}) {
    const argsByOperation = {
      branch: ['branch', '--show-current'],
      head: ['rev-parse', 'HEAD'],
      status: ['status', '--short', '--branch'],
      log: ['log', '-n', '8', '--oneline', '--no-decorate'],
      diff: ['diff', '--stat', '--no-ext-diff'],
    };
    const args = argsByOperation[operation];
    if (!args) throw Object.assign(new Error('Git operation is not available'), { code: 'OPERATION_REJECTED' });
    const root = await this.root();
    const output = await new Promise((resolve, reject) => {
      const child = spawn('git', args, { cwd: root, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = ''; let settled = false;
      const finish = (fn, value) => { if (settled) return; settled = true; fn(value); };
      const timer = setTimeout(() => { child.kill('SIGTERM'); finish(reject, Object.assign(new Error('Git inspection timed out'), { code: 'TIMEOUT' })); }, 30_000);
      child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(0, MAX_OUTPUT_BYTES); });
      child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(0, MAX_OUTPUT_BYTES); });
      child.on('error', (error) => { clearTimeout(timer); finish(reject, error); });
      child.on('close', (code) => { clearTimeout(timer); finish(code === 0 ? resolve : reject, code === 0 ? stdout.trim() : new Error(stderr.trim() || `git exited with ${code}`)); });
    });
    return { operation, output: String(output).slice(0, MAX_OUTPUT_BYTES) };
  }

  async execute(name, input = {}) {
    if (name === 'repo_list') return eventResult(true, name, await this.repoList(input));
    if (name === 'repo_read_file') return eventResult(true, name, await this.repoReadFile(input));
    if (name === 'file_search') return eventResult(true, name, await this.fileSearch(input));
    if (name === 'git_inspect') return eventResult(true, name, await this.gitInspect(input));
    return eventResult(false, name, null, Object.assign(new Error('Unknown or unavailable skill'), { code: 'TOOL_REJECTED' }));
  }
}

export const LOCAL_SKILL_TOOLS = Object.freeze([
  { type: 'function', function: { name: 'repo_list', description: 'List the selected workspace tree within bounded depth and entry limits.', parameters: { type: 'object', properties: { maxDepth: { type: 'integer' }, maxEntries: { type: 'integer' } } } } },
  { type: 'function', function: { name: 'repo_read_file', description: 'Read one permitted text/source file from the selected workspace with line numbers.', parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } } },
  { type: 'function', function: { name: 'file_search', description: 'Search permitted text files in the selected workspace.', parameters: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, path: { type: 'string' } } } } },
  { type: 'function', function: { name: 'git_inspect', description: 'Inspect selected workspace Git state read-only.', parameters: { type: 'object', required: ['operation'], properties: { operation: { type: 'string', enum: ['branch', 'head', 'status', 'log', 'diff'] } } } } },
]);

export const createReadOnlyToolGateway = (options = {}) => new ReadOnlyToolGateway(options);

// Reused by mcp/x/context-loader.mjs as the path-based half of its Secret
// Guard, so a secret-shaped filename is blocked identically everywhere in
// the app rather than re-implemented with a second, possibly-diverging list.
export const isProtectedPath = isProtected;
