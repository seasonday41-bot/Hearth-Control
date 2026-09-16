import crypto from 'node:crypto';
import { redactSecrets } from '../executors/antigravity.mjs';

export const SPECIALIST_TARGETS = Object.freeze(['codex', 'work']);

export const SPECIALIST_EXECUTION_STATUSES = Object.freeze([
  'authorized',
  'dispatching',
  'running',
  'completed',
  'failed',
  'interrupted',
]);

export const SPECIALIST_RESULT_STATUSES = Object.freeze([
  'completed',
  'needs_review',
  'failed',
  'interrupted',
]);

/**
 * Derives a deterministic durable specialist execution ID.
 * @param {string} handoffId
 * @param {number|null} [generation=null]
 * @returns {string}
 */
export function deriveSpecialistExecutionId(handoffId, generation = null) {
  if (!handoffId || typeof handoffId !== 'string') {
    throw new Error('handoffId is required to derive specialist execution ID');
  }
  const cleanHandoffId = handoffId.trim();
  if (Number.isInteger(generation) && generation >= 2) {
    return `specialist-exec:${cleanHandoffId}:exec:${generation}`;
  }
  return `specialist-exec:${cleanHandoffId}`;
}

/**
 * Validates a durable specialist execution record.
 * @param {any} item
 * @returns {object|null}
 */
export function validateSpecialistExecution(item) {
  if (!item || typeof item !== 'object') return null;
  if (typeof item.id !== 'string' || !item.id.trim()) return null;
  if (typeof item.handoffId !== 'string' || !item.handoffId.trim()) return null;
  if (typeof item.goalId !== 'string' || !item.goalId.trim()) return null;
  if (typeof item.stepId !== 'string' || !item.stepId.trim()) return null;
  if (!SPECIALIST_TARGETS.includes(item.target)) return null;
  if (!item.source || typeof item.source !== 'object') return null;
  if (typeof item.source.requestId !== 'string' || !item.source.requestId.trim()) return null;

  const status = SPECIALIST_EXECUTION_STATUSES.includes(item.status) ? item.status : 'authorized';
  const now = new Date().toISOString();

  return {
    version: 'specialist-execution-v1',
    id: item.id.trim().slice(0, 300),
    handoffId: item.handoffId.trim().slice(0, 300),
    target: item.target,
    goalId: item.goalId.trim().slice(0, 200),
    stepId: item.stepId.trim().slice(0, 200),
    generation: Number.isInteger(item.generation) ? item.generation : 1,
    status,
    workspace: typeof item.workspace === 'string' ? item.workspace.trim().slice(0, 1000) : '',
    source: {
      worker: 'x',
      requestId: item.source.requestId.slice(0, 200),
      runId: typeof item.source.runId === 'string' ? item.source.runId.slice(0, 200) : null,
      resultId: typeof item.source.resultId === 'string' ? item.source.resultId.slice(0, 200) : null,
      taskId: typeof item.source.taskId === 'string' ? item.source.taskId.slice(0, 200) : null,
      xTaskFingerprint: typeof item.source.xTaskFingerprint === 'string' ? item.source.xTaskFingerprint.slice(0, 200) : null,
    },
    jobId: typeof item.jobId === 'string' ? item.jobId.slice(0, 200) : null,
    codexSessionId: typeof item.codexSessionId === 'string' ? item.codexSessionId.slice(0, 200) : null,
    authorizedAt: typeof item.authorizedAt === 'string' ? item.authorizedAt : now,
    authorizedBy: typeof item.authorizedBy === 'string' ? redactSecrets(item.authorizedBy).slice(0, 200) : 'MainBrain',
    startedAt: typeof item.startedAt === 'string' ? item.startedAt : null,
    finishedAt: typeof item.finishedAt === 'string' ? item.finishedAt : null,
    resultId: typeof item.resultId === 'string' ? item.resultId.slice(0, 200) : null,
    error: item.error ? redactSecrets(String(item.error)).slice(0, 2000) : null,
  };
}

/**
 * Validates a durable specialist result record.
 * @param {any} item
 * @returns {object|null}
 */
export function validateSpecialistResult(item) {
  if (!item || typeof item !== 'object') return null;
  if (typeof item.id !== 'string' || !item.id.trim()) return null;
  if (typeof item.executionId !== 'string' || !item.executionId.trim()) return null;
  if (typeof item.handoffId !== 'string' || !item.handoffId.trim()) return null;
  if (typeof item.goalId !== 'string' || !item.goalId.trim()) return null;
  if (typeof item.stepId !== 'string' || !item.stepId.trim()) return null;
  if (!SPECIALIST_TARGETS.includes(item.target)) return null;

  const status = SPECIALIST_RESULT_STATUSES.includes(item.status) ? item.status : 'needs_review';
  const now = new Date().toISOString();

  return {
    version: 'specialist-result-v1',
    id: item.id.trim().slice(0, 300),
    executionId: item.executionId.trim().slice(0, 300),
    handoffId: item.handoffId.trim().slice(0, 300),
    goalId: item.goalId.trim().slice(0, 200),
    stepId: item.stepId.trim().slice(0, 200),
    target: item.target,
    status,
    summary: typeof item.summary === 'string' ? redactSecrets(item.summary).slice(0, 4000) : '',
    codex: {
      sessionId: typeof item.codex?.sessionId === 'string' ? item.codex.sessionId.slice(0, 200) : null,
      exitCode: typeof item.codex?.exitCode === 'number' ? item.codex.exitCode : null,
      signal: typeof item.codex?.signal === 'string' ? item.codex.signal : null,
    },
    git: {
      preHead: typeof item.git?.preHead === 'string' ? item.git.preHead.slice(0, 100) : null,
      postHead: typeof item.git?.postHead === 'string' ? item.git.postHead.slice(0, 100) : null,
      preDirtyPaths: Array.isArray(item.git?.preDirtyPaths) ? item.git.preDirtyPaths.map((p) => String(p).slice(0, 500)) : [],
      postChangedPaths: Array.isArray(item.git?.postChangedPaths) ? item.git.postChangedPaths.map((p) => String(p).slice(0, 500)) : [],
      commitsCreated: Boolean(item.git?.commitsCreated),
    },
    boundary: {
      allowedPathsValid: item.boundary?.allowedPathsValid !== false,
      forbiddenPathsValid: item.boundary?.forbiddenPathsValid !== false,
      violations: Array.isArray(item.boundary?.violations) ? item.boundary.violations.map((v) => redactSecrets(String(v)).slice(0, 500)) : [],
    },
    validation: {
      claimed: typeof item.validation?.claimed === 'object' ? item.validation.claimed : null,
      observed: typeof item.validation?.observed === 'object' ? item.validation.observed : null,
    },
    startedAt: typeof item.startedAt === 'string' ? item.startedAt : now,
    finishedAt: typeof item.finishedAt === 'string' ? item.finishedAt : now,
    error: item.error ? redactSecrets(String(item.error)).slice(0, 2000) : null,
  };
}

export const SPECIALIST_DECISION_STATES = Object.freeze(['accepted', 'rejected']);

/**
 * Validates a durable specialist result decision record.
 * @param {any} item
 * @returns {object|null}
 */
export function validateSpecialistResultDecision(item) {
  if (!item || typeof item !== 'object') return null;
  if (typeof item.id !== 'string' || !item.id.trim()) return null;
  if (typeof item.resultId !== 'string' || !item.resultId.trim()) return null;
  if (typeof item.executionId !== 'string' || !item.executionId.trim()) return null;
  if (typeof item.handoffId !== 'string' || !item.handoffId.trim()) return null;
  if (typeof item.goalId !== 'string' || !item.goalId.trim()) return null;
  if (typeof item.stepId !== 'string' || !item.stepId.trim()) return null;
  if (!SPECIALIST_DECISION_STATES.includes(item.decision)) return null;

  const now = new Date().toISOString();

  return {
    version: 'specialist-result-decision-v1',
    id: item.id.trim().slice(0, 300),
    resultId: item.resultId.trim().slice(0, 300),
    executionId: item.executionId.trim().slice(0, 300),
    handoffId: item.handoffId.trim().slice(0, 300),
    goalId: item.goalId.trim().slice(0, 200),
    stepId: item.stepId.trim().slice(0, 200),
    decision: item.decision,
    decidedAt: typeof item.decidedAt === 'string' ? item.decidedAt : now,
    decidedBy: typeof item.decidedBy === 'string' ? redactSecrets(item.decidedBy).slice(0, 200) : 'MainBrain',
    note: item.note ? redactSecrets(String(item.note)).slice(0, 2000) : null,
  };
}
