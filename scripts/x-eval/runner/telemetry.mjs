// TELEMETRY ONLY (never an input to outcome, scoring, or stop rules; not part of the Gold v1.1 fingerprint).
// EXPLANATION_ACTION_CONFLICT: the model's free-text `explanation` says no edit is needed, yet the same response emits
// one or more actions. `actions.length > 0` is deterministic; the "says no edit" part is a phrase match (heuristic).
const NO_EDIT = [
  /\bno (actual |further |code |file )?(edit|change|modification)s?( is| are| will be)?( actually)? (needed|required|necessary)\b/i,
  /\b(does not|doesn't|do not|don't) (need|require)( any| an| a)? (edit|change|modification|fix)/i,
  /\bno (file )?modification (can|will)\b/i,
  /\bnothing (to change|to fix|needs to change)\b/i,
  /\bno edits? (is |are )?(actually )?(needed|required)\b/i,
];

export const detectExplanationActionConflicts = (modelCalls = []) => {
  const conflicts = []; let examined = 0;
  for (const [index, call] of modelCalls.entries()) {
    let parsed = null;
    try { parsed = JSON.parse(call?.result?.text ?? ''); } catch { continue; }
    if (!parsed || typeof parsed !== 'object') continue;
    examined += 1;
    const explanation = typeof parsed.explanation === 'string' ? parsed.explanation : '';
    const actions = Array.isArray(parsed.actions) ? parsed.actions : [];
    const hit = NO_EDIT.map((re) => re.exec(explanation)).find(Boolean);
    if (hit && actions.length > 0) {
      conflicts.push({ tag: 'EXPLANATION_ACTION_CONFLICT', call: index + 1, matched_phrase: hit[0], actions: actions.length, action_types: [...new Set(actions.map((a) => a?.type))],
        edit_chars: actions.reduce((n, a) => n + (a.edits ?? []).reduce((m, e) => m + String(e.old_string ?? '').length + String(e.new_string ?? '').length, 0) + String(a.content ?? '').length, 0), explanation_excerpt: explanation.slice(0, 180) });
    }
  }
  return { tag: 'EXPLANATION_ACTION_CONFLICT', used_for_outcome: false, calls_examined: examined, conflicts };
};
