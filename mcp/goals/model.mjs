import crypto from 'node:crypto';
import { redactSecrets } from '../executors/antigravity.mjs';
import { parseXTask } from '../x/task-contract.mjs';

export const GOAL_STATUSES = Object.freeze([
  'draft',
  'ready',
  'running',
  'waiting',
  'paused',
  'error',
  'completed',
]);

export const STEP_STATUSES = Object.freeze([
  'pending',
  'running',
  'waiting',
  'paused',
  'error',
  'completed',
  'skipped',
]);

export const STEP_ROUTES = Object.freeze([
  'auto',
  'mcp',
  'antigravity',
  'manual',
  'x',
]);

/**
 * Validates a step object schema and attributes.
 * @param {any} step
 * @returns {object} validated step
 */
export const validateStep = (step) => {
  if (!step || typeof step !== 'object') {
    throw new Error('Step must be a valid object');
  }

  const id = typeof step.id === 'string' && step.id.trim() ? step.id.trim() : crypto.randomUUID();
  if (typeof step.title !== 'string' || !step.title.trim()) {
    throw new Error('Step title must be a non-empty string');
  }
  const title = step.title.trim().slice(0, 200);
  const description = typeof step.description === 'string' ? step.description.trim().slice(0, 2000) : '';

  const route = STEP_ROUTES.includes(step.route) ? step.route : 'antigravity';
  const resolvedRoute = ['mcp', 'antigravity', 'manual'].includes(step.resolvedRoute) ? step.resolvedRoute : null;
  const routeReason = typeof step.routeReason === 'string' ? redactSecrets(step.routeReason).slice(0, 300) : null;
  const status = STEP_STATUSES.includes(step.status) ? step.status : 'pending';
  const required = step.required !== false; // defaults to true

  // A route:'x' step must carry a COMPLETE, already-authored x-task-v1
  // payload -- Hearth never synthesizes one from title/description. The
  // real, unmodified parseXTask() is the sole authority on validity; its
  // canonical return value (not the raw input) is what's stored, so the
  // same object round-trips unchanged through every future save/load.
  let xTask = null;
  if (route === 'x') {
    if (!step.xTask || typeof step.xTask !== 'object') {
      throw new Error(`Step '${title}' has route "x" but no xTask; a complete x-task-v1 payload is required`);
    }
    try {
      xTask = parseXTask(step.xTask);
    } catch (err) {
      throw new Error(`Step '${title}' has route "x" but an invalid xTask: ${err.message}`);
    }
  }

  return {
    id,
    title,
    description,
    status,
    route,
    resolvedRoute,
    routeReason,
    required,
    xTask,
    result: typeof step.result === 'string' ? redactSecrets(step.result) : null,
    evidence: step.evidence ? sanitizeEvidence(step.evidence) : null,
    startedAt: step.startedAt || null,
    finishedAt: step.finishedAt || null,
  };
};

/**
 * Sanitizes evidence structure ensuring no tokens, secrets, or raw transcripts exist.
 * @param {any} evidence
 * @returns {any}
 */
export const sanitizeEvidence = (evidence) => {
  if (!evidence) return null;
  if (typeof evidence === 'string') {
    return redactSecrets(evidence).slice(0, 4000);
  }
  if (Array.isArray(evidence)) {
    return evidence.slice(0, 50).map((item) => sanitizeEvidence(item));
  }
  if (typeof evidence === 'object') {
    const clean = {};
    for (const [key, value] of Object.entries(evidence)) {
      // Forbidden fields
      if (/^(transcript|rawTranscript|token|secret|oauth|password|key|env|credentials)$/i.test(key)) {
        continue;
      }
      clean[key] = sanitizeEvidence(value);
    }
    return clean;
  }
  return evidence;
};

/**
 * Validates a durable Goal-level X approval snapshot (Phase 2 slice):
 * `{ approvedAt, workspaceRoot, steps: [{ stepId, xTaskFingerprint }] }`.
 * Purely a shape/sanitization check -- the fingerprint VALUE itself is
 * computed and verified only by Electron's resolveGoalXApproval (the real
 * canonicalizeXTask/computeXTaskFingerprint formula ingestXTask itself
 * uses), never re-derived here; this module has no filesystem/workspace-
 * realpath access and must not pretend to. Any malformed/incomplete input
 * (including a bare `{}` or a steps entry missing either field) normalizes
 * to `null` -- a missing approval, never a half-valid one -- so a stale or
 * corrupted record fails closed to the normal per-step Ask flow rather
 * than granting a partial bypass.
 * @param {any} approval
 * @returns {{approvedAt: string, workspaceRoot: string, steps: {stepId: string, xTaskFingerprint: string}[]} | null}
 */
export const validateXApproval = (approval) => {
  if (!approval || typeof approval !== 'object') return null;
  if (typeof approval.workspaceRoot !== 'string' || !approval.workspaceRoot.trim()) return null;
  if (!Array.isArray(approval.steps)) return null;

  const steps = approval.steps
    .filter((s) => s && typeof s.stepId === 'string' && s.stepId.trim() && typeof s.xTaskFingerprint === 'string' && s.xTaskFingerprint.trim())
    .map((s) => ({ stepId: s.stepId.trim(), xTaskFingerprint: s.xTaskFingerprint.trim() }));
  if (steps.length === 0) return null;

  return {
    approvedAt: typeof approval.approvedAt === 'string' && approval.approvedAt ? approval.approvedAt : new Date().toISOString(),
    workspaceRoot: approval.workspaceRoot.trim(),
    steps,
  };
};

/**
 * Validates a goal object schema and attributes.
 * @param {any} goal
 * @returns {object} validated goal
 */
export const validateGoal = (goal) => {
  if (!goal || typeof goal !== 'object') {
    throw new Error('Goal must be a valid object');
  }

  const id = typeof goal.id === 'string' && goal.id.trim() ? goal.id.trim() : crypto.randomUUID();

  if (typeof goal.title !== 'string' || !goal.title.trim()) {
    throw new Error('Goal title must be a non-empty string');
  }
  const title = goal.title.trim().slice(0, 200);

  if (typeof goal.objective !== 'string' || !goal.objective.trim()) {
    throw new Error('Goal objective must be a non-empty string');
  }
  const objective = goal.objective.trim().slice(0, 4000);

  if (typeof goal.workspace !== 'string' || !goal.workspace.trim()) {
    throw new Error('Goal must be bound to a workspace');
  }
  const workspace = goal.workspace.trim();

  const status = GOAL_STATUSES.includes(goal.status) ? goal.status : 'draft';

  const rawConstraints = Array.isArray(goal.constraints)
    ? goal.constraints
    : typeof goal.constraints === 'string'
      ? goal.constraints.split('\n').map((c) => c.trim()).filter(Boolean)
      : [];
  const constraints = rawConstraints.map((c) => String(c).slice(0, 200)).slice(0, 20);

  const rawSteps = Array.isArray(goal.steps) ? goal.steps : [];
  const steps = rawSteps.map(validateStep);

  const currentStepId = typeof goal.currentStepId === 'string' && goal.currentStepId ? goal.currentStepId : (steps[0]?.id || null);

  const checkpoints = Array.isArray(goal.checkpoints) ? goal.checkpoints.map(validateGoalCheckpoint) : [];
  const xApproval = validateXApproval(goal.xApproval);
  const reviewQueue = Array.isArray(goal.reviewQueue)
    ? goal.reviewQueue.map(validateReviewQueueItem).filter(Boolean)
    : [];

  const now = new Date().toISOString();

  return {
    id,
    title,
    objective,
    workspace,
    status,
    constraints,
    steps,
    currentStepId,
    checkpoints,
    xApproval,
    reviewQueue,
    createdAt: goal.createdAt || now,
    startedAt: goal.startedAt || null,
    updatedAt: goal.updatedAt || now,
    finishedAt: goal.finishedAt || null,
    error: goal.error ? redactSecrets(String(goal.error)) : null,
  };
};

/**
 * Creates a sanitized goal checkpoint.
 * STRICT: Prohibits raw transcripts, OAuth tokens, session secrets, and full agent prompts.
 *
 * @param {object} params
 * @returns {object} checkpoint
 */
export const createGoalCheckpoint = ({
  goalId,
  stepId,
  summary,
  completedSteps,
  evidence = null,
  filesChanged = [],
  checks = {},
  nextStep = null,
  route = 'antigravity',
}) => {
  if (!goalId || typeof goalId !== 'string') throw new Error('goalId is required for checkpoint');

  const cleanSummary = typeof summary === 'string' ? redactSecrets(summary).slice(0, 2000) : '';
  const cleanFiles = Array.isArray(filesChanged) ? filesChanged.map((f) => String(f).slice(0, 500)).slice(0, 50) : [];
  const cleanChecks = {};
  if (checks && typeof checks === 'object') {
    for (const [k, v] of Object.entries(checks)) {
      cleanChecks[k.slice(0, 100)] = Boolean(v);
    }
  }

  return {
    id: crypto.randomUUID(),
    goalId,
    stepId: stepId || null,
    timestamp: new Date().toISOString(),
    summary: cleanSummary,
    completedSteps: typeof completedSteps === 'number' ? completedSteps : 0,
    evidence: sanitizeEvidence(evidence),
    filesChanged: cleanFiles,
    checks: cleanChecks,
    nextStep: nextStep ? String(nextStep) : null,
    route: String(route || 'antigravity'),
  };
};

export const validateGoalCheckpoint = (cp) => {
  if (!cp || typeof cp !== 'object') throw new Error('Checkpoint must be an object');
  return createGoalCheckpoint(cp);
};

export const REVIEW_ITEM_STATUSES = Object.freeze(['needs_review', 'failed']);

/**
 * Creates a sanitized Review Queue item: a durable record that a step's
 * terminal outcome needs the user's/Chat's attention (X's own NEEDS_REVIEW
 * or FAILED terminal truth -- never INTERRUPTED, which is recoverable/
 * waiting on its own and never enters this queue). Reference-only by
 * design: only ids and structured, already-sanitized evidence are stored,
 * never a raw transcript or chain-of-thought.
 * STRICT: reason/evidence both pass through the SAME redaction/sanitization
 * as everything else in this module.
 *
 * @param {object} params
 * @returns {object} review queue item
 */
export const createReviewQueueItem = ({
  idempotencyKey,
  stepId = null,
  taskId = null,
  runId = null,
  resultId = null,
  status,
  reason,
  evidence = null,
}) => {
  if (!idempotencyKey || typeof idempotencyKey !== 'string') {
    throw new Error('idempotencyKey is required for a review queue item');
  }
  if (!REVIEW_ITEM_STATUSES.includes(status)) {
    throw new Error(`Review queue item status must be one of ${REVIEW_ITEM_STATUSES.join(', ')}`);
  }

  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    idempotencyKey: String(idempotencyKey).slice(0, 300),
    stepId: stepId ? String(stepId).slice(0, 200) : null,
    taskId: taskId ? String(taskId).slice(0, 200) : null,
    runId: runId ? String(runId).slice(0, 200) : null,
    resultId: resultId ? String(resultId).slice(0, 200) : null,
    status,
    reason: typeof reason === 'string' ? redactSecrets(reason).slice(0, 2000) : '',
    evidence: sanitizeEvidence(evidence),
    createdAt: now,
    updatedAt: now,
  };
};

export const validateReviewQueueItem = (item) => {
  if (!item || typeof item !== 'object') return null;
  if (!item.idempotencyKey || typeof item.idempotencyKey !== 'string') return null;
  if (!REVIEW_ITEM_STATUSES.includes(item.status)) return null;

  return {
    id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : crypto.randomUUID(),
    idempotencyKey: String(item.idempotencyKey).slice(0, 300),
    stepId: item.stepId ? String(item.stepId).slice(0, 200) : null,
    taskId: item.taskId ? String(item.taskId).slice(0, 200) : null,
    runId: item.runId ? String(item.runId).slice(0, 200) : null,
    resultId: item.resultId ? String(item.resultId).slice(0, 200) : null,
    status: item.status,
    reason: typeof item.reason === 'string' ? redactSecrets(item.reason).slice(0, 2000) : '',
    evidence: sanitizeEvidence(item.evidence),
    createdAt: item.createdAt || new Date().toISOString(),
    updatedAt: item.updatedAt || item.createdAt || new Date().toISOString(),
  };
};

/**
 * Helper to construct a new Goal instance.
 * Sets status to 'ready' if valid steps are present, otherwise 'draft'.
 */
export const createGoal = ({ title, objective, workspace, steps = [], constraints = [] }) => {
  const goal = validateGoal({
    title,
    objective,
    workspace,
    steps,
    constraints,
    status: steps.length > 0 ? 'ready' : 'draft',
  });
  return goal;
};
