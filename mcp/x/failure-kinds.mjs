/**
 * X v0.2 Slice 4 -- structured failure SUBTYPES for PRECONDITION_FAILED.
 *
 * `PRECONDITION_FAILED` used to cover very different facts: the live file drifted, the model's `old_string` did not match,
 * the model edited text X never showed it, the target had no usable context at all. The repair loop had to treat them alike
 * (repairable), so a failure that no retry can fix used the whole repair budget and was reported as a transient exhaustion.
 *
 * The subtype is set BY THE CODE THAT DETECTS THE CONDITION (edit-writer / local-executor), from what that code actually
 * verified about the trusted state -- never derived later from the human-readable `detail` string. `PRECONDITION_FAILED` stays
 * the `code` (compatibility); the subtype only refines it. A `PRECONDITION_FAILED` blocker WITHOUT a known subtype (an older
 * producer, a future one) keeps its previous classification (repairable) -- an unknown subtype never changes behavior.
 *
 *   classification 'repairable': another round, with fresh context and the failure evidence, can plausibly fix it
 *   classification 'escalate'  : the same trusted state will produce the same failure; retrying only burns the budget
 *
 * `failure_class` is what Result Gate reports: 'context_limitation' (X cannot show/let the model edit what the fix needs) and
 * 'structural' (an internal contract defect) are permanent; 'live_state' and 'model_edit' are transient / model-correctable.
 */
export const FAILURE_SUBTYPES = Object.freeze({
  // --- repairable ---
  stale_live_state: Object.freeze({ classification: 'repairable', failure_class: 'live_state', meaning: 'the live file no longer matches the content/hash the edit was based on (drift, or changed earlier in this same run)' }),
  edit_mismatch: Object.freeze({ classification: 'repairable', failure_class: 'model_edit', meaning: 'old_string does not occur where the model said it does; re-copying it from the shown text can fix it' }),
  edit_ambiguous: Object.freeze({ classification: 'repairable', failure_class: 'model_edit', meaning: 'old_string matches more than once (or replace_all was requested where it is not allowed); a longer unique old_string can fix it' }),
  edit_form_invalid: Object.freeze({ classification: 'repairable', failure_class: 'model_edit', meaning: 'the chosen action form is not permitted for this context (e.g. whole-file replace of a partial view); another form can fix it' }),
  create_target_exists: Object.freeze({ classification: 'repairable', failure_class: 'model_edit', meaning: 'create was requested for a path that already exists and is in the shown context; patch/replace can fix it' }),
  read_only_target: Object.freeze({ classification: 'repairable', failure_class: 'model_edit', meaning: 'the model chose a read-only reference file as its edit target; it can choose an authorized editable target in the next round (the write boundary refuses the reference write regardless, so nothing was or will be written there)' }),
  // --- permanent ---
  unseen_context: Object.freeze({ classification: 'escalate', failure_class: 'context_limitation', meaning: 'the edit needs text that exists in the file but was not shown to the model' }),
  no_usable_context: Object.freeze({ classification: 'escalate', failure_class: 'context_limitation', meaning: 'the target has no complete or excerpt snapshot in the loaded context (unloaded, truncated, unreadable) and did not change during this run' }),
  excerpt_provenance_invalid: Object.freeze({ classification: 'escalate', failure_class: 'structural', meaning: 'the excerpt provenance recorded by the loader is inconsistent' }),
  precondition_missing: Object.freeze({ classification: 'escalate', failure_class: 'structural', meaning: 'the write primitive was called without any precondition (internal contract defect)' }),
});

/** The subtype record of an executor blocker, or null. Only meaningful together with code PRECONDITION_FAILED. */
export const failureSubtypeOf = (blocker) => {
  if (!blocker || blocker.code !== 'PRECONDITION_FAILED' || typeof blocker.subtype !== 'string') return null;
  return Object.hasOwn(FAILURE_SUBTYPES, blocker.subtype) ? FAILURE_SUBTYPES[blocker.subtype] : null;
};
