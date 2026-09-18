import crypto from 'node:crypto';
import { redactSecrets } from '../executors/antigravity.mjs';
import { parseXTask } from '../x/task-contract.mjs';
import { validateSpecialistExecution, validateSpecialistResult, validateSpecialistResultDecision } from '../specialist/contract.mjs';

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

  // executionGeneration: Hearth-managed counter incremented on each new X
  // execution lineage for this step (retry, interrupted recovery). null means
  // first execution (generation 1, uses legacy requestId format). Integers >= 2
  // use the goal:id:step:id:exec:N requestId. Backward-compatible: stored Goals
  // without this field load as null and behave identically to Slice 1.
  const executionGeneration =
    Number.isInteger(step.executionGeneration) && step.executionGeneration >= 2
      ? step.executionGeneration
      : null;

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
    executionGeneration,
    result: typeof step.result === 'string' ? redactSecrets(step.result) : null,
    evidence: step.evidence ? sanitizeEvidence(step.evidence) : null,
    startedAt: step.startedAt || null,
    finishedAt: step.finishedAt || null,
    specialistResultId: typeof step.specialistResultId === 'string' ? step.specialistResultId.trim().slice(0, 300) : null,
    specialistExecutionId: typeof step.specialistExecutionId === 'string' ? step.specialistExecutionId.trim().slice(0, 300) : null,
    specialistHandoffId: typeof step.specialistHandoffId === 'string' ? step.specialistHandoffId.trim().slice(0, 300) : null,
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
 * Validates the durable local<->remote correlation link for a Goal imported
 * from a remote Goal-request row (e.g. Project X's public.goal_requests).
 * Reference-only: an id and a provider tag, never the remote payload itself
 * -- the local Goal (goals.json) is read exactly once at import time and is
 * the sole source of truth from then on; this field exists purely so a
 * resync sweep can find "which local Goals came from where" without
 * depending on any in-memory Map. A missing/malformed link normalizes to
 * `null` (fails closed to "not remote-linked"), never a half-valid one.
 * @param {any} link
 * @returns {{provider: string, requestId: string}|null}
 */
export const validateRemoteGoalRequestLink = (link) => {
  if (!link || typeof link !== 'object') return null;
  if (typeof link.provider !== 'string' || !link.provider.trim()) return null;
  if (typeof link.requestId !== 'string' || !link.requestId.trim()) return null;
  return { provider: link.provider.trim().slice(0, 100), requestId: link.requestId.trim().slice(0, 300) };
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

  const currentStepId = status === 'completed'
    ? null
    : (typeof goal.currentStepId === 'string' && goal.currentStepId ? goal.currentStepId : (steps[0]?.id || null));

  const checkpoints = Array.isArray(goal.checkpoints) ? goal.checkpoints.map(validateGoalCheckpoint) : [];
  const xApproval = validateXApproval(goal.xApproval);
  const reviewQueue = Array.isArray(goal.reviewQueue)
    ? goal.reviewQueue.map(validateReviewQueueItem).filter(Boolean)
    : [];
  const specialistHandoffs = Array.isArray(goal.specialistHandoffs)
    ? goal.specialistHandoffs.map(validateSpecialistHandoff).filter(Boolean)
    : [];
  const specialistExecutions = Array.isArray(goal.specialistExecutions)
    ? goal.specialistExecutions.map(validateSpecialistExecution).filter(Boolean)
    : [];
  const specialistResults = Array.isArray(goal.specialistResults)
    ? goal.specialistResults.map(validateSpecialistResult).filter(Boolean)
    : [];
  const specialistResultDecisions = Array.isArray(goal.specialistResultDecisions)
    ? goal.specialistResultDecisions.map(validateSpecialistResultDecision).filter(Boolean)
    : [];
  const remoteGoalRequest = validateRemoteGoalRequestLink(goal.remoteGoalRequest);

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
    specialistHandoffs,
    specialistExecutions,
    specialistResults,
    specialistResultDecisions,
    remoteGoalRequest,
    createdAt: goal.createdAt || now,
    startedAt: goal.startedAt || null,
    updatedAt: goal.updatedAt || now,
    finishedAt: goal.finishedAt || null,
    error: goal.error ? redactSecrets(String(goal.error)) : null,
  };
};

export const HANDOFF_TARGETS = Object.freeze(['codex', 'work']);
export const HANDOFF_LIFECYCLE_STATES = Object.freeze(['requested']);

/**
 * Validates a durable specialist handoff record.
 * @param {any} item
 * @returns {object|null}
 */
export const validateSpecialistHandoff = (item) => {
  if (!item || typeof item !== 'object') return null;
  if (typeof item.id !== 'string' || !item.id.trim()) return null;
  if (typeof item.goalId !== 'string' || !item.goalId.trim()) return null;
  if (typeof item.stepId !== 'string' || !item.stepId.trim()) return null;
  if (!HANDOFF_TARGETS.includes(item.target)) return null;
  if (!item.source || typeof item.source !== 'object') return null;
  if (typeof item.source.requestId !== 'string' || !item.source.requestId.trim()) return null;

  const now = new Date().toISOString();
  return {
    version: 'specialist-handoff-request-v1',
    id: item.id.trim().slice(0, 300),
    goalId: item.goalId.trim().slice(0, 200),
    stepId: item.stepId.trim().slice(0, 200),
    target: item.target,
    source: {
      worker: 'x',
      taskId: typeof item.source.taskId === 'string' ? item.source.taskId.slice(0, 200) : null,
      requestId: item.source.requestId.slice(0, 200),
      executionGeneration: Number.isInteger(item.source.executionGeneration) ? item.source.executionGeneration : null,
      runId: typeof item.source.runId === 'string' ? item.source.runId.slice(0, 200) : null,
      resultId: typeof item.source.resultId === 'string' ? item.source.resultId.slice(0, 200) : null,
      terminalStatus: typeof item.source.terminalStatus === 'string' ? item.source.terminalStatus.slice(0, 100) : 'needs_review',
      xTaskFingerprint: typeof item.source.xTaskFingerprint === 'string' ? item.source.xTaskFingerprint.slice(0, 200) : null,
    },
    reviewItemId: typeof item.reviewItemId === 'string' ? item.reviewItemId.slice(0, 200) : null,
    reason: typeof item.reason === 'string' ? redactSecrets(item.reason).slice(0, 2000) : '',
    requestedAction: typeof item.requestedAction === 'string' ? redactSecrets(item.requestedAction).slice(0, 2000) : '',
    lifecycle: HANDOFF_LIFECYCLE_STATES.includes(item.lifecycle) ? item.lifecycle : 'requested',
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : now,
    createdBy: typeof item.createdBy === 'string' ? redactSecrets(item.createdBy).slice(0, 200) : null,
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
export const REVIEW_ITEM_LIFECYCLES = Object.freeze(['open', 'acknowledged', 'resolved', 'superseded']);
export const REVIEW_ITEM_RESOLUTIONS = Object.freeze(['accepted', 'rejected']);

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
  lifecycle = 'open',
  acknowledgedAt = null,
  acknowledgedBy = null,
  resolvedAt = null,
  resolution = null,
  note = null,
  reason,
  evidence = null,
}) => {
  if (!idempotencyKey || typeof idempotencyKey !== 'string') {
    throw new Error('idempotencyKey is required for a review queue item');
  }
  if (!REVIEW_ITEM_STATUSES.includes(status)) {
    throw new Error(`Review queue item status must be one of ${REVIEW_ITEM_STATUSES.join(', ')}`);
  }
  const cleanLifecycle = REVIEW_ITEM_LIFECYCLES.includes(lifecycle) ? lifecycle : 'open';

  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    idempotencyKey: String(idempotencyKey).slice(0, 300),
    stepId: stepId ? String(stepId).slice(0, 200) : null,
    taskId: taskId ? String(taskId).slice(0, 200) : null,
    runId: runId ? String(runId).slice(0, 200) : null,
    resultId: resultId ? String(resultId).slice(0, 200) : null,
    status,
    lifecycle: cleanLifecycle,
    acknowledgedAt: typeof acknowledgedAt === 'string' ? acknowledgedAt : null,
    acknowledgedBy: typeof acknowledgedBy === 'string' ? redactSecrets(acknowledgedBy).slice(0, 200) : null,
    resolvedAt: typeof resolvedAt === 'string' ? resolvedAt : null,
    resolution: typeof resolution === 'string' ? resolution : null,
    note: typeof note === 'string' ? redactSecrets(note).slice(0, 2000) : null,
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

  const lifecycle = REVIEW_ITEM_LIFECYCLES.includes(item.lifecycle) ? item.lifecycle : 'open';

  return {
    id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : crypto.randomUUID(),
    idempotencyKey: String(item.idempotencyKey).slice(0, 300),
    stepId: item.stepId ? String(item.stepId).slice(0, 200) : null,
    taskId: item.taskId ? String(item.taskId).slice(0, 200) : null,
    runId: item.runId ? String(item.runId).slice(0, 200) : null,
    resultId: item.resultId ? String(item.resultId).slice(0, 200) : null,
    status: item.status,
    lifecycle,
    acknowledgedAt: typeof item.acknowledgedAt === 'string' ? item.acknowledgedAt : null,
    acknowledgedBy: typeof item.acknowledgedBy === 'string' ? redactSecrets(item.acknowledgedBy).slice(0, 200) : null,
    resolvedAt: typeof item.resolvedAt === 'string' ? item.resolvedAt : null,
    resolution: typeof item.resolution === 'string' ? item.resolution : null,
    // supersededAt: set when lifecycle transitions to 'superseded' (human retry preparation).
    supersededAt: typeof item.supersededAt === 'string' ? item.supersededAt : null,
    note: typeof item.note === 'string' ? redactSecrets(item.note).slice(0, 2000) : null,
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
export const createGoal = ({ id, title, objective, workspace, steps = [], constraints = [], remoteGoalRequest = null }) => {
  const goal = validateGoal({
    id,
    title,
    objective,
    workspace,
    steps,
    constraints,
    remoteGoalRequest,
    status: steps.length > 0 ? 'ready' : 'draft',
  });
  return goal;
};
