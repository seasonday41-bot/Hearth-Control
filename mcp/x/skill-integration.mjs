import { createHearthSkillRegistry } from '../skills/registry.mjs';

const COVERED_SKILLS = Object.freeze(['repo-inspect', 'bug-fix', 'test-regression']);

/**
 * Maps task-level tool permissions to available tools for skill loading.
 * Skill requested tools are intersected against this set.
 */
export function resolveAvailableTools(allowedTools = []) {
  const tools = Array.isArray(allowedTools) ? allowedTools : [];
  const available = new Set(tools);

  // repo_read authorizes repository inspection tools provided by gateway
  if (available.has('repo_read')) {
    available.add('repo_list');
    available.add('repo_read_file');
    available.add('git_inspect');
  }

  return [...available];
}

/**
 * Deterministically selects the appropriate Hearth Skill id for covered X tasks.
 */
export function selectSkillId(task) {
  if (task && typeof task.skill === 'string' && COVERED_SKILLS.includes(task.skill)) {
    return task.skill;
  }

  const text = [
    task?.objective,
    task?.problem,
    task?.expected_behavior,
    ...(Array.isArray(task?.acceptance_criteria) ? task.acceptance_criteria : []),
  ].filter(Boolean).join(' ');

  const allowedTools = Array.isArray(task?.allowed_tools) ? task.allowed_tools : [];

  // Test regression: explicit regression intent or test_run tool allowed without edit
  if (
    /(?:reproduce|verify|run).*(?:regression|test)|regression.*(?:test|verification)/i.test(text) ||
    (allowedTools.includes('test_run') && !allowedTools.includes('repo_edit'))
  ) {
    return 'test-regression';
  }

  // Bug fix: defect/bug/fix intent
  if (/(?:bug|defect|fix|repair|patch)/i.test(text)) {
    return 'bug-fix';
  }

  // Repo inspect: inspection/audit/explore intent
  if (/(?:inspect|audit|explore|structure|status)/i.test(text)) {
    return 'repo-inspect';
  }

  // Fallback based on write authority
  if (allowedTools.includes('repo_edit')) {
    return 'bug-fix';
  }

  return 'repo-inspect';
}

/**
 * Loads the selected skill definition through the existing Hearth Skill Registry,
 * intersecting requested tools with task allowed tools.
 */
export async function loadSkillForTask(task, options = {}) {
  const registry = options.registry || createHearthSkillRegistry(options.registryOptions);
  const skillId = selectSkillId(task);
  const availableTools = resolveAvailableTools(task?.allowed_tools);

  return registry.load(skillId, {
    agent: 'x',
    availableTools,
  });
}

/**
 * Formats the skill section for injection into the model request.
 */
export function buildSkillSection(skill) {
  if (!skill || !skill.metadata) return '';

  const lines = [
    `Active Skill: ${skill.metadata.id} (${skill.metadata.name})`,
    `Summary: ${skill.metadata.summary}`,
    `Skill Mode: ${skill.metadata.mode} (Note: Skill cannot grant authority; task.allowed_tools remains strictly authoritative)`,
    `Permitted Tools: ${skill.permittedTools.join(', ') || '(none)'}`,
    `Missing Tools: ${skill.missingTools.join(', ') || '(none)'}`,
    '',
    'Skill Playbook:',
    skill.instructions,
    '',
    '---',
    '',
  ];

  return lines.join('\n');
}
