import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Runs a git command safely in the specified directory.
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<string>} stdout output
 */
async function runGit(cwd, args) {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * Captures pre-execution baseline Git state for a workspace.
 * @param {string} workspace
 * @returns {Promise<{ branch: string, head: string, dirtyPaths: string[], realWorkspacePath: string }>}
 */
export async function captureGitPreCheck(workspace) {
  let realWorkspacePath = workspace;
  try {
    realWorkspacePath = await fs.realpath(workspace);
  } catch {}

  let branch = 'unknown';
  let head = 'unknown';
  let dirtyPaths = [];

  try {
    branch = await runGit(realWorkspacePath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    head = await runGit(realWorkspacePath, ['rev-parse', 'HEAD']);
    const statusOutput = await runGit(realWorkspacePath, ['status', '--porcelain']);
    if (statusOutput) {
      dirtyPaths = statusOutput
        .split('\n')
        .map((line) => line.slice(3).trim())
        .filter(Boolean);
    }
  } catch (err) {
    // If workspace is not a git repo or git fails, return baseline fallback
  }

  return {
    branch,
    head,
    dirtyPaths,
    realWorkspacePath,
  };
}

/**
 * Normalizes relative path for comparison.
 * @param {string} p
 * @returns {string}
 */
function normalizeRelativePath(p) {
  return p.replace(/^[\.\/]+/, '').replace(/\\/g, '/');
}

/**
 * Simple glob/prefix path matcher for allowed and forbidden paths.
 * @param {string} filePath
 * @param {string} pattern
 * @returns {boolean}
 */
function pathMatchesPattern(filePath, pattern) {
  const cleanPath = normalizeRelativePath(filePath);
  const cleanPattern = normalizeRelativePath(pattern);
  if (!cleanPattern || cleanPattern === '*') return true;
  if (cleanPattern.endsWith('/**')) {
    const prefix = cleanPattern.slice(0, -3);
    return cleanPath === prefix || cleanPath.startsWith(prefix + '/');
  }
  if (cleanPattern.endsWith('/*')) {
    const prefix = cleanPattern.slice(0, -2);
    return cleanPath.startsWith(prefix + '/');
  }
  if (cleanPattern.endsWith('/')) {
    return cleanPath.startsWith(cleanPattern);
  }
  return cleanPath === cleanPattern || cleanPath.startsWith(cleanPattern + '/');
}

/**
 * Verifies post-execution Git changes against pre-check baseline and scope rules.
 * @param {string} workspace
 * @param {{ branch: string, head: string, dirtyPaths: string[], realWorkspacePath: string }} preCheck
 * @param {{ allowedPaths?: string[], forbiddenPaths?: string[], commitPolicy?: { mode: string } }} boundaries
 * @returns {Promise<{ postBranch: string, postHead: string, postChangedPaths: string[], commitsCreated: boolean, allowedPathsValid: boolean, forbiddenPathsValid: boolean, violations: string[] }>}
 */
export async function verifyGitPostCheck(workspace, preCheck, boundaries = {}) {
  const realPath = preCheck.realWorkspacePath || workspace;
  const allowedPaths = Array.isArray(boundaries.allowedPaths) ? boundaries.allowedPaths : [];
  const forbiddenPaths = Array.isArray(boundaries.forbiddenPaths) ? boundaries.forbiddenPaths : [];
  const commitPolicyMode = boundaries.commitPolicy?.mode || 'never';

  let postBranch = preCheck.branch || 'unknown';
  let postHead = preCheck.head || 'unknown';
  let postDirty = [];
  const violations = [];

  try {
    postBranch = await runGit(realPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    postHead = await runGit(realPath, ['rev-parse', 'HEAD']);
    const statusOutput = await runGit(realPath, ['status', '--porcelain']);
    if (statusOutput) {
      postDirty = statusOutput
        .split('\n')
        .map((line) => line.slice(3).trim())
        .filter(Boolean);
    }
  } catch (err) {
    // Non-git or error fallback
  }

  const commitsCreated = preCheck.head !== 'unknown' && postHead !== 'unknown' && preCheck.head !== postHead;
  if (commitPolicyMode === 'never' && commitsCreated) {
    violations.push(`Unexpected git commit created (${postHead.slice(0, 7)}) when commit_policy is 'never'`);
  }

  // Detect changed files: postDirty files not in preCheck.dirtyPaths, plus diff files if commits were created
  const postChangedSet = new Set(postDirty);
  if (commitsCreated) {
    try {
      const diffOutput = await runGit(realPath, ['diff', '--name-only', `${preCheck.head}..${postHead}`]);
      if (diffOutput) {
        for (const file of diffOutput.split('\n').map((f) => f.trim()).filter(Boolean)) {
          postChangedSet.add(file);
        }
      }
    } catch {}
  }

  const postChangedPaths = Array.from(postChangedSet);
  let allowedPathsValid = true;
  let forbiddenPathsValid = true;

  for (const changedPath of postChangedPaths) {
    // Check forbidden paths
    for (const forbiddenPattern of forbiddenPaths) {
      if (pathMatchesPattern(changedPath, forbiddenPattern)) {
        forbiddenPathsValid = false;
        violations.push(`Forbidden path violation: '${changedPath}' matches forbidden pattern '${forbiddenPattern}'`);
      }
    }

    // Check allowed paths if non-empty
    if (allowedPaths.length > 0) {
      const isAllowed = allowedPaths.some((allowedPattern) => pathMatchesPattern(changedPath, allowedPattern));
      if (!isAllowed) {
        allowedPathsValid = false;
        violations.push(`Out-of-scope path violation: '${changedPath}' is not within allowed_paths [${allowedPaths.join(', ')}]`);
      }
    }
  }

  return {
    postBranch,
    postHead,
    postChangedPaths,
    commitsCreated,
    allowedPathsValid,
    forbiddenPathsValid,
    violations,
  };
}
