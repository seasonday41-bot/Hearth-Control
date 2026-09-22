import crypto from 'node:crypto';
import path from 'node:path';
import { parseHearthJob } from './hearth-job-contract.mjs';
import { parseXTask } from '../x/task-contract.mjs';

export const HEARTH_JOB_ROUTES = Object.freeze({
  code_change: 'x',
  code_inspect: 'x',
  market_search: 'market',
  investment_analysis: 'market',
});

export const hearthJobTaskId = (jobId) => `hearthjob:${jobId}`;
export const hearthJobXRequestId = (jobId) => `hearthjob:${jobId}`;

export const routeHearthJob = (input) => {
  const job = parseHearthJob(input);
  const route = HEARTH_JOB_ROUTES[job.kind];
  if (!route) throw new Error('hearth_job_route_unavailable');
  return {
    job,
    route,
    reason: route === 'x'
      ? `Hearth Router · ${job.kind} uses X coding pipeline`
        : job.kind === 'market_search'
          ? 'Hearth Router · market_search uses XAU/USD Search AI'
          : 'Hearth Router · investment_analysis uses XAU/USD Invest AI',
  };
};

export const computeHearthJobFingerprint = (input) => {
  const job = parseHearthJob(input);
  return crypto.createHash('sha256').update(JSON.stringify(job)).digest('hex');
};

export const adaptHearthJobToXTask = (input, { workspaceRoot, repo = null } = {}) => {
  const { job, route } = routeHearthJob(input);
  if (route !== 'x') throw new Error('hearth_job_not_x_routable');
  if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) throw new Error('hearth_job_workspace_required');

  const effectiveRepo = typeof repo === 'string' && repo.trim()
    ? repo.trim()
    : path.basename(workspaceRoot.replace(/\/+$/, '')) || 'workspace';
  const acceptance = job.acceptance_criteria;
  const doneCriteria = job.done_criteria.length ? job.done_criteria : acceptance;
  const stopConditions = job.stop_conditions.length
    ? job.stop_conditions
    : ['Stop and report if required evidence is unavailable or a safety/authorization boundary is reached.'];

  const genericFingerprint = computeHearthJobFingerprint(job);
  const xTask = {
    version: 'x-task-v1',
    task_id: hearthJobTaskId(job.job_id),
    parent_task_id: null,
    revision: 1,
    attempt: 1,
    based_on_result_id: null,
    objective: job.objective,
    problem: job.problem || job.objective,
    expected_behavior: job.expected_behavior || job.objective,
    observed_behavior: job.observed_behavior || 'The current repository has not yet been verified to satisfy the requested objective.',
    why_this_matters: job.why_this_matters || job.objective,
    known_evidence: [...job.known_evidence, `Hearth generic job fingerprint: ${genericFingerprint}`],
    suspected_area: job.suspected_area,
    workspace: { repo: effectiveRepo, root: workspaceRoot },
    scope: {
      allowed_paths: job.scope.allowed_paths,
      preferred_files: job.scope.preferred_files,
      forbidden_paths: job.scope.forbidden_paths,
    },
    constraints: {
      preserve: job.constraints.preserve,
      do_not: job.constraints.do_not,
    },
    allowed_tools: job.kind === 'code_change' ? ['repo_read', 'repo_edit'] : ['repo_read'],
    acceptance_criteria: acceptance,
    validation: {
      required: job.validation.required,
      optional: job.validation.optional,
    },
    done_criteria: doneCriteria,
    teaching_notes: [],
    uncertainty_policy: {
      policy: 'stop_and_report',
      stop_conditions: stopConditions,
    },
    repair_budget: {
      initial_attempts: 1,
      max_repairs: 2,
      max_total_rounds: 3,
    },
    timing: {
      estimated_minutes: 30,
      first_check_after_minutes: 5,
      soft_deadline_minutes: 20,
      hard_timeout_minutes: 45,
    },
    commit_policy: { mode: 'never' },
  };

  return parseXTask(xTask);
};
