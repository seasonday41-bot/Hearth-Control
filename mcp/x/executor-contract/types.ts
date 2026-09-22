export type XCommitPolicyMode = 'never' | 'require_user_approval' | 'after_tests';

export interface XWorkspaceRef {
  repo: string;
  root: string;
}

export interface XTaskScope {
  workspace?: XWorkspaceRef;
  allowed_paths: string[];
  preferred_files: string[];
  forbidden_paths: string[];
  reference_paths?: string[];
}

export interface XTaskConstraints {
  preserve: string[];
  do_not: string[];
}

export interface XTaskValidationBlock {
  required: string[];
  optional: string[];
}

export interface XTaskUncertaintyPolicy {
  policy: string;
  stop_conditions: string[];
}

export interface XTaskRepairBudget {
  initial_attempts: 1;
  max_repairs: 0 | 1 | 2;
  max_total_rounds: 1 | 2 | 3;
}

export interface XTaskTiming {
  estimated_minutes: number;
  first_check_after_minutes: number;
  soft_deadline_minutes: number;
  hard_timeout_minutes: number;
}

export interface XTaskV1 {
  version: 'x-task-v1';
  task_id: string;
  parent_task_id: string | null;
  revision: number;
  attempt: number;
  based_on_result_id: string | null;
  objective: string;
  problem: string;
  expected_behavior: string;
  observed_behavior: string;
  why_this_matters: string;
  known_evidence: string[];
  suspected_area: string[];
  workspace?: XWorkspaceRef;
  scope: XTaskScope;
  constraints: XTaskConstraints;
  allowed_tools: string[];
  acceptance_criteria: string[];
  validation?: XTaskValidationBlock;
  verification?: XTaskValidationBlock;
  done_criteria: string[];
  teaching_notes: string[];
  uncertainty_policy?: XTaskUncertaintyPolicy;
  uncertainty?: XTaskUncertaintyPolicy;
  repair_budget: XTaskRepairBudget;
  timing: XTaskTiming;
  commit_policy: XCommitPolicyMode | { mode: XCommitPolicyMode };
}

export const EXECUTOR_API_VERSION = 'x-executor-api-v1' as const;

export interface SubmitRequest {
  version: typeof EXECUTOR_API_VERSION;
  idempotency_key: string;
  lease_expires_at: number;
  task: XTaskV1;
}

export interface StatusRequest {
  version: typeof EXECUTOR_API_VERSION;
  run_id: string;
}

export interface CancelRequest {
  version: typeof EXECUTOR_API_VERSION;
  run_id: string;
}

export interface LeaseValidRequest {
  version: typeof EXECUTOR_API_VERSION;
  run_id: string;
  lease_expires_at: number;
}

export type ExecutorRunStatus =
  | 'submitted'
  | 'running'
  | 'completed'
  | 'needs_review'
  | 'failed'
  | 'interrupted'
  | 'cancelled';

export interface SubmitResponse {
  version: typeof EXECUTOR_API_VERSION;
  run_id: string;
  status: ExecutorRunStatus;
  duplicate: boolean;
}

export type RepairStatus = 'validated' | 'escalation_required';
export type RepairClassification = 'repairable' | 'escalate' | null;

export interface RepairBlocker {
  reason?: string;
  code?: string;
  path?: string;
  detail?: string | null;
  [key: string]: unknown;
}

export interface RepairValidationResult {
  command: string;
  status: string;
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  stdout?: string;
  stderr?: string;
  summary?: string;
  [key: string]: unknown;
}

export interface RepairRound {
  round: number;
  kind: 'execution' | 'validation';
  executor: Record<string, unknown>;
  validation: {
    required: RepairValidationResult[];
    optional: RepairValidationResult[];
  } | null;
  classification: RepairClassification;
}

export interface RepairOutcome {
  task_id: string | null;
  status: RepairStatus;
  rounds: RepairRound[];
  total_rounds: number;
  blockers: RepairBlocker[];
}

export interface ExecutorStatusResponse<TResult = RepairOutcome> {
  version: typeof EXECUTOR_API_VERSION;
  run_id: string;
  status: ExecutorRunStatus;
  result: TResult | null;
  error: string | null;
}

export interface CancelResponse {
  version: typeof EXECUTOR_API_VERSION;
  run_id: string;
  status: ExecutorRunStatus;
  acknowledged: boolean;
}

export interface LeaseValidResponse {
  version: typeof EXECUTOR_API_VERSION;
  run_id: string;
  status: ExecutorRunStatus;
  lease_expires_at: number | null;
  accepted: boolean;
}
