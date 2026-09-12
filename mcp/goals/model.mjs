import crypto from 'node:crypto';
import { redactSecrets } from '../executors/antigravity.mjs';

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

  return {
    id,
    title,
    description,
    status,
    route,
    resolvedRoute,
    routeReason,
    required,
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
