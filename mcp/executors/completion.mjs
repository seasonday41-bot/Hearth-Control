import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';

/**
 * Explicit Thai interim patterns indicating unfinished work.
 */
export const THAI_INTERIM_PATTERNS = [
  /กำลังดำเนินการ/i,
  /กำลัง\s*build/i,
  /กำลัง\s*(?:แพ็ก|แพค|เเพ็ก|เเพค)/i,
  /กำลัง\s*package/i,
  /กำลัง\s*ทดสอบ/i,
  /รอสักครู่/i,
  /จะรายงานเมื่อเสร็จ/i,
  /อยู่ระหว่างดำเนินการ/i,
  /กำลังทำ/i,
  /กำลังประมวลผล/i,
];

/**
 * Explicit English interim patterns indicating unfinished work.
 */
export const ENGLISH_INTERIM_PATTERNS = [
  /\bstill\s+working\b/i,
  /\bin\s+progress\b/i,
  /\bpacking\b/i,
  /\bpackaging\b/i,
  /\bwill\s+report\s+when\s+(?:finished|done|completed)\b/i,
  /\bplease\s+wait\b/i,
  /\bwork\s+in\s+progress\b/i,
  /\bcurrently\s+(?:working|processing|running)\b/i,
  /\bnot\s+(?:yet\s+)?finished\b/i,
];

/**
 * Action verbs that represent in-progress work unless qualified by completion terms.
 */
export const PROGRESSIVE_ACTION_VERBS = ['building', 'packaging', 'testing'];

const COMPLETED_TEXT_PATTERNS = [
  /FINAL\s+STATUS\s*:\s*(?:COMPLETED|DONE)/i,
  /(?:^|\n)\s*(?:status\s*:\s*)?(?:completed|complete|done|finished|success(?:fully)?)\b/i,
  /(?:งาน|การทำงาน).{0,16}(?:เสร็จ(?:สิ้น)?|สำเร็จ)/i,
  /(?:เสร็จ(?:สิ้น)?|สำเร็จ).{0,16}(?:แล้ว|เรียบร้อย)/i,
];

const CHECK_VALUES = new Set(['passed', 'failed', 'not_run']);

/**
 * Parses the supported final payload without accepting arbitrary transcript data.
 * A payload may be supplied as an object or as a JSON string. Plain text remains
 * supported for older Antigravity versions.
 *
 * @param {unknown} response
 * @returns {{ kind: 'structured', status: 'completed'|'waiting'|'error', summary: string, checks?: object, artifacts?: string[] } | { kind: 'text', summary: string }}
 */
export const parseFinalResponse = (response) => {
  const parseContract = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const rawStatus = typeof value.status === 'string' ? value.status.trim().toLowerCase() : '';
    // Hearth completion schema must be STRICT:
    // 'completed', 'waiting', 'error' ONLY.
    // 'success', 'done', 'ok', 'finished' are invalid completion schemas and must NOT be auto-mapped to completed.
    if (['completed', 'waiting', 'error'].includes(rawStatus) && typeof value.summary === 'string') {
      const checks = {};
      for (const key of ['build', 'tests']) {
        if (CHECK_VALUES.has(value.checks?.[key])) checks[key] = value.checks[key];
      }
      return {
        kind: 'structured',
        status: rawStatus,
        summary: value.summary.trim(),
        interimReason: typeof value.interimReason === 'string' && value.interimReason.trim() ? value.interimReason.trim() : null,
        checks,
        artifacts: Array.isArray(value.artifacts) ? value.artifacts.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()) : [],
      };
    }
    // If it has a status property or looks like a completion declaration,
    // but status is not in strict ['completed', 'waiting', 'error'],
    // treat as invalid completion schema.
    if ('status' in value) {
      return {
        kind: 'invalid',
        status: 'invalid',
        rawStatus,
        summary: typeof value.summary === 'string' ? value.summary.trim() : '',
      };
    }
    return null;
  };

  if (typeof response === 'string') {
    const trimmed = response.trim();
    if (!trimmed) return { kind: 'text', summary: '' };
    try {
      const final = parseContract(JSON.parse(trimmed));
      if (final) return final;
    } catch { /* Check explicit fenced JSON below. */ }

    // Agent output is untrusted. Only parse explicit JSON fences and accept a
    // block after the completion-contract schema validates; surrounding prose
    // is never interpreted as executable or structured data.
    let invalidCandidate = null;
    for (const match of trimmed.matchAll(/```json\s*\r?\n([\s\S]*?)\r?\n```/gi)) {
      try {
        const parsed = JSON.parse(match[1]);
        const final = parseContract(parsed);
        if (final?.kind === 'structured') return final;
        if (final?.kind === 'invalid' && !invalidCandidate) invalidCandidate = final;
      } catch { /* Malformed and unrelated blocks are deliberately ignored. */ }
    }
    if (invalidCandidate) return invalidCandidate;
    return { kind: 'text', summary: trimmed };
  }

  const structured = parseContract(response);
  if (structured) return structured;

  // If response is an object, extract any textual payload so it can be evaluated as text
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    const candidate = typeof response.summary === 'string' ? response.summary
      : typeof response.text === 'string' ? response.text
      : typeof response.content === 'string' ? response.content
      : typeof response.message === 'string' ? response.message
      : typeof response.output === 'string' ? response.output
      : '';
    if (candidate.trim()) {
      return { kind: 'text', summary: candidate.trim() };
    }
  }

  return { kind: 'text', summary: '' };
};

const hasExplicitCompletion = (text) => COMPLETED_TEXT_PATTERNS.some((pattern) => pattern.test(text));

const inferChecks = (text, provided = {}) => {
  const lower = text.toLowerCase();
  return {
    build: provided.build || (lower.includes('build') ? (/build\s+(?:failed|error)/i.test(text) ? 'failed' : 'passed') : 'not_run'),
    tests: provided.tests || (lower.includes('test') ? (/tests?\s+(?:failed|error)/i.test(text) ? 'failed' : 'passed') : 'not_run'),
  };
};

/**
 * Tests whether a response string clearly indicates unfinished/interim work.
 * @param {string} text
 * @returns {boolean}
 */
export const isInterimResponse = (text) => {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed) return false;

  // 1. Explicit status tag check
  if (/FINAL\s+STATUS\s*:\s*(?:WAITING|IN_PROGRESS|RUNNING)/i.test(trimmed)) {
    return true;
  }

  // 2. Thai interim phrases
  for (const pattern of THAI_INTERIM_PATTERNS) {
    if (pattern.test(trimmed)) {
      return true;
    }
  }

  // 3. English interim phrases
  for (const pattern of ENGLISH_INTERIM_PATTERNS) {
    if (pattern.test(trimmed)) {
      return true;
    }
  }

  // 4. Progressive action verbs (e.g. "packaging...", "building...", "testing...")
  for (const verb of PROGRESSIVE_ACTION_VERBS) {
    const verbRegex = new RegExp(`\\b${verb}\\b`, 'i');
    if (verbRegex.test(trimmed)) {
      // If the verb is qualified by completion terms (e.g. "packaging complete", "testing passed", "finished building"),
      // do not classify as interim.
      const completedContext = new RegExp(
        `(?:finished|completed|succeeded|done|passed|successful)\\s+(?:all\\s+)?(?:[a-z0-9_-]+\\s+)?\\b${verb}\\b|\\b${verb}\\b\\s+(?:is\\s+)?(?:finished|completed|succeeded|done|passed|successful)`,
        'i'
      );
      if (!completedContext.test(trimmed)) {
        return true;
      }
    }
  }

  return false;
};

/**
 * Verifies a single declared artifact path against the approved workspace.
 * Rejects path traversal and files outside the workspace.
 *
 * @param {string} workspace
 * @param {string} artifactPath
 * @returns {{ ok: boolean, path?: string, error?: string, outsideWorkspace?: boolean, missing?: boolean }}
 */
export const verifyArtifactPath = (workspace, artifactPath) => {
  if (!workspace || typeof workspace !== 'string') {
    return { ok: false, error: 'Workspace path is missing or invalid.', outsideWorkspace: true };
  }
  if (!artifactPath || typeof artifactPath !== 'string' || !artifactPath.trim()) {
    return { ok: false, error: 'Artifact path must be a non-empty string.', outsideWorkspace: false };
  }

  let realWorkspace;
  try {
    realWorkspace = fs.realpathSync(workspace);
  } catch {
    return { ok: false, error: `Workspace '${workspace}' cannot be resolved.`, outsideWorkspace: true };
  }

  const trimmed = artifactPath.trim();
  const normalized = path.normalize(trimmed);
  const resolved = path.isAbsolute(normalized)
    ? normalized
    : path.resolve(realWorkspace, normalized);

  const relative = path.relative(realWorkspace, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative) || resolved === realWorkspace) {
    return {
      ok: false,
      error: `Artifact path '${trimmed}' escapes the approved workspace. Path traversal rejected.`,
      outsideWorkspace: true,
    };
  }

  if (!fs.existsSync(resolved)) {
    return {
      ok: false,
      error: `Declared required artifact '${trimmed}' does not exist.`,
      missing: true,
    };
  }

  try {
    const realResolved = fs.realpathSync(resolved);
    const realRelative = path.relative(realWorkspace, realResolved);
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
      return {
        ok: false,
        error: `Artifact '${trimmed}' escapes the workspace via symbolic link. Path traversal rejected.`,
        outsideWorkspace: true,
      };
    }
  } catch {
    return {
      ok: false,
      error: `Declared artifact '${trimmed}' cannot be accessed.`,
      missing: true,
    };
  }

  return { ok: true, path: resolved };
};

/**
 * Synchronous verification of declared required artifacts.
 * Opt-in: if requiredArtifacts is empty or not provided, verification passes.
 *
 * @param {string} workspace
 * @param {string | string[] | null} requiredArtifacts
 * @returns {{ satisfied: boolean, verified: string[], error?: string, reason?: string }}
 */
export const verifyDeclaredArtifactsSync = (workspace, requiredArtifacts) => {
  if (!requiredArtifacts) {
    return { satisfied: true, verified: [] };
  }

  const list = Array.isArray(requiredArtifacts) ? requiredArtifacts : [requiredArtifacts];
  if (list.length === 0) {
    return { satisfied: true, verified: [] };
  }

  const verified = [];
  for (const item of list) {
    const check = verifyArtifactPath(workspace, item);
    if (!check.ok) {
      return {
        satisfied: false,
        verified,
        error: check.error,
        reason: check.outsideWorkspace ? 'outside_workspace' : 'missing_artifact',
      };
    }
    verified.push(check.path);
  }

  return { satisfied: true, verified };
};

/**
 * Asynchronous verification of declared required artifacts.
 *
 * @param {string} workspace
 * @param {string | string[] | null} requiredArtifacts
 * @returns {Promise<{ satisfied: boolean, verified: string[], error?: string, reason?: string }>}
 */
export const verifyDeclaredArtifacts = async (workspace, requiredArtifacts) => {
  return verifyDeclaredArtifactsSync(workspace, requiredArtifacts);
};

/**
 * Deterministic completion classifier that evaluates the sanitized final response,
 * executor status, and declared verification requirements.
 *
 * Contract:
 * Normalized states: 'starting' | 'running' | 'waiting' | 'done' | 'error'
 *
 * DONE requires:
 * 1. executor/session has ended cleanly (status === 'SUCCESS'), AND
 * 2. a non-empty final response, AND
 * 3. a structured `status: 'completed'` payload or explicit legacy-text
 *    completion declaration (plain transport exit is insufficient), AND
 * 4. response is not classified as interim/waiting, AND
 * 5. declared verification requirements (if any) are satisfied.
 *
 * @param {{
 *   response: string | object | null | undefined,
 *   executorStatus?: string,
 *   events?: Array<any>,
 *   error?: string | null,
 *   verificationRequirements?: { requiredArtifacts?: string | string[] } | null,
 *   workspace?: string | null
 * }} params
 * @returns {{
 *   status: 'done' | 'waiting' | 'error',
 *   normalizedStatus: 'completed' | 'waiting' | 'error',
 *   summary: string,
 *   error: string | null,
 *   checks: { build: 'passed' | 'failed' | 'not_run', tests: 'passed' | 'failed' | 'not_run' },
 *   artifacts: string[],
 *   interimReason?: string | null
 * }}
 */
export const classifyCompletion = ({
  response,
  executorStatus = 'SUCCESS',
  events = [],
  error = null,
  verificationRequirements = null,
  workspace = null,
  requireStructuredContract = false,
}) => {
  const final = parseFinalResponse(response);
  const summary = final.summary;
  const suppliedChecks = final.kind === 'structured' ? final.checks : {};
  const suppliedArtifacts = final.kind === 'structured' ? final.artifacts : [];

  // 1. Check for executor or process level errors
  const isCleanExit = String(executorStatus || '').toUpperCase() === 'SUCCESS';
  if (!isCleanExit || final.status === 'error' || (error && !summary)) {
    const errorMsg = error || (final.status === 'error' ? 'Antigravity reported an error.' : 'Antigravity execution failed.');
    return {
      status: 'error',
      normalizedStatus: 'error',
      summary: errorMsg,
      error: errorMsg,
      checks: { build: 'not_run', tests: 'not_run' },
      artifacts: [],
    };
  }

  // 1b. Check for invalid completion schema (e.g. status: 'success', 'done', 'ok', 'finished', etc.)
  if (final.kind === 'invalid') {
    return {
      status: 'waiting',
      normalizedStatus: 'waiting',
      summary: summary || (final.rawStatus ? `Invalid completion schema: status '${final.rawStatus}' is not permitted.` : 'Invalid completion schema.'),
      error: null,
      interimReason: `Invalid completion contract schema${final.rawStatus ? `: status '${final.rawStatus}' is not permitted (must be completed, waiting, or error)` : ''}.`,
      checks: inferChecks(summary),
      artifacts: [],
    };
  }

  // 2. Empty or whitespace-only response -> error
  if (!summary) {
    const emptyMsg = 'Antigravity exited without a final response.';
    return {
      status: 'error',
      normalizedStatus: 'error',
      summary: emptyMsg,
      error: emptyMsg,
      checks: { build: 'not_run', tests: 'not_run' },
      artifacts: [],
    };
  }

  if (requireStructuredContract && final.kind !== 'structured') {
    return {
      status: 'waiting',
      normalizedStatus: 'waiting',
      summary,
      error: null,
      interimReason: 'Durable continuation requires a structured completed, waiting, or error contract.',
      checks: { build: 'not_run', tests: 'not_run' },
      artifacts: [],
    };
  }

  // 3. Classify interim/in-progress response -> waiting
  if (final.status === 'waiting' || isInterimResponse(summary)) {
    return {
      status: 'waiting',
      normalizedStatus: 'waiting',
      summary,
      error: null,
      interimReason: final.interimReason || 'Response indicates work is still in progress.',
      checks: inferChecks(summary, suppliedChecks),
      artifacts: suppliedArtifacts,
    };
  }

  // 4. Verification requirements (opt-in artifact verification)
  const declaredArtifacts = verificationRequirements?.requiredArtifacts || (suppliedArtifacts.length > 0 ? suppliedArtifacts : null);
  let verifiedArtifacts = [];
  if (declaredArtifacts) {
    if (!workspace) {
      return {
        status: 'error',
        normalizedStatus: 'error',
        summary: 'Artifact verification could not run because the approved workspace is missing.',
        error: 'Artifact verification could not run because the approved workspace is missing.',
        checks: inferChecks(summary, suppliedChecks),
        artifacts: [],
      };
    }
    const artifactRes = verifyDeclaredArtifactsSync(workspace, declaredArtifacts);
    if (!artifactRes.satisfied) {
      if (artifactRes.reason === 'outside_workspace') {
        return {
          status: 'error',
          normalizedStatus: 'error',
          summary: artifactRes.error || 'Artifact path verification rejected.',
          error: artifactRes.error || 'Artifact path verification rejected.',
          checks: { build: 'not_run', tests: 'not_run' },
          artifacts: [],
        };
      }
      // Missing declared artifact prevents task from being DONE -> waiting
      return {
        status: 'waiting',
        normalizedStatus: 'waiting',
        summary,
        error: null,
        interimReason: artifactRes.error || 'Declared artifact verification is not yet satisfied.',
        checks: { build: 'not_run', tests: 'not_run' },
        artifacts: [],
      };
    }
    verifiedArtifacts = artifactRes.verified;
  }

  // 5. A clean process exit is only evidence that the transport stopped. Plain
  // text must explicitly say it completed; structured finals must say completed.
  if (final.kind === 'text' && !hasExplicitCompletion(summary)) {
    return {
      status: 'waiting',
      normalizedStatus: 'waiting',
      summary,
      error: null,
      interimReason: 'Final response did not explicitly confirm completion.',
      checks: inferChecks(summary),
      artifacts: [],
    };
  }

  return {
    status: 'done',
    normalizedStatus: 'completed',
    summary,
    error: null,
    checks: inferChecks(summary, suppliedChecks),
    artifacts: verifiedArtifacts,
  };
};
