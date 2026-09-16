import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Resolves the absolute path to the Codex CLI executable.
 * @param {string} [customPath]
 * @returns {Promise<string>} absolute path to binary
 */
export async function resolveCodexBinary(customPath) {
  const candidates = [];
  if (customPath && typeof customPath === 'string') candidates.push(customPath.trim());
  if (process.env.CODEX_CLI_PATH) candidates.push(process.env.CODEX_CLI_PATH.trim());

  const home = process.env.HOME || os.homedir();
  if (home) {
    candidates.push(path.join(home, '.local', 'bin', 'codex'));
  }

  for (const cand of candidates) {
    try {
      const stat = await fs.stat(cand);
      if (stat.isFile()) {
        await fs.access(cand, fsSync.constants.X_OK);
        return cand;
      }
    } catch {}
  }

  // Fallback to system PATH via `which codex`
  try {
    const { stdout } = await execFileAsync('which', ['codex']);
    const foundPath = stdout.trim();
    if (foundPath) {
      await fs.access(foundPath, fsSync.constants.X_OK);
      return foundPath;
    }
  } catch {}

  throw new Error('Codex CLI binary not found or not executable. Ensure codex is installed at ~/.local/bin/codex or on PATH.');
}

/**
 * Generates the default JSON schema file path for specialist output formatting.
 * Schema shape: { status, summary, validation_claims, remaining_risks }
 * @param {string} tempDir
 * @returns {Promise<string>} path to written JSON schema file
 */
export async function createOutputSchemaFile(tempDir) {
  const schema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['completed', 'needs_review', 'failed'] },
      summary: { type: 'string' },
    },
    required: ['status', 'summary'],
    additionalProperties: false,
  };

  const schemaPath = path.join(tempDir, `specialist-schema-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  await fs.writeFile(schemaPath, JSON.stringify(schema, null, 2), 'utf8');
  return schemaPath;
}

/**
 * Formats a comprehensive prompt for Codex specialist execution from a specialist-handoff-v1 package.
 * @param {object} handoffPackage
 * @returns {string} prompt string
 */
export function formatSpecialistPrompt(handoffPackage) {
  const { handoff, goal, source, authored_x_task, boundaries, evidence } = handoffPackage || {};

  const formatList = (item) => {
    if (!item) return [];
    if (Array.isArray(item)) return item.map((x) => `- ${x}`);
    if (typeof item === 'object') {
      const res = [];
      if (Array.isArray(item.preserve)) res.push(...item.preserve.map((x) => `- Preserve: ${x}`));
      if (Array.isArray(item.do_not)) res.push(...item.do_not.map((x) => `- Do Not: ${x}`));
      if (res.length > 0) return res;
      return Object.entries(item).map(([k, v]) => `- ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    }
    return [`- ${String(item)}`];
  };

  const allowedPaths = Array.isArray(boundaries?.allowed_paths) ? boundaries.allowed_paths.join(', ') : 'All workspace files';
  const forbiddenPaths = Array.isArray(boundaries?.forbidden_paths) ? boundaries.forbidden_paths.join(', ') : 'None';

  const lines = [
    `# SPECIALIST EXECUTION TASK: ${goal?.title || 'Hearth Task'}`,
    ``,
    `## OBJECTIVE`,
    `${goal?.objective || ''}`,
    ``,
    `## REQUESTED SPECIALIST ACTION`,
    `${handoff?.requested_action || handoff?.reason || 'Perform requested task repairs and updates.'}`,
    ``,
    `## WORKSPACE & SCOPE BOUNDARIES`,
    `Workspace: ${boundaries?.workspace || ''}`,
    `Allowed Paths: ${allowedPaths || 'All workspace files'}`,
    `Forbidden Paths: ${forbiddenPaths || 'None'}`,
    `Commit Policy: ${boundaries?.commit_policy?.mode || 'never'} (DO NOT CREATE GIT COMMITS)`,
    ``,
    `## CONSTRAINTS`,
    ...formatList(boundaries?.constraints),
    ``,
    `## ACCEPTANCE CRITERIA`,
    ...formatList(boundaries?.acceptance_criteria),
    ``,
    `## SOURCE TASK DETAILS`,
    `Task ID: ${source?.task_id || ''}`,
    `Request ID: ${source?.request_id || ''}`,
    `Terminal Status: ${source?.terminal_status || ''}`,
    ``,
    `IMPORTANT SAFETY RULES:`,
    `1. Edit only permitted files within the allowed paths.`,
    `2. Do NOT create git commits, branches, or tags.`,
    `3. Perform all necessary file updates and verification.`,
  ];

  return lines.join('\n');
}

/**
 * Parses JSONL events from stdout stream to extract session/thread IDs.
 * @param {string} stdout
 * @returns {{ sessionId: string|null, events: object[] }}
 */
export function parseCodexJsonlOutput(stdout) {
  let sessionId = null;
  const events = [];

  if (typeof stdout !== 'string' || !stdout.trim()) {
    return { sessionId, events };
  }

  const lines = stdout.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      events.push(parsed);

      if (!sessionId) {
        if (parsed.session_id && typeof parsed.session_id === 'string') {
          sessionId = parsed.session_id;
        } else if (parsed.thread_id && typeof parsed.thread_id === 'string') {
          sessionId = parsed.thread_id;
        } else if (parsed.data?.session_id) {
          sessionId = parsed.data.session_id;
        } else if (parsed.data?.thread_id) {
          sessionId = parsed.data.thread_id;
        }
      }
    } catch {}
  }

  return { sessionId, events };
}

/**
 * Builds the exact safe argument list for Codex CLI exec dispatch.
 * @param {object} params
 * @param {string} params.workspace
 * @param {string} params.schemaPath
 * @param {string} params.outputPath
 * @returns {string[]} args
 */
export function buildCodexArgs({ workspace, schemaPath, outputPath }) {
  const args = [
    '-a', 'never',
    'exec',
    '--json',
    '-C', workspace,
    '--sandbox', 'workspace-write',
  ];
  if (schemaPath) {
    args.push('--output-schema', schemaPath);
  }
  if (outputPath) {
    args.push('-o', outputPath);
  }
  args.push('-');
  return args;
}
