// X-Eval v1 task definitions for the 5 QUALIFIED candidates (Step 4).
// DRAFT: the task TEXT is eval-authored and unreviewed; the runner smoke does not depend on its quality.
//
// Rules baked into every entry:
//  - the task text describes behavior, never the reference patch, commit, SHA, or hidden scorer;
//  - `oracle_files` (the reference source files) are used ONLY by the stub oracle, the wrong-file
//    check and the future context control run. They are never part of the x-task-v1;
//  - `hint_level: 'file'` = the supervisor names the suspected file (`suspected_area`) and scope is
//    that file. Coarser hints are a later experiment;
//  - `validator_provenance`: historical | historical_derived. `synthetic` is refused by the runner.

const base = (over) => ({
  version: 'x-task-v1', parent_task_id: null, revision: 1, attempt: 1, based_on_result_id: null,
  known_evidence: [], constraints: { preserve: [], do_not: [] }, allowed_tools: ['repo_read', 'repo_edit'],
  verification: null, teaching_notes: [], uncertainty_policy: { policy: 'bounded_autonomy', stop_conditions: [] },
  repair_budget: { initial_attempts: 1, max_repairs: 2, max_total_rounds: 3 },
  timing: { estimated_minutes: 10, first_check_after_minutes: 2, soft_deadline_minutes: 8, hard_timeout_minutes: 15 },
  commit_policy: { mode: 'never' }, ...over,
});
const scopeOf = (file) => ({ allowed_paths: [file], preferred_files: [], forbidden_paths: ['scripts'] });

export const TASKS = [
  {
    id: 'c1d6770715', gold: { class: 'MEASURABLE', interpretation: 'contract_explicit', counts_toward_model_quality: true }, tier: 'A', provenance: 'historical', hint_level: 'file',
    parent: '470da93ca7', fixed: 'c1d6770715', visible: { candidate: 'c1d6770715', variant: 'test' }, hidden: 'c1d6770715.mjs',
    oracle_files: ['mcp/x/result-gate.mjs'],
    xTask: base({
      objective: 'Make the X result gate report one stable reason code for structural execution failures.',
      problem: 'evaluateResultGate copies the underlying execution-blocker identifier into reason_code for a fixed set of deterministic, non-retryable failures, so the x-result-v1 reason_code taxonomy changes whenever a lower-level identifier is added or renamed.',
      expected_behavior: "For an escalated execution round whose blocker is one of PATH_REJECTED, INVALID_SCOPE, WRITE_FAILED, UNREADABLE_TARGET (blocker code) or context_load_failed, schema_invalid, unsupported_action, missing_field, too_many_actions, too_many_files (blocker reason with no code), the gate still returns gate_status FAILED, but reason_code is the single constant 'structural_execution_failure'. The original identifier stays available in evidence.blocker (code or reason). PROTECTED_PATH and SYMLINK_ESCAPE keep NEEDS_REVIEW / safety_boundary_review; an unrecognized code keeps NEEDS_REVIEW / unrecognized_repair_outcome.",
      observed_behavior: "reason_code equals the underlying identifier, for example 'PATH_REJECTED'.",
      why_this_matters: 'Consumers of x-result-v1 key on reason_code; it must stay stable when lower-level codes change.',
      suspected_area: ['mcp/x/result-gate.mjs'], scope: scopeOf('mcp/x/result-gate.mjs'),
      acceptance_criteria: ['The ten listed identifiers yield FAILED with reason_code structural_execution_failure.', 'The original identifier is preserved in evidence.blocker.', 'Safety-boundary and unrecognized-code outcomes are unchanged.', 'The required validation command passes.'],
      validation: { required: ['node --test scripts/test-x-result-gate.mjs'], optional: [] }, done_criteria: ['Required validation passes.'],
    }),
  },
  {
    id: '4f261b2f4b', gold: { class: 'STRUCTURAL_PROBE', interpretation: 'behavioral / structural_probe', counts_toward_model_quality: false }, tier: 'B', provenance: 'historical_derived', hint_level: 'file',
    parent: '24a813f1f8', fixed: '4f261b2f4b', visible: { candidate: '4f261b2f4b', variant: 'behavioral' }, hidden: '4f261b2f4b.mjs',
    oracle_files: ['electron/main.cjs'],
    xTask: base({
      objective: 'Fix the updater install preflight so it reports real runtime activity instead of always claiming the runtime is unavailable.',
      problem: "The main-process helper getUpdaterRuntimeBlocker is meant to block an update install while X, a Goal, or a durable job is active. It reports the generic 'runtime state unavailable' blocker even when everything is idle, so an install can never proceed and the specific X_ACTIVE, GOAL_ACTIVE and DURABLE_JOB_ACTIVE blockers are never reported.",
      expected_behavior: 'With X, Goals and durable jobs idle the helper returns no blocker; with an X wakeup deadline pending it returns X_ACTIVE; an active Goal gives GOAL_ACTIVE; a queued or running durable job gives DURABLE_JOB_ACTIVE; a genuinely uninitialized runtime still fails closed.',
      observed_behavior: 'The helper returns the runtime-state-unavailable blocker in every state.',
      why_this_matters: 'The updater must be able to install when idle and must name the real reason when it blocks.',
      suspected_area: ['electron/main.cjs'], scope: scopeOf('electron/main.cjs'),
      acceptance_criteria: ['Idle runtime yields no blocker.', 'Active X, Goal or durable job yields the matching specific blocker.', 'An uninitialized runtime still fails closed.', 'The required validation command passes.'],
      validation: { required: ['node --test scripts/test-updater-runtime-preflight.mjs'], optional: [] }, done_criteria: ['Required validation passes.'],
    }),
  },
  {
    id: '8d08bc3621', gold: { class: 'MEASURABLE', interpretation: 'behavioral', counts_toward_model_quality: true }, tier: 'A', provenance: 'historical', hint_level: 'file',
    parent: 'b3186b8506', fixed: '8d08bc3621', visible: { candidate: '8d08bc3621', variant: 'test' }, hidden: '8d08bc3621.mjs',
    oracle_files: ['electron/remote-update-stager.cjs'],
    xTask: base({
      objective: 'Make staging of a verified update work when the app bundle contains .asar archives and the code runs under Electron.',
      problem: "remote-update-stager.cjs stages a verified update by mounting the DMG and copying the .app bundle into the updates directory. Under Electron, staging a real bundle whose Contents/Resources contains app.asar fails with an 'Invalid package ... app.asar' error, so no update can be prepared.",
      expected_behavior: 'Staging copies the bundle as plain files: every .asar is a regular file with identical bytes, symlinks are preserved, and the staged tree hash equals the source tree hash. Existing safety behavior is unchanged: a top-level symlink candidate and a traversal-style buildId are still rejected, and the staged directory is removed when tree validation fails.',
      observed_behavior: "stageVerifiedUpdate rejects with 'Invalid package .../app.asar'.",
      why_this_matters: 'Without it the one-click updater cannot prepare any real release.',
      known_evidence: ['Error seen when preparing a real update: Invalid package <path>/Contents/Resources/app.asar'],
      suspected_area: ['electron/remote-update-stager.cjs'], scope: scopeOf('electron/remote-update-stager.cjs'),
      acceptance_criteria: ['A bundle containing app.asar stages successfully under Electron.', 'The staged tree hash equals the source tree hash.', 'Existing rejection and cleanup behavior is unchanged.', 'The required validation command passes.'],
      validation: { required: ['node --test scripts/test-remote-stager-electron-asar.mjs'], optional: [] }, done_criteria: ['Required validation passes.'],
    }),
  },
  {
    id: '070e9850b1', gold: { class: 'MEASURABLE', interpretation: 'contract_explicit', counts_toward_model_quality: true }, tier: 'A', provenance: 'historical', hint_level: 'file',
    parent: 'c41a557a0d', fixed: '070e9850b1', visible: { candidate: '070e9850b1', variant: 'test' }, hidden: '070e9850b1.mjs',
    oracle_files: ['electron/updater.cjs'],
    xTask: base({
      objective: 'Stop the local updater from offering or installing a build that is not actually newer than the running one.',
      problem: 'electron/updater.cjs treats a manifest as an update when its version is higher, or when versions are equal and its buildId differs. buildId is an identity string, not a clock, so an older build of the same version is offered (and can be installed) as an update. A development-mode run also compares static metadata against packaged builds.',
      expected_behavior: "A manifest is newer only if its semantic version is higher; a lower version is never newer; when versions are equal it is newer only if its builtAt is later than the running build's, and a missing or unparseable timestamp fails closed (not newer). Development mode (isPackaged === false) never reports update_ready and installUpdate refuses to install. installUpdate independently re-checks newness and refuses a manifest that is not newer. API: export isManifestNewer({ manifest: { version, builtAt }, currentVersion, currentBuiltAt }) returning a boolean; inspectUpdate accepts currentBuiltAt and isPackaged; installUpdate accepts currentVersion, currentBuiltAt and isPackaged.",
      observed_behavior: 'An older build of the same version with a different buildId is reported as update_ready and installUpdate installs it.',
      why_this_matters: 'A stale build must never replace the running one.',
      constraints: { preserve: ['Existing install, backup and rollback mechanics'], do_not: ['Modify electron/main.cjs in this task'] },
      suspected_area: ['electron/updater.cjs'], scope: scopeOf('electron/updater.cjs'),
      acceptance_criteria: ['Same-version older or unknown-age builds are not offered or installed.', 'Lower versions and development mode never produce an update.', 'installUpdate refuses a manifest that is not newer.', 'A genuinely newer build still installs.', 'The required validation command passes.'],
      validation: { required: ['node --test scripts/test-updater.mjs'], optional: [] }, done_criteria: ['Required validation passes.'],
    }),
  },
  {
    id: '79664a00cc', gold: { class: 'STRUCTURAL_PROBE', interpretation: 'behavioral / structural_probe', counts_toward_model_quality: false }, tier: 'B', provenance: 'historical_derived', hint_level: 'file',
    parent: 'aa50d93162', fixed: '79664a00cc', visible: { candidate: '79664a00cc', variant: 'behavioral' }, hidden: '79664a00cc.mjs',
    oracle_files: ['electron/main.cjs'],
    xTask: base({
      objective: 'Reopen the main window when Hearth is launched again after its window was closed.',
      problem: "On macOS the app keeps running after its window is closed. Launching Hearth again triggers the 'second-instance' handler, which still holds a reference to the destroyed window and throws 'TypeError: Object has been destroyed', so no window appears.",
      expected_behavior: 'Once the main window is closed the stored reference no longer points at it, and a close event from an older, already replaced window must not clear a newer live one. A second launch with no live window creates a fresh window; with a live minimized window it restores then focuses it; with a live window it only focuses it. No method is ever called on a destroyed window.',
      observed_behavior: "A second launch after closing the window throws 'Object has been destroyed' and nothing is shown.",
      why_this_matters: 'Users cannot reopen the app after closing its window without quitting it first.',
      suspected_area: ['electron/main.cjs'], scope: scopeOf('electron/main.cjs'),
      acceptance_criteria: ['A second launch after the window closed opens a fresh window.', 'A live window is focused (restored first when minimized), never recreated.', 'No call is made on a destroyed window.', 'The required validation command passes.'],
      validation: { required: ['node --test scripts/test-electron-window-lifecycle.mjs'], optional: [] }, done_criteria: ['Required validation passes.'],
    }),
  },
];

export const HOLD = Object.freeze(['c7cbaa326f', '9aa1446303']); // not runnable in Gold v1
export const MEASURABLE_IDS = Object.freeze(TASKS.filter((t) => t.gold.class === 'MEASURABLE').map((t) => t.id));
export const ACCEPTED_PROVENANCE = Object.freeze(['historical', 'historical_derived']);
