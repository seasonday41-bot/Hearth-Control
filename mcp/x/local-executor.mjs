import crypto from 'node:crypto';
import { assertModelAdapterContract } from './model-adapter.mjs';
import { loadTaskContext, XContextScopeError, EXCERPT_MARKER_PATTERN } from './context-loader.mjs';
import { createFile, replaceFile, applyEdits } from './edit-writer.mjs';
import { throwIfAborted } from './cancellation.mjs';
import { loadSkillForTask, buildSkillSection } from './skill-integration.mjs';

/**
 * LocalExecutor: orchestration only.
 *
 * x-task-v1 -> Context Loader -> ModelAdapter -> structured edit intent -> Scoped Edit Writer -> evidence
 *
 * This module owns none of the safety boundaries it uses -- it composes
 * three already-frozen components and adds nothing new to the filesystem
 * or network surface:
 *   - `loadTaskContext` (Phase 5A) for bounded, secret-guarded repository
 *     context.
 *   - `modelAdapter.generate()` (Phase 2, injected by the caller) for the
 *     model call. LocalExecutor never talks to Ollama or any provider
 *     directly.
 *   - `createFile`/`replaceFile`/`applyEdits` (Phase 5B) for the only three
 *     filesystem mutations that can ever happen here. Scope, symlink,
 *     protected-path, precondition, and byte-limit enforcement all live in
 *     that module and are reused as-is -- this file does not re-implement
 *     or weaken any of it.
 *
 * A model-proposed path is only ever "authorized" in the sense that
 * Phase 5B independently proves it is; the model's JSON has no other
 * channel to influence where a write lands. Unknown top-level fields (a
 * model-supplied "workspace" or "scope") are rejected outright, and
 * `scope.allowed_paths`/`forbidden_paths` are shown to the model only as
 * fixed, informational constraints in the prompt -- never read back from
 * the model's response.
 *
 * Precondition provenance for `replace` and `patch`: the model never
 * supplies (and cannot override) any precondition field for either action
 * type -- `expected_hash`/`expected_content` are absent from both
 * schemas, and their presence in a response is an unknown-field rejection
 * (see `FIELDS_BY_ACTION_TYPE`). Instead, `getCompleteContextFile` requires
 * an EXACT path match against `context.files` with `status === 'ok'`
 * (never `'redacted'` or `'truncated'` -- those mean the model was not
 * shown the complete real content, so treating them as a trustworthy basis
 * would be guessing). From that trusted snapshot:
 *   - `replace` passes the snapshot's content itself as `expectedContent`
 *     to Phase 5B.
 *   - `patch` computes `sha256(contextFile.content)` itself (the model
 *     never sees or supplies this hash) and passes it as `expectedHash` to
 *     Phase 5B. This matters even though `patch` also uses exact
 *     `old_string` matching: without a hash binding, a live file that
 *     drifted after context was loaded but still happens to contain
 *     `old_string` somewhere would patch silently-wrong content -- exact
 *     substring matching alone does not prove the file is still the
 *     snapshot the model reasoned about.
 * The full provenance chain for both is: Phase 5A complete snapshot ->
 * LocalExecutor-computed precondition (content or hash, never the
 * model's) -> Phase 5B's initial live-file comparison against that
 * precondition -> (patch only) exact `old_string` edits -> Phase 5B's own
 * pre-publish revalidation immediately before the atomic write. Content
 * that changed on disk after context was loaded is caught at the "initial
 * live-file comparison" step regardless of what this module believed, and
 * a change landing in the narrower window between that comparison and
 * publish is caught by Phase 5B's pre-publish revalidation.
 *
 * X v0.2 (large-file excerpt patch): a file too large to load whole may be shown
 * as `status: 'excerpt'` (see context-loader.mjs). It is NOT a complete snapshot,
 * so `replace` stays refused. `patch` is allowed only when, on the trusted side,
 * (1) every `old_string` lies entirely inside ONE shown line range, (2) it occurs
 * exactly once in the WHOLE ORIGINAL file, (3) the live file's hash still equals
 * the full-file hash the loader recorded (drift anywhere in the file, shown or
 * not, aborts), and (4) Phase 5B's scope/symlink/protected-path checks and atomic
 * publish pass. `replace_all` is refused. The model never supplies any of these.
 *
 * There is no delete, rename/move, chmod, shell, git, network, or package-
 * install capability anywhere in this module (see the "no mutation
 * capability" test, which greps this file's own source for exactly that).
 *
 * Serial safety: this module holds no queue, lease, or concurrency state of
 * its own and does not import Phase 4's dispatcher/claim-store. `executeTask`
 * is a plain function over one already-claimed task; MAX_ACTIVE_TASKS=1 is
 * the caller's (the dispatcher's) responsibility to enforce by only ever
 * invoking this function once per held lease, not something reimplemented
 * here.
 *
 * Free-form model text never reaches the filesystem: the model's response
 * must be exactly one JSON object matching `EXECUTOR_ACTION_TYPES` below --
 * malformed JSON, an unknown action type, a missing required field, too
 * many actions, or too many distinct files are all rejected before any
 * write is attempted (`status: 'blocked'`, zero changes). This is
 * deliberately not x-result-v1 and not a repair loop: on the first action
 * failure, execution stops and whatever completed is reported as-is.
 */

export const EXECUTOR_ACTION_TYPES = Object.freeze(['create', 'replace', 'patch']);
export const EXECUTOR_STATUSES = Object.freeze(['completed', 'failed', 'blocked']);

export const LOCAL_EXECUTOR_RESPONSE_SCHEMA = Object.freeze({
  type: 'object',
  properties: Object.freeze({
    actions: Object.freeze({
      type: 'array',
      items: Object.freeze({
        anyOf: Object.freeze([
          Object.freeze({
            type: 'object',
            properties: Object.freeze({
              type: Object.freeze({ type: 'string', enum: Object.freeze(['create']) }),
              path: Object.freeze({ type: 'string', pattern: '^[^/].*' }),
              content: Object.freeze({ type: 'string' }),
            }),
            required: Object.freeze(['type', 'path', 'content']),
            additionalProperties: false,
          }),
          Object.freeze({
            type: 'object',
            properties: Object.freeze({
              type: Object.freeze({ type: 'string', enum: Object.freeze(['replace']) }),
              path: Object.freeze({ type: 'string', pattern: '^[^/].*' }),
              content: Object.freeze({ type: 'string' }),
            }),
            required: Object.freeze(['type', 'path', 'content']),
            additionalProperties: false,
          }),
          Object.freeze({
            type: 'object',
            properties: Object.freeze({
              type: Object.freeze({ type: 'string', enum: Object.freeze(['patch']) }),
              path: Object.freeze({ type: 'string', pattern: '^[^/].*' }),
              edits: Object.freeze({
                type: 'array',
                items: Object.freeze({
                  type: 'object',
                  properties: Object.freeze({
                    old_string: Object.freeze({ type: 'string' }),
                    new_string: Object.freeze({ type: 'string' }),
                    replace_all: Object.freeze({ type: 'boolean' }),
                  }),
                  required: Object.freeze(['old_string', 'new_string']),
                  additionalProperties: false,
                }),
              }),
            }),
            required: Object.freeze(['type', 'path', 'edits']),
            additionalProperties: false,
          }),
        ]),
      }),
    }),
    explanation: Object.freeze({ type: 'string' }),
    confidence: Object.freeze({ type: 'number' }),
  }),
  required: Object.freeze(['actions']),
  additionalProperties: false,
});

export const DEFAULT_EXECUTOR_LIMITS = Object.freeze({
  maxActions: 10,
  maxFilesChanged: 10,
  maxModelResponseBytes: 60_000,
  maxExplanationBytes: 2_000,
});

// Per the phase spec, maxActions/maxFilesChanged ARE the hard ceiling (10),
// not merely a default a caller could raise. maxModelResponseBytes/
// maxExplanationBytes are this module's own choices, given generous
// headroom above the default for legitimate longer responses.
const HARD_EXECUTOR_LIMITS = Object.freeze({
  maxActions: 10,
  maxFilesChanged: 10,
  maxModelResponseBytes: 200_000,
  maxExplanationBytes: 4_000,
});

const clampPositiveInt = (value, fallback, hardMax) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), hardMax);
};

const resolveExecutorLimits = (overrides) => {
  const merged = { ...DEFAULT_EXECUTOR_LIMITS, ...(overrides || {}) };
  const clamped = {};
  for (const key of Object.keys(DEFAULT_EXECUTOR_LIMITS)) {
    clamped[key] = clampPositiveInt(merged[key], DEFAULT_EXECUTOR_LIMITS[key], HARD_EXECUTOR_LIMITS[key]);
  }
  return Object.freeze(clamped);
};

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const sha256 = (content) => crypto.createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');

export function hasWriteAuthority(task) {
  return Boolean(
    task &&
    Array.isArray(task.allowed_tools) &&
    task.allowed_tools.includes('repo_edit')
  );
}

const SCHEMA_INSTRUCTIONS = [
  'Respond with ONLY one JSON object and nothing else -- no prose before or after it.',
  'You may wrap it in a single ```json fence and nothing else may appear outside that fence.',
  'The object must match exactly this shape:',
  '{',
  '  "actions": [',
  '    { "type": "create", "path": "relative/new-path.js", "content": "full file text" },',
  '    { "type": "replace", "path": "relative/path.js", "content": "full new file text" },',
  '    { "type": "patch", "path": "relative/path.js", "edits": [ { "old_string": "exact existing text", "new_string": "replacement text", "replace_all": false } ] }',
  '  ],',
  '  "explanation": "one short sentence",',
  '  "confidence": 0.0',
  '}',
  'Rules:',
  '- Only use "create", "replace", or "patch" as an action type. No other type exists.',
  '- Every action.path MUST be repository-relative. Never output an absolute filesystem path. Never begin a path with "/". Never use ".." as a path segment. Never copy or invent user home paths such as /Users/... . Paths must refer only to files inside the task\'s allowed_paths.',
  '- "replace" and "patch" paths must exactly match repository-relative paths shown under Provided Context below. Do not invent content for a file you have not seen.',
  '- "create" must target a NEW repository-relative path within allowed_paths that does NOT already appear under Provided Context, must be located under one of the Allowed paths listed below, and must not be under any Forbidden path.',
  '- "replace" is only { "type": "replace", "path": "...", "content": "full new file text" }. Do NOT include expected_hash or expected_content -- you do not have the real hash of the file, and including either field will cause the whole response to be rejected.',
  '- "patch" is only { "type": "patch", "path": "...", "edits": [...] }. Do NOT include expected_hash -- it is not part of this schema and will cause the whole response to be rejected. Edits must match the shown content exactly; do not guess at text not shown.',
  '- If no change is needed, return "actions": [].',
  '- Never include a "workspace" or "scope" field -- authorization is not something this response can set. Allowed paths / Forbidden paths below are fixed by the task, not by you.',
].join('\n');

const READ_ONLY_SCHEMA_INSTRUCTIONS = [
  'Respond with ONLY one JSON object and nothing else -- no prose before or after it.',
  'You may wrap it in a single ```json fence and nothing else may appear outside that fence.',
  'The object must match exactly this shape:',
  '{',
  '  "actions": [],',
  '  "explanation": "one short sentence",',
  '  "confidence": 0.0',
  '}',
  'Rules:',
  '- This task has NO repository edit authority.',
  '- You MUST return actions: [].',
  '- Do not propose create, replace, or patch.',
  '- Never include a "workspace" or "scope" field -- authorization is not something this response can set.',
].join('\n');

// Added to the system prompt ONLY when the loaded context contains an excerpt file, so every prompt for a context
// without one stays byte-identical to before.
const EXCERPT_RULES = [
  'Files shown with "status: excerpt" show only the listed line ranges; lines between them are marked "... (lines A-B not shown) ...".',
  '- For an excerpt file you may use ONLY "patch". Never use "replace" and never set "replace_all" on it.',
  '- Every old_string must be copied exactly from inside ONE shown range, WITHOUT the "N: " line-number prefix, must not span a "not shown" marker, and must occur exactly once in the whole file. If it may occur elsewhere, include more of the surrounding shown lines to make it unique.',
].join('\n');

const REFERENCE_RULES = 'Files shown with "status: reference" are READ-ONLY background from modules related to the files you may edit. Use them only to understand behavior. Never use "create", "replace" or "patch" on them.';

const truncate = (text, maxBytes) => {
  const buf = Buffer.from(String(text ?? ''), 'utf8');
  return buf.byteLength <= maxBytes ? String(text ?? '') : buf.subarray(0, maxBytes).toString('utf8');
};

function buildTaskSection(task) {
  const lines = [
    `Objective: ${task.objective}`,
    `Problem: ${task.problem}`,
    `Expected behavior: ${task.expected_behavior}`,
    `Observed behavior: ${task.observed_behavior}`,
  ];
  if (Array.isArray(task.acceptance_criteria) && task.acceptance_criteria.length) {
    lines.push('Acceptance criteria:', ...task.acceptance_criteria.map((c) => `- ${c}`));
  }
  if (Array.isArray(task.done_criteria) && task.done_criteria.length) {
    lines.push('Done criteria:', ...task.done_criteria.map((c) => `- ${c}`));
  }
  if (Array.isArray(task.teaching_notes) && task.teaching_notes.length) {
    lines.push('Teaching notes:', ...task.teaching_notes.map((n) => `- ${n}`));
  }
  return lines.join('\n');
}

/** Scope shown as a fixed, informational constraint -- never read back from the model's response. */
function buildScopeSection(scope) {
  return [
    'Scope constraints (fixed; this response cannot change these):',
    `Allowed paths: ${(scope.allowed_paths || []).join(', ') || '(none)'}`,
    `Forbidden paths: ${(scope.forbidden_paths || []).length ? scope.forbidden_paths.join(', ') : '(none)'}`,
    ...(Array.isArray(scope.reference_paths) && scope.reference_paths.length > 0 ? [`Read-only reference paths (never editable): ${scope.reference_paths.join(', ')}`] : []),
  ].join('\n');
}

function buildContextSection(context) {
  const lines = ['Provided Context (the only files you may reference or modify with replace/patch):'];
  for (const file of context.files) {
    lines.push(`--- ${file.path} (status: ${file.status}) ---`);
    lines.push(file.content ?? '(content withheld)');
  }
  if (context.files.length === 0) lines.push('(no files were loaded into context)');
  if (context.evidence?.known_evidence?.length) {
    lines.push('Known evidence:', ...context.evidence.known_evidence.map((e) => `- ${e}`));
  }
  return lines.join('\n');
}

export function buildCreatePathPattern(scope) {
  const allowed = Array.isArray(scope?.allowed_paths) ? scope.allowed_paths : null;
  if (!allowed) {
    return '^[^/].*';
  }
  const normalized = allowed
    .filter((p) => typeof p === 'string' && p.trim())
    .map((p) => p.trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean);

  if (normalized.length === 0) {
    return '^$';
  }

  const escaped = normalized.map(escapeRegex);
  return `^(?:${escaped.join('|')})(?:/.*)?$`;
}

export function getEligibleContextPaths(context) {
  if (!Array.isArray(context?.files)) return [];
  const paths = [];
  for (const file of context.files) {
    if (file && file.status === 'ok' && typeof file.path === 'string') {
      const trimmed = file.path.trim();
      if (trimmed && !paths.includes(trimmed)) {
        paths.push(trimmed);
      }
    }
  }
  return paths;
}

/** Paths a `patch` may name: complete (`ok`) files plus excerpt files. `replace` may name only `getEligibleContextPaths`. */
export function getPatchableContextPaths(context) {
  const paths = getEligibleContextPaths(context);
  if (!Array.isArray(context?.files)) return paths;
  for (const file of context.files) {
    if (file && file.status === 'excerpt' && typeof file.path === 'string') {
      const trimmed = file.path.trim();
      if (trimmed && !paths.includes(trimmed)) paths.push(trimmed);
    }
  }
  return paths;
}

const hasExcerptFile = (context) => Array.isArray(context?.files) && context.files.some((f) => f && f.status === 'excerpt');
const hasReferenceFile = (context) => Array.isArray(context?.files) && context.files.some((f) => f && f.status === 'reference');

export function buildLocalExecutorResponseSchema(task, context) {
  if (!hasWriteAuthority(task)) {
    return Object.freeze({
      type: 'object',
      properties: Object.freeze({
        actions: Object.freeze({
          type: 'array',
          maxItems: 0,
          // Defense-in-depth only, not the safety boundary itself: `items`
          // bounds the SHAPE of any element the model backend's structured-
          // output grammar lets through despite maxItems:0 (verified against
          // the current Ollama/qwen3.5 backend to accept this keyword
          // without error; `maxItems` was itself observed to be honored in
          // direct probes, but is not something this module can verify on
          // every future model/backend, so a slipped-through element is at
          // least constrained to an empty object rather than an arbitrary
          // shape). Plain object/additionalProperties is used rather than a
          // boolean subschema (e.g. `items:false`) because the latter's
          // enforcement by the backend's schema-to-grammar conversion is
          // unverified. This can never be the sole safety mechanism --
          // enforceReadOnlyActionBoundary() below is the actual, always-on,
          // deterministic Node-side authority boundary.
          items: Object.freeze({ type: 'object', additionalProperties: false }),
        }),
        explanation: Object.freeze({ type: 'string' }),
        confidence: Object.freeze({ type: 'number' }),
      }),
      required: Object.freeze(['actions']),
      additionalProperties: false,
    });
  }

  const createPattern = buildCreatePathPattern(task?.scope);
  const eligiblePaths = getEligibleContextPaths(context);
  const patchablePaths = getPatchableContextPaths(context);

  const createSchema = Object.freeze({
    type: 'object',
    properties: Object.freeze({
      type: Object.freeze({ type: 'string', enum: Object.freeze(['create']) }),
      path: Object.freeze({ type: 'string', pattern: createPattern }),
      content: Object.freeze({ type: 'string' }),
    }),
    required: Object.freeze(['type', 'path', 'content']),
    additionalProperties: false,
  });

  const variants = [createSchema];

  const frozenEligible = Object.freeze([...eligiblePaths]);
  const frozenPatchable = Object.freeze([...patchablePaths]);
  if (eligiblePaths.length > 0) {
    const replaceSchema = Object.freeze({
      type: 'object',
      properties: Object.freeze({
        type: Object.freeze({ type: 'string', enum: Object.freeze(['replace']) }),
        path: Object.freeze({ type: 'string', enum: frozenEligible }),
        content: Object.freeze({ type: 'string' }),
      }),
      required: Object.freeze(['type', 'path', 'content']),
      additionalProperties: false,
    });

    variants.push(replaceSchema);
  }
  if (patchablePaths.length > 0) {
    const patchSchema = Object.freeze({
      type: 'object',
      properties: Object.freeze({
        type: Object.freeze({ type: 'string', enum: Object.freeze(['patch']) }),
        path: Object.freeze({ type: 'string', enum: frozenPatchable }),
        edits: Object.freeze({
          type: 'array',
          items: Object.freeze({
            type: 'object',
            properties: Object.freeze({
              old_string: Object.freeze({ type: 'string' }),
              new_string: Object.freeze({ type: 'string' }),
              replace_all: Object.freeze({ type: 'boolean' }),
            }),
            required: Object.freeze(['old_string', 'new_string']),
            additionalProperties: false,
          }),
        }),
      }),
      required: Object.freeze(['type', 'path', 'edits']),
      additionalProperties: false,
    });

    variants.push(patchSchema);
  }

  return Object.freeze({
    type: 'object',
    properties: Object.freeze({
      actions: Object.freeze({
        type: 'array',
        items: Object.freeze({
          anyOf: Object.freeze(variants),
        }),
      }),
      explanation: Object.freeze({ type: 'string' }),
      confidence: Object.freeze({ type: 'number' }),
    }),
    required: Object.freeze(['actions']),
    additionalProperties: false,
  });
}

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isRepairTask(task, context = null) {
  if (task?.is_repair === true) return true;
  if (Array.isArray(task?.known_evidence) && task.known_evidence.some((e) => typeof e === 'string' && e.includes('Repair context from round'))) {
    return true;
  }
  if (Array.isArray(context?.evidence?.known_evidence) && context.evidence.known_evidence.some((e) => typeof e === 'string' && e.includes('Repair context from round'))) {
    return true;
  }
  return false;
}

export function buildRepairDirectiveSection() {
  return [
    'Repair directive:',
    '- A required validation failed in a previous attempt.',
    '- Inspect the provided validation evidence and error diagnostic.',
    '- Inspect the current file contents provided under Provided Context.',
    '- Propose the necessary repository edit actions (create, replace, or patch) required to make validation pass.',
    '- Return actions: [] ONLY if the current files already satisfy the failed validation evidence and no edit is actually required.',
  ].join('\n');
}

export function buildModelRequest(task, context, skill = null) {
  const instructions = hasWriteAuthority(task) ? SCHEMA_INSTRUCTIONS : READ_ONLY_SCHEMA_INSTRUCTIONS;
  const skillSection = skill ? buildSkillSection(skill) : '';
  const repairDirective = hasWriteAuthority(task) && isRepairTask(task, context)
    ? `${buildRepairDirectiveSection()}\n\n`
    : '';
  const messages = [
    { role: 'system', content: hasWriteAuthority(task) ? [instructions, hasExcerptFile(context) ? EXCERPT_RULES : null, hasReferenceFile(context) ? REFERENCE_RULES : null].filter(Boolean).join('\n') : instructions },
    { role: 'user', content: `${skillSection}${repairDirective}${buildTaskSection(task)}\n\n${buildScopeSection(task.scope)}\n\n${buildContextSection(context)}` },
  ];
  return {
    messages,
    format: buildLocalExecutorResponseSchema(task, context),
    num_predict: 4096,
    longResponse: true,
  };
}

/** Strips a single leading/trailing \`\`\` or \`\`\`json fence if the WHOLE trimmed response is wrapped in exactly one. No other normalization is performed -- this is a fixed, deterministic transform, not fuzzy interpretation. */
function extractJsonText(raw) {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json)?\r?\n([\s\S]*?)\r?\n```$/);
  return match ? match[1] : trimmed;
}

function parseModelResponse(rawText, limits) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    return { ok: false, reason: 'malformed_json', detail: 'model response was empty or not text' };
  }
  const bytes = Buffer.byteLength(rawText, 'utf8');
  if (bytes > limits.maxModelResponseBytes) {
    return { ok: false, reason: 'response_too_large', detail: `model response is ${bytes} bytes, over the ${limits.maxModelResponseBytes} byte limit` };
  }
  let parsed;
  try {
    parsed = JSON.parse(extractJsonText(rawText));
  } catch (err) {
    return { ok: false, reason: 'malformed_json', detail: err.message };
  }
  return { ok: true, parsed };
}

// Neither `replace` nor `patch` accepts any model-supplied precondition
// field -- see the module docstring for why. Both preconditions are
// computed by LocalExecutor itself from the Phase 5A context snapshot.
const FIELDS_BY_ACTION_TYPE = Object.freeze({
  create: new Set(['type', 'path', 'content']),
  replace: new Set(['type', 'path', 'content']),
  patch: new Set(['type', 'path', 'edits']),
});
const KNOWN_TOP_FIELDS = new Set(['actions', 'explanation', 'confidence']);
const KNOWN_EDIT_FIELDS = new Set(['old_string', 'new_string', 'replace_all']);

/**
 * The read-only authority boundary. A task without `repo_edit` must never
 * have a model-produced action reach mutation execution -- not because the
 * response schema's `maxItems: 0` says so (a model backend may or may not
 * actually enforce that constraint; see buildLocalExecutorResponseSchema's
 * `items` comment), but because this deterministic, always-on Node-side
 * check runs unconditionally for every read-only task, before
 * `validateIntent` ever inspects a single `action.type`.
 *
 * A read-only task whose `parsed.actions` is a non-empty array is
 * normalized to an empty one here -- the actions are discarded, never
 * executed, and never even reach `validateIntent`'s per-action shape
 * checks (so a malformed action, e.g. one missing `type`, can no longer
 * surface as an `unsupported_action` failure for a read-only task: the
 * task never needed an action in the first place). Every other field
 * (`explanation`, `confidence`, and any top-level field this function does
 * not itself recognize) is passed through untouched, so `validateIntent`'s
 * own unrelated checks (unknown top-level fields, non-array `actions`,
 * etc.) still apply exactly as before.
 *
 * A write-authorized task (`hasWriteAuthority(task) === true`) is entirely
 * unaffected -- this function returns the input unchanged, preserving the
 * existing action validation/execution semantics for that path exactly.
 *
 * @param {object} task
 * @param {object} parsed already-JSON-parsed model response (not yet shape-validated)
 * @returns {{ parsed: object, discardedActionCount: number }}
 */
function enforceReadOnlyActionBoundary(task, parsed) {
  if (hasWriteAuthority(task)) return { parsed, discardedActionCount: 0 };
  if (!isPlainObject(parsed) || !Array.isArray(parsed.actions) || parsed.actions.length === 0) {
    return { parsed, discardedActionCount: 0 };
  }
  return { parsed: { ...parsed, actions: [] }, discardedActionCount: parsed.actions.length };
}

/**
 * Deterministically validates one parsed model response against the fixed
 * action schema. Returns the FIRST violation found (fail-fast, no
 * aggregation), in a fixed order, so the same malformed input always
 * produces the same `reason`. No unknown field is ever tolerated -- this
 * is a strict schema, not a lenient/fuzzy one, matching x-task-v1's own
 * unknown-field-rejection convention. This function checks SHAPE only; it
 * has no knowledge of context or the filesystem -- provenance/precondition
 * binding happens in `executeOneAction` below, and actual authorization
 * happens in Phase 5B.
 */
function validateIntent(parsed, limits) {
  if (!isPlainObject(parsed)) return { ok: false, reason: 'schema_invalid', detail: 'response must be a JSON object' };
  for (const key of Object.keys(parsed)) {
    if (!KNOWN_TOP_FIELDS.has(key)) return { ok: false, reason: 'schema_invalid', detail: `unknown top-level field '${key}'` };
  }
  if (!Array.isArray(parsed.actions)) return { ok: false, reason: 'schema_invalid', detail: 'actions must be an array' };
  if (parsed.actions.length > limits.maxActions) {
    return { ok: false, reason: 'too_many_actions', detail: `${parsed.actions.length} actions exceeds the ${limits.maxActions} action limit` };
  }

  const distinctPaths = new Set();
  for (const [index, action] of parsed.actions.entries()) {
    if (!isPlainObject(action)) return { ok: false, reason: 'schema_invalid', detail: `action ${index} must be an object` };
    if (!EXECUTOR_ACTION_TYPES.includes(action.type)) {
      return { ok: false, reason: 'unsupported_action', detail: `action ${index}: unsupported type '${action.type}'` };
    }
    const allowedFields = FIELDS_BY_ACTION_TYPE[action.type];
    for (const key of Object.keys(action)) {
      if (!allowedFields.has(key)) return { ok: false, reason: 'schema_invalid', detail: `action ${index} (${action.type}): field '${key}' is not valid for this action type` };
    }
    if (typeof action.path !== 'string' || !action.path.trim()) {
      return { ok: false, reason: 'missing_field', detail: `action ${index}: path is required` };
    }
    distinctPaths.add(action.path.trim());

    if ((action.type === 'create' || action.type === 'replace') && typeof action.content !== 'string') {
      return { ok: false, reason: 'missing_field', detail: `action ${index}: content is required for ${action.type}` };
    }
    if (action.type === 'patch') {
      if (!Array.isArray(action.edits) || action.edits.length === 0) {
        return { ok: false, reason: 'missing_field', detail: `action ${index}: patch requires a non-empty edits array` };
      }
      for (const [editIndex, edit] of action.edits.entries()) {
        if (!isPlainObject(edit)) return { ok: false, reason: 'schema_invalid', detail: `action ${index} edit ${editIndex}: must be an object` };
        for (const key of Object.keys(edit)) {
          if (!KNOWN_EDIT_FIELDS.has(key)) return { ok: false, reason: 'schema_invalid', detail: `action ${index} edit ${editIndex}: unknown field '${key}'` };
        }
        if (typeof edit.old_string !== 'string' || !edit.old_string) {
          return { ok: false, reason: 'missing_field', detail: `action ${index} edit ${editIndex}: old_string is required` };
        }
        if (typeof edit.new_string !== 'string') {
          return { ok: false, reason: 'missing_field', detail: `action ${index} edit ${editIndex}: new_string is required` };
        }
        if (edit.replace_all !== undefined && typeof edit.replace_all !== 'boolean') {
          return { ok: false, reason: 'schema_invalid', detail: `action ${index} edit ${editIndex}: replace_all must be a boolean` };
        }
      }
    }
  }

  if (distinctPaths.size > limits.maxFilesChanged) {
    return { ok: false, reason: 'too_many_files', detail: `${distinctPaths.size} distinct files exceeds the ${limits.maxFilesChanged} file limit` };
  }
  if (parsed.explanation !== undefined && typeof parsed.explanation !== 'string') {
    return { ok: false, reason: 'schema_invalid', detail: 'explanation must be a string' };
  }
  if (parsed.confidence !== undefined && (typeof parsed.confidence !== 'number' || !Number.isFinite(parsed.confidence) || parsed.confidence < 0 || parsed.confidence > 1)) {
    return { ok: false, reason: 'schema_invalid', detail: 'confidence must be a number between 0 and 1' };
  }

  return {
    ok: true,
    value: {
      actions: parsed.actions,
      explanation: typeof parsed.explanation === 'string' ? truncate(parsed.explanation, limits.maxExplanationBytes) : null,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : null,
    },
  };
}

/**
 * The shared provenance gate for `replace` and `patch`: an exact path
 * match in `context.files` whose `status` is exactly `'ok'`. `'redacted'`
 * and `'truncated'` are deliberately excluded -- either means the model
 * was not shown the complete real content, so it cannot have been a
 * faithful basis for a precondition or an exact-match patch.
 */
function getCompleteContextFile(context, path) {
  return context.files.find((file) => file.path === path && file.status === 'ok') || null;
}

/**
 * `context.files[].content` is line-numbered text ("1: const x = 1;"),
 * produced by the same `ReadOnlyToolGateway.repoReadFile` Phase 5A reuses
 * for every read -- it is not the raw file content. Phase 5B's
 * precondition checks (`expectedContent`/`expectedHash`) compare against
 * the real, unprefixed file bytes, so the line-number prefix must be
 * removed before either is computed, or a legitimately-matching snapshot
 * would always mismatch.
 *
 * Only the EXACT expected prefix for each line's own position is stripped
 * (never a generic leading-digit guess), so an ordinary source line that
 * itself starts with number-like text (e.g. "10:30am ...") is never
 * misidentified as a line-number artifact -- it is only stripped if it is
 * preceded by exactly "10: " AND is the 10th line.
 *
 * This is byte-exact, including CRLF line endings: `fs.readFile(path,
 * 'utf8')` never normalizes line endings, and the numbering step
 * (`content.split('\n').map((line, i) => \`${i+1}: ${line}\`).join('\n')`)
 * carries a `\r` inertly at the end of whatever segment `split('\n')`
 * produced -- it never strips or relocates it. Reversing that exact same
 * split/prefix/join here reconstructs the original bytes precisely,
 * verified directly against gateway.mjs's implementation (empirically: a
 * file with `\r\n` line endings round-trips through numbering and this
 * stripping function to the identical original string).
 *
 * Only ever applied to a `status === 'ok'` file (see
 * `getCompleteContextFile`), where Phase 5A guarantees every line is
 * complete and correctly numbered -- a `'truncated'` file could have its
 * last line cut mid-content, which this function is not relied upon to
 * handle.
 */
function stripContextLineNumbers(content) {
  return content.split('\n').map((line, index) => {
    const prefix = `${index + 1}: `;
    return line.startsWith(prefix) ? line.slice(prefix.length) : line;
  }).join('\n');
}

/** An `excerpt` context file for exactly this path whose provenance record is present. */
export function getExcerptContextFile(context, path) {
  const file = context.files.find((f) => f.path === path && f.status === 'excerpt');
  if (!file || !Array.isArray(file.excerpts) || file.excerpts.length === 0 || typeof file.full_file?.sha256 !== 'string' || typeof file.content !== 'string') return null;
  return file;
}

/**
 * The plain text (line-number prefixes removed) of each shown range, rebuilt from `content` and checked against the
 * recorded ranges. Returns null if the record is inconsistent in any way (fail-closed): only text the model was
 * genuinely shown can ever justify a patch.
 */
export function excerptRangeTexts(file) {
  const ranges = [];
  let current = null;
  let next = 0;
  for (const line of file.content.split('\n')) {
    if (EXCERPT_MARKER_PATTERN.test(line)) { current = null; continue; }
    if (current === null) {
      const start = line.match(/^(\d+): /);
      if (!start) return null;
      current = { start: Number(start[1]), lines: [] };
      ranges.push(current);
      next = current.start;
    }
    const prefix = `${next}: `;
    if (!line.startsWith(prefix)) return null;
    current.lines.push(line.slice(prefix.length));
    next += 1;
  }
  if (ranges.length !== file.excerpts.length) return null;
  for (const [i, r] of ranges.entries()) {
    if (r.start !== file.excerpts[i].start_line || r.start + r.lines.length - 1 !== file.excerpts[i].end_line) return null;
  }
  return ranges.map((r) => r.lines.join('\n'));
}

const blockedActionResult = (operation, path, detail, subtype = null) => ({
  operation, path, status: 'error', code: 'PRECONDITION_FAILED', detail, ...(subtype ? { subtype } : {}),
  before_hash: null, after_hash: null, bytes_written: 0, created: false, changed: false,
});

/**
 * Patch justified by an EXCERPT (X v0.2). Trusted-side gates, in order: (1) no replace_all; (2) the recorded excerpt
 * provenance is consistent; (3) every old_string lies entirely inside one shown range; then Phase 5B enforces, before its
 * atomic write, (4) uniqueness in the whole original file, (5) the live file still hashes to the full-file hash the loader
 * recorded, (6) scope / symlink / protected-path. The model supplies none of these.
 */
async function patchFromExcerpt(task, action, excerptFile, writeLimits, signal) {
  for (const [index, edit] of action.edits.entries()) {
    if (edit.replace_all) return blockedActionResult('patch', action.path, `edit ${index}: replace_all is not permitted for a patch justified by an excerpt`, 'edit_form_invalid');
  }
  const rangeTexts = excerptRangeTexts(excerptFile);
  if (!rangeTexts) return blockedActionResult('patch', action.path, 'excerpt provenance for this file is malformed; refusing to patch', 'excerpt_provenance_invalid');
  // The "entirely within a shown range" gate runs inside applyEdits, against the hash-verified file, so its refusal can tell
  // unseen-but-real text (permanent) from a mis-copied old_string (repairable). Same message as before.
  const shown = { texts: rangeTexts, label: excerptFile.excerpts.map((r) => `${r.start_line}-${r.end_line}`).join(', ') };
  return applyEdits(task, action.path, action.edits, { expectedHash: excerptFile.full_file.sha256, uniqueInOriginal: true, shown, limits: writeLimits, signal });
}

/**
 * Executes exactly one validated action through the one applicable Phase 5B
 * primitive. No other filesystem operation is reachable from here.
 */
async function executeOneAction(task, action, context, writeLimits, signal, changedPaths = new Set()) {
  throwIfAborted(signal);
  if (!hasWriteAuthority(task)) {
    return {
      operation: action.type,
      path: action.path,
      status: 'error',
      code: 'PERMISSION_DENIED',
      detail: "task is not authorized for repository mutations; allowed_tools does not include 'repo_edit'",
      before_hash: null,
      after_hash: null,
      bytes_written: 0,
      created: false,
      changed: false,
    };
  }
  if (action.type === 'create') {
    const created = await createFile(task, action.path, action.content, { limits: writeLimits, signal });
    // The path already exists. If the model was shown it (complete or excerpt) it can switch to patch/replace; if it was NOT
    // shown and did not change during this run, no later round can show it either -> permanent context limitation.
    if (created.subtype === 'create_target_exists' && !changedPaths.has(action.path) && !getCompleteContextFile(context, action.path) && !getExcerptContextFile(context, action.path)) {
      return { ...created, subtype: 'no_usable_context' };
    }
    return created;
  }

  if (action.type === 'replace') {
    // The model never supplies a precondition. LocalExecutor binds it
    // itself from the Phase 5A context snapshot -- the last thing this
    // process actually, authorizedly read from disk.
    const contextFile = getCompleteContextFile(context, action.path);
    if (!contextFile) {
      if (context.files.some((f) => f.path === action.path && f.status === 'reference')) {
        return blockedActionResult('replace', action.path, 'replace target is read-only reference context (status: reference); it cannot be edited', 'read_only_target');
      }
      if (getExcerptContextFile(context, action.path)) {
        return blockedActionResult('replace', action.path, 'replace target is only partially shown (status: excerpt); whole-file replace from partial context is not permitted; use patch with old_string copied from a shown range', 'edit_form_invalid');
      }
      // A file THIS run just created/changed is not in the (pre-run) context, but the next round shows it: stale, not permanent.
      return blockedActionResult('replace', action.path, 'replace target has no complete (status: ok) snapshot in the loaded context; refusing to guess a precondition', changedPaths.has(action.path) ? 'stale_live_state' : 'no_usable_context');
    }
    return replaceFile(task, action.path, action.content, { expectedContent: stripContextLineNumbers(contextFile.content), limits: writeLimits, signal });
  }

  // patch: same complete-context provenance gate as replace. The model
  // never supplies or sees a hash; LocalExecutor computes one itself from
  // the trusted snapshot and binds it as Phase 5B's initial live-file
  // precondition. Exact old_string matching alone is not sufficient here:
  // without this hash, a live file that drifted after context was loaded
  // but still happens to contain old_string somewhere would be patched
  // even though it is no longer the content the model reasoned about.
  const contextFile = getCompleteContextFile(context, action.path);
  if (!contextFile) {
    const excerptFile = getExcerptContextFile(context, action.path);
    if (excerptFile) return patchFromExcerpt(task, action, excerptFile, writeLimits, signal);
    if (context.files.some((f) => f.path === action.path && f.status === 'reference')) {
      return blockedActionResult('patch', action.path, 'patch target is read-only reference context (status: reference); it cannot be edited', 'read_only_target');
    }
    return blockedActionResult('patch', action.path, 'patch target has no complete (status: ok) snapshot in the loaded context; refusing to guess at unseen content', changedPaths.has(action.path) ? 'stale_live_state' : 'no_usable_context');
  }
  return applyEdits(task, action.path, action.edits, { expectedHash: sha256(stripContextLineNumbers(contextFile.content)), limits: writeLimits, signal });
}

const modelMetadataFrom = (modelResult, explanation = null, confidence = null) => (modelResult ? {
  provider: modelResult.provider ?? null,
  model: modelResult.model ?? null,
  finish_reason: modelResult.finishReason ?? null,
  usage: modelResult.usage ?? null,
  explanation,
  confidence,
} : null);

const blockedResult = (taskId, reason, detail, modelMetadata = null, discardedActionCount = 0) => Object.freeze({
  task_id: taskId,
  status: 'blocked',
  actions_requested: 0,
  actions_completed: 0,
  files_changed: Object.freeze([]),
  changes: Object.freeze([]),
  model_metadata: Object.freeze(modelMetadata),
  blockers: Object.freeze([{ reason, detail: detail || null }]),
  remaining_work: Object.freeze([]),
  read_only_actions_discarded: discardedActionCount,
});

/**
 * Executes one validated x-task-v1 end to end: load context, ask the model
 * for a structured edit intent, validate it, apply it through Phase 5B one
 * action at a time (stopping at the first failure), and return one bounded
 * evidence object. Never mutates `task`.
 *
 * @param {object} task validated x-task-v1
 * @param {{ generate: Function, cancel?: Function }} modelAdapter a Phase 2 ModelAdapter (or a test stub with the same shape)
 * @param {{ limits?: object, contextOptions?: object, writeLimits?: object, modelOptions?: object, signal?: AbortSignal }} [options]
 */
export async function executeTask(task, modelAdapter, options = {}) {
  throwIfAborted(options.signal);
  assertModelAdapterContract(modelAdapter);
  const limits = resolveExecutorLimits(options.limits);
  const taskId = (task && typeof task === 'object' && typeof task.task_id === 'string') ? task.task_id : null;

  let context;
  try {
    context = await loadTaskContext(task, options.contextOptions);
  } catch (err) {
    throwIfAborted(options.signal);
    if (err instanceof XContextScopeError) throw err;
    return blockedResult(taskId, 'context_load_failed', err?.message || 'failed to load task context');
  }
  let skill = null;
  try {
    skill = await loadSkillForTask(task, options.skillOptions);
  } catch {
    // Skill loading is fail-safe; if registry root is absent or task has no match, continue without skill
  }
  throwIfAborted(options.signal);

  const request = buildModelRequest(task, context, skill);
  let modelResult;
  try {
    modelResult = await modelAdapter.generate(request, options.signal
      ? { ...options.modelOptions, signal: options.signal }
      : options.modelOptions);
  } catch (err) {
    throwIfAborted(options.signal);
    return blockedResult(taskId, 'model_request_failed', err?.message || 'model request failed');
  }
  throwIfAborted(options.signal);
  if (!modelResult?.ok) {
    return blockedResult(taskId, 'model_request_failed', modelResult?.error?.message || 'model request failed', modelMetadataFrom(modelResult));
  }

  const parsedOutcome = parseModelResponse(modelResult.text, limits);
  if (!parsedOutcome.ok) {
    return blockedResult(taskId, parsedOutcome.reason, parsedOutcome.detail, modelMetadataFrom(modelResult));
  }

  // Read-only authority boundary: runs BEFORE validateIntent ever inspects
  // action.type, so a read-only task's model-produced actions (malformed or
  // not) are discarded here regardless of what the response schema's own
  // maxItems:0 constraint did or did not enforce upstream. See
  // enforceReadOnlyActionBoundary's own doc comment.
  const { parsed: boundedParsed, discardedActionCount } = enforceReadOnlyActionBoundary(task, parsedOutcome.parsed);

  const intentOutcome = validateIntent(boundedParsed, limits);
  if (!intentOutcome.ok) {
    return blockedResult(taskId, intentOutcome.reason, intentOutcome.detail, modelMetadataFrom(modelResult), discardedActionCount);
  }
  const { actions, explanation, confidence } = intentOutcome.value;

  const changes = [];
  let failedChange = null;
  for (const action of actions) {
    throwIfAborted(options.signal);
    // eslint-disable-next-line no-await-in-loop -- actions must apply strictly in order, one at a time.
    const result = await executeOneAction(task, action, context, options.writeLimits, options.signal, new Set(changes.filter((c) => c.status === 'ok').map((c) => c.path)));
    throwIfAborted(options.signal);
    changes.push(result);
    if (result.status !== 'ok') { failedChange = result; break; }
  }

  const completedCount = changes.filter((c) => c.status === 'ok').length;
  const filesChanged = [...new Set(changes.filter((c) => c.status === 'ok').map((c) => c.path))];
  const remainingWork = failedChange
    ? actions.slice(changes.length).map((a) => ({ type: a.type, path: a.path }))
    : [];

  return Object.freeze({
    task_id: taskId,
    status: failedChange ? 'failed' : 'completed',
    actions_requested: actions.length,
    actions_completed: completedCount,
    files_changed: Object.freeze(filesChanged),
    changes: Object.freeze(changes.map((c) => Object.freeze(c))),
    model_metadata: Object.freeze(modelMetadataFrom(modelResult, explanation, confidence)),
    blockers: Object.freeze(failedChange
      ? [{ reason: 'write_failed', operation: failedChange.operation, path: failedChange.path, code: failedChange.code, detail: failedChange.detail, ...(failedChange.subtype ? { subtype: failedChange.subtype } : {}) }]
      : []),
    remaining_work: Object.freeze(remainingWork),
    // Non-zero only for a read-only task whose model response proposed one
    // or more actions -- those actions were discarded by
    // enforceReadOnlyActionBoundary and never reached execution. Zero for
    // every write-authorized task and for a read-only task that correctly
    // returned actions: [].
    read_only_actions_discarded: discardedActionCount,
  });
}
