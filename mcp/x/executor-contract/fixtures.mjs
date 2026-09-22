const clone = (value) => structuredClone(value);

export const makeValidTask = () => ({
  version: 'x-task-v1',
  task_id: 'task-1',
  parent_task_id: null,
  revision: 1,
  attempt: 1,
  based_on_result_id: null,
  objective: 'Make the requested change.',
  problem: 'Current behavior does not satisfy the task.',
  expected_behavior: 'The requested behavior is implemented.',
  observed_behavior: 'The requested behavior is not implemented yet.',
  why_this_matters: 'The task needs deterministic completion evidence.',
  known_evidence: ['baseline inspected'],
  suspected_area: ['mcp/x'],
  workspace: { repo: 'hearth-control', root: '/workspace/hearth-control' },
  scope: {
    allowed_paths: ['mcp/x'],
    preferred_files: ['mcp/x/run-x-task.mjs'],
    forbidden_paths: ['private'],
    reference_paths: ['docs'],
  },
  constraints: {
    preserve: ['existing behavior outside scope'],
    do_not: ['do not change unrelated files'],
  },
  allowed_tools: ['repo_edit'],
  acceptance_criteria: ['targeted tests pass'],
  validation: {
    required: ['node --test scripts/test-x-run-store.mjs'],
    optional: [],
  },
  done_criteria: ['requested behavior is implemented'],
  teaching_notes: [],
  uncertainty_policy: {
    policy: 'stop when authority is unclear',
    stop_conditions: ['scope cannot be proven'],
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
    hard_timeout_minutes: 30,
  },
  commit_policy: { mode: 'never' },
});

const valid = (name, mutate = () => {}) => {
  const input = makeValidTask();
  mutate(input);
  return { name, expectedOk: true, input };
};

const invalid = (name, mutate) => {
  const input = makeValidTask();
  mutate(input);
  return { name, expectedOk: false, input };
};

export const differentialFixtures = [
  valid('canonical valid task'),
  valid('commit policy never as string', (task) => { task.commit_policy = 'never'; }),
  valid('commit policy require_user_approval', (task) => { task.commit_policy = { mode: 'require_user_approval' }; }),
  valid('commit policy after_tests', (task) => { task.commit_policy = { mode: 'after_tests' }; }),
  valid('legacy verification fallback', (task) => {
    delete task.validation;
    task.verification = { required: ['npm test'], optional: [] };
  }),
  valid('legacy uncertainty fallback', (task) => {
    delete task.uncertainty_policy;
    task.uncertainty = { policy: 'stop', stop_conditions: [] };
  }),
  valid('workspace supplied through scope.workspace fallback', (task) => {
    const workspace = clone(task.workspace);
    delete task.workspace;
    task.scope.workspace = workspace;
  }),
  valid('nullable ids supplied as non-empty strings', (task) => {
    task.parent_task_id = 'parent-1';
    task.based_on_result_id = 'result-1';
  }),

  { name: 'non-object task', expectedOk: false, input: null },
  invalid('unknown top-level field', (task) => { task.extra_authority = true; }),
  invalid('invalid version', (task) => { task.version = 'x-task-v2'; }),
  invalid('missing task_id', (task) => { task.task_id = ''; }),
  invalid('missing objective', (task) => { task.objective = '   '; }),
  invalid('missing problem', (task) => { delete task.problem; }),
  invalid('missing expected_behavior', (task) => { task.expected_behavior = null; }),
  invalid('missing observed_behavior', (task) => { task.observed_behavior = ''; }),
  invalid('missing why_this_matters', (task) => { task.why_this_matters = 42; }),
  invalid('revision below one', (task) => { task.revision = 0; }),
  invalid('revision not integer', (task) => { task.revision = 1.5; }),
  invalid('attempt below one', (task) => { task.attempt = 0; }),
  invalid('attempt not integer', (task) => { task.attempt = '1'; }),
  invalid('invalid parent_task_id', (task) => { task.parent_task_id = ''; }),
  invalid('invalid based_on_result_id', (task) => { task.based_on_result_id = 1; }),

  invalid('string-array field wrong type', (task) => { task.known_evidence = null; }),
  invalid('string-array field contains blank value', (task) => { task.allowed_tools = ['repo_edit', '']; }),
  invalid('acceptance criteria must not be empty', (task) => { task.acceptance_criteria = []; }),
  invalid('done criteria must not be empty', (task) => { task.done_criteria = []; }),

  invalid('workspace missing repo/root', (task) => { task.workspace = { repo: '', root: '' }; }),
  invalid('workspace wrong type', (task) => { task.workspace = 'workspace'; }),
  invalid('workspace conflicts with scope.workspace', (task) => {
    task.scope.workspace = { repo: 'other-repo', root: '/workspace/other' };
  }),
  invalid('scope wrong type', (task) => { task.scope = null; }),
  invalid('allowed_paths wrong type', (task) => { task.scope.allowed_paths = 'mcp/x'; }),
  invalid('preferred_files wrong type', (task) => { task.scope.preferred_files = null; }),
  invalid('forbidden_paths wrong type', (task) => { task.scope.forbidden_paths = {}; }),
  invalid('allowed_paths empty', (task) => { task.scope.allowed_paths = []; }),
  invalid('scope paths exceed count limit', (task) => {
    task.scope.allowed_paths = Array.from({ length: 65 }, (_, index) => 'mcp/x/' + index);
  }),
  invalid('scope path traversal rejected', (task) => { task.scope.allowed_paths = ['mcp/../private']; }),
  invalid('scope absolute path rejected', (task) => { task.scope.allowed_paths = ['/tmp/file']; }),
  invalid('scope path length rejected', (task) => { task.scope.allowed_paths = ['a'.repeat(1025)]; }),
  invalid('allowed and forbidden paths overlap', (task) => {
    task.scope.allowed_paths = ['mcp/x'];
    task.scope.forbidden_paths = ['mcp/x/private'];
  }),
  invalid('reference_paths wrong type', (task) => { task.scope.reference_paths = 'docs'; }),
  invalid('reference_paths exceed count limit', (task) => {
    task.scope.reference_paths = Array.from({ length: 65 }, (_, index) => 'docs/' + index);
  }),
  invalid('reference path traversal rejected', (task) => { task.scope.reference_paths = ['docs/../private']; }),
  invalid('reference path length rejected', (task) => { task.scope.reference_paths = ['r'.repeat(1025)]; }),
  invalid('reference_paths overlap allowed_paths', (task) => { task.scope.reference_paths = ['mcp']; }),
  invalid('reference_paths overlap forbidden_paths', (task) => { task.scope.reference_paths = ['private/readme']; }),

  invalid('constraints wrong type', (task) => { task.constraints = null; }),
  invalid('constraints preserve wrong type', (task) => { task.constraints.preserve = 'keep'; }),
  invalid('constraints do_not invalid value', (task) => { task.constraints.do_not = ['']; }),

  invalid('validation wrong type', (task) => { task.validation = 'npm test'; }),
  invalid('validation missing with no usable legacy verification', (task) => {
    delete task.validation;
    delete task.verification;
  }),
  invalid('legacy verification malformed does not satisfy fallback', (task) => {
    delete task.validation;
    task.verification = { required: ['npm test'] };
  }),
  invalid('validation required wrong type', (task) => { task.validation.required = 'npm test'; }),
  invalid('validation required empty', (task) => { task.validation.required = []; }),
  invalid('validation optional wrong type', (task) => { task.validation.optional = null; }),

  invalid('uncertainty policy wrong type', (task) => { task.uncertainty_policy = null; }),
  invalid('uncertainty policy missing policy', (task) => { task.uncertainty_policy = { policy: '', stop_conditions: [] }; }),
  invalid('uncertainty stop_conditions wrong type', (task) => { task.uncertainty_policy.stop_conditions = null; }),

  invalid('repair_budget wrong type', (task) => { task.repair_budget = null; }),
  invalid('repair initial_attempts noncanonical', (task) => { task.repair_budget.initial_attempts = 2; }),
  invalid('repair max_repairs negative', (task) => { task.repair_budget.max_repairs = -1; }),
  invalid('repair max_repairs above canonical max', (task) => { task.repair_budget.max_repairs = 3; }),
  invalid('repair max_total_rounds below initial attempts', (task) => { task.repair_budget.max_total_rounds = 0; }),
  invalid('repair max_total_rounds above canonical max', (task) => { task.repair_budget.max_total_rounds = 4; }),
  invalid('repair total exceeds initial plus repairs', (task) => {
    task.repair_budget.max_repairs = 0;
    task.repair_budget.max_total_rounds = 2;
  }),

  invalid('timing wrong type', (task) => { task.timing = null; }),
  invalid('timing values must be positive integers', (task) => { task.timing.estimated_minutes = 0; }),
  invalid('timing ordering violation', (task) => {
    task.timing.first_check_after_minutes = 21;
    task.timing.soft_deadline_minutes = 20;
  }),

  invalid('commit_policy invalid string', (task) => { task.commit_policy = 'auto_commit'; }),
  invalid('commit_policy invalid object', (task) => { task.commit_policy = { mode: 'sometimes' }; }),
];
