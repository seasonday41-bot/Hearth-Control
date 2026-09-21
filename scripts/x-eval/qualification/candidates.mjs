// Candidate configs for X-Eval v1 Step 4 (eval-only). Hashes are the miner's
// (`scripts/x-eval/candidates.json`); parent = first parent of the fix commit.
//
// visible: the validator X would be given as `validation.required`.
//   overlay  : test files copied from the FIXED commit onto the PARENT tree, because
//              the fix's new/changed assertions are what must fail before the fix.
//   derive   : eval-authored edit of that test file (recorded, never silent).
//   parentOwnCommand : the PARENT's own version of the test, as an environment check.
// hidden: eval-authored scorer in scorers/, never part of an x-task-v1.

const strip = (source, ids) => {
  let out = source;
  for (const id of ids) out = out.replace(new RegExp(`^test\\('${id} [\\s\\S]*?^\\}\\);\\n\\n?`, 'm'), '');
  return out;
};


// Eval-derived replacement for the source-text test 6 of test-updater-runtime-preflight.mjs.
const PREFLIGHT_BEHAVIORAL_TEST = `test('6. Electron preflight reads the initialized X wakeup deadline function', async () => {
  const main = await fs.promises.readFile(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const start = main.indexOf('const getUpdaterRuntimeBlocker =');
  const end = main.indexOf('const startRollbackWatchdog =', start);
  assert.ok(start >= 0 && end > start, 'updater runtime preflight helper must exist');
  const make = new Function('xGetNextWakeupDeadline', 'goalRunner', 'jobManager', 'updaterInstallInProgress', 'localUpdater',
    main.slice(start, end) + '\\nreturn getUpdaterRuntimeBlocker;');
  const goal = { is_goal_active: () => false };
  const jobs = { listJobs: () => [] };
  assert.equal(make(() => null, goal, jobs, false, updater)(), null);
  assert.equal(make(() => 123, goal, jobs, false, updater)().code, updater.UPDATE_RUNTIME_BLOCKERS.X_ACTIVE);
});
`;

export const CANDIDATES = [
  {
    id: 'c1d6770715', label: 'normalize structural result-gate reason', parent: '470da93ca7', fixed: 'c1d6770715',
    visible: [{ name: 'test', command: 'node --test scripts/test-x-result-gate.mjs',
      overlay: [{ file: 'scripts/test-x-result-gate.mjs' }], parentOwnCommand: 'node --test scripts/test-x-result-gate.mjs' }],
    hidden: 'c1d6770715.mjs',
  },
  {
    id: '4f261b2f4b', label: 'updater preflight uses initialized X deadline fn', parent: '24a813f1f8', fixed: '4f261b2f4b',
    visible: [
      { name: 'test', command: 'node --test scripts/test-updater-runtime-preflight.mjs',
        note: 'test-build-metadata.mjs deliberately excluded (asserts a generated build ID); test 6 is a source-text assertion',
        overlay: [{ file: 'scripts/test-updater-runtime-preflight.mjs' }], parentOwnCommand: 'node --test scripts/test-updater-runtime-preflight.mjs' },
      { name: 'behavioral', command: 'node --test scripts/test-updater-runtime-preflight.mjs',
        note: 'eval-derived: test 6 (source-text) replaced by a test that EXECUTES the helper',
        overlay: [{ file: 'scripts/test-updater-runtime-preflight.mjs', derive: (s) => s.replace(/^test\('6\. Electron preflight[\s\S]*?^\}\);\n/m, PREFLIGHT_BEHAVIORAL_TEST) }], parentOwnCommand: null },
    ],
    hidden: '4f261b2f4b.mjs',
  },
  {
    id: '8d08bc3621', label: 'stager copies app.asar via physical fs', parent: 'b3186b8506', fixed: '8d08bc3621',
    visible: [{ name: 'test', command: 'node --test scripts/test-remote-stager-electron-asar.mjs',
      overlay: [{ file: 'scripts/test-remote-stager-electron-asar.mjs' }], parentOwnCommand: null }],
    hidden: '8d08bc3621.mjs',
  },
  {
    id: '070e9850b1', label: 'prevent stale updater downgrades', parent: 'c41a557a0d', fixed: '070e9850b1',
    visible: [{ name: 'test', command: 'node --test scripts/test-updater.mjs',
      note: 'plain-script test (not node:test); run under the frozen runner\'s --test-isolation=none',
      overlay: [{ file: 'scripts/test-updater.mjs' }], parentOwnCommand: 'node --test scripts/test-updater.mjs' }],
    hidden: '070e9850b1.mjs',
  },
  {
    id: '79664a00cc', label: 'reopen Hearth after window close', parent: 'aa50d93162', fixed: '79664a00cc',
    visible: [
      { name: 'full', command: 'node --test scripts/test-electron-window-lifecycle.mjs',
        overlay: [{ file: 'scripts/test-electron-window-lifecycle.mjs' }], parentOwnCommand: null },
      { name: 'behavioral', command: 'node --test scripts/test-electron-window-lifecycle.mjs',
        note: 'eval-derived: WL-S1..S3 (literal-source regexes) removed',
        overlay: [{ file: 'scripts/test-electron-window-lifecycle.mjs', derive: (s) => strip(s, ['WL-S1', 'WL-S2', 'WL-S3']) }], parentOwnCommand: null },
    ],
    hidden: '79664a00cc.mjs',
  },
  {
    id: 'c7cbaa326f', label: 'repair evidence + guidance (bundled)', parent: 'e322e75d1b', fixed: 'c7cbaa326f',
    visible: [{ name: 'test', command: 'node --test scripts/test-x-repair-loop.mjs scripts/test-x-local-executor.mjs',
      overlay: [{ file: 'scripts/test-x-repair-loop.mjs' }, { file: 'scripts/test-x-local-executor.mjs' }],
      parentOwnCommand: 'node --test scripts/test-x-repair-loop.mjs scripts/test-x-local-executor.mjs' }],
    hidden: 'c7cbaa326f.mjs',
  },
  {
    id: '9aa1446303', label: 'preserve specialist recovery lineage (no test in commit)', parent: 'b374a39903', fixed: '9aa1446303',
    visible: [{ name: 'existing-related', command: 'node --test scripts/test-goal-autopilot.mjs scripts/test-goal-context.mjs scripts/test-goal-retry.mjs scripts/test-goal-review-decision.mjs scripts/test-goal-review-queue.mjs scripts/test-goal-runner-x.mjs',
      note: 'no test changed in the commit; these are the miner\'s existing_related tests',
      overlay: [], parentOwnCommand: 'node --test scripts/test-goal-autopilot.mjs scripts/test-goal-context.mjs scripts/test-goal-retry.mjs scripts/test-goal-review-decision.mjs scripts/test-goal-review-queue.mjs scripts/test-goal-runner-x.mjs' }],
    hidden: '9aa1446303.mjs',
  },
];

// Sensitivity probe (extra): hand-made variants of the FIXED tree.
//  kind 'wrong'   : plausible but incorrect fix  -> validators SHOULD fail.
//  kind 'altOk'   : behaviorally correct, written differently -> a good validator SHOULD pass.
// expect keys: 'hidden' and 'visible:<variant>'.
export const MUTANTS = [
  { cand: 'c1d6770715', id: 'wrong-constant-name', kind: 'wrong', file: 'mcp/x/result-gate.mjs',
    from: "return buildGateResult('FAILED', 'structural_execution_failure', evidence);", to: "return buildGateResult('FAILED', 'structural_failure', evidence);",
    expect: { hidden: 'fail', 'visible:test': 'fail' } },
  { cand: 'c1d6770715', id: 'over-broad-safety-codes', kind: 'wrong', file: 'mcp/x/result-gate.mjs',
    from: "return buildGateResult('NEEDS_REVIEW', 'safety_boundary_review', evidence, 'supervisor_review');", to: "return buildGateResult('FAILED', 'structural_execution_failure', evidence);",
    expect: { hidden: 'fail', 'visible:test': 'fail' } },
  { cand: '4f261b2f4b', id: 'half-fix-call-site-left-wrong', kind: 'wrong', file: 'electron/main.cjs',
    from: 'xActive: xGetNextWakeupDeadline() != null,', to: 'xActive: xGetNextXWakeupDeadline() != null,',
    expect: { hidden: 'fail', 'visible:test': 'fail', 'visible:behavioral': 'fail' } },
  { cand: '4f261b2f4b', id: 'equivalent-guard-different-text', kind: 'altOk', file: 'electron/main.cjs',
    from: "if (typeof xGetNextWakeupDeadline !== 'function' || !goalRunner || !jobManager) {", to: 'if (!xGetNextWakeupDeadline || !goalRunner || !jobManager) {',
    expect: { hidden: 'pass', 'visible:test': 'pass', 'visible:behavioral': 'pass' } },
  { cand: '070e9850b1', id: 'install-guard-missing', kind: 'wrong', file: 'electron/updater.cjs',
    from: "  if (!isManifestNewer({ manifest, currentVersion, currentBuiltAt })) {\n    throw new Error('The selected build is not newer than the currently running version.');\n  }\n", to: '',
    expect: { hidden: 'fail', 'visible:test': 'fail' } },
  { cand: '070e9850b1', id: 'inspect-dev-mode-guard-missing', kind: 'wrong', file: 'electron/updater.cjs',
    from: "  if (isPackaged === false) {\n    return { state: UPDATE_STATES.UP_TO_DATE, currentVersion, currentBuildId, available: null, error: null, devMode: true };\n  }\n", to: '',
    expect: { hidden: 'fail', 'visible:test': 'fail' } },
  { cand: '79664a00cc', id: 'closed-handler-only', kind: 'wrong', file: 'electron/main.cjs',
    from: "  if (!mainWindow || mainWindow.isDestroyed()) {\n    createWindow();\n    return;\n  }\n  if (mainWindow.isMinimized()) mainWindow.restore();\n  mainWindow.focus();\n",
    to: "  if (mainWindow) {\n    if (mainWindow.isMinimized()) mainWindow.restore();\n    mainWindow.focus();\n  }\n",
    expect: { hidden: 'fail', 'visible:full': 'fail', 'visible:behavioral': 'fail' } },
  { cand: '79664a00cc', id: 'equivalent-guard-different-text', kind: 'altOk', file: 'electron/main.cjs',
    from: 'mainWindow.isDestroyed()) {\n    createWindow();', to: 'mainWindow.isDestroyed() === true) {\n    createWindow();',
    expect: { hidden: 'pass', 'visible:full': 'pass', 'visible:behavioral': 'pass' } },
  { cand: '8d08bc3621', id: 'copy-still-uses-patched-fs', kind: 'wrong', file: 'electron/remote-update-stager.cjs',
    from: 'await physicalFs.promises.cp(candidatePath, stagedAppPath, {', to: 'await fs.promises.cp(candidatePath, stagedAppPath, {',
    expect: { hidden: 'fail', 'visible:test': 'fail' } },
  { cand: 'c7cbaa326f', id: 'head-truncation-restored', kind: 'wrong', file: 'mcp/x/repair-loop.mjs',
    from: 'const tail = truncateTailText(output, MAX_EVIDENCE_TAIL_BYTES);', to: 'const tail = truncateText(output, MAX_EVIDENCE_TAIL_BYTES);',
    expect: { hidden: 'fail', 'visible:test': 'fail' } },
];

// ---- Gold v1.1 SCORER AUDIT mutants ----------------------------------------------------------------------------------
// Hand-made variants of the FIXED tree of the 3 MEASURABLE tasks, aimed at behavior the fix must NOT change (the hole the
// Qwen baseline found in c1d6770715). `wrong`: plausible incorrect patch, the HIDDEN scorer must fail it.
// `altOk`: behaviorally equivalent, the HIDDEN scorer must pass it. `observe` layers are recorded, not asserted.
export const AUDIT_MUTANTS = [
  // c1d6770715 (result gate)
  { cand: 'c1d6770715', id: 'top-level-blockers-collapsed (the Qwen patch)', kind: 'wrong', file: 'mcp/x/result-gate.mjs',
    from: "return buildGateResult('FAILED', topBlocker.reason, evidence);", to: "return buildGateResult('FAILED', 'structural_execution_failure', evidence);", expect: { hidden: 'fail' }, observe: ['visible:test', 'net'] },
  { cand: 'c1d6770715', id: 'unrecognized-execution-code-collapsed', kind: 'wrong', file: 'mcp/x/result-gate.mjs',
    from: "    if (KNOWN_FAILED_EXECUTION_CODES.has(key)) {\n      return buildGateResult('FAILED', 'structural_execution_failure', evidence);\n    }\n    return buildGateResult('NEEDS_REVIEW', 'unrecognized_repair_outcome', evidence, 'supervisor_review');",
    to: "    if (KNOWN_FAILED_EXECUTION_CODES.has(key)) {\n      return buildGateResult('FAILED', 'structural_execution_failure', evidence);\n    }\n    return buildGateResult('FAILED', 'structural_execution_failure', evidence);", expect: { hidden: 'fail' }, observe: ['visible:test', 'net'] },
  { cand: 'c1d6770715', id: 'raw-identifier-not-kept-in-evidence', kind: 'wrong', file: 'mcp/x/result-gate.mjs',
    from: 'blocker: blocker ? Object.freeze({ code: blocker.code ?? null, reason: blocker.reason ?? null, detail: blocker.detail ?? null }) : null,', to: 'blocker: null,', expect: { hidden: 'fail' }, observe: ['visible:test', 'net'] },
  { cand: 'c1d6770715', id: 'equivalent-constant-built-differently', kind: 'altOk', file: 'mcp/x/result-gate.mjs',
    from: "return buildGateResult('FAILED', 'structural_execution_failure', evidence);", to: "return buildGateResult('FAILED', ['structural', 'execution', 'failure'].join('_'), evidence);", expect: { hidden: 'pass', net: 'pass' }, observe: ['visible:test'] },
  // 070e9850b1 (updater newness)
  { cand: '070e9850b1', id: 'equal-builtAt-counts-as-newer', kind: 'wrong', file: 'electron/updater.cjs',
    from: 'return manifestBuiltAtMs > currentBuiltAtMs;', to: 'return manifestBuiltAtMs >= currentBuiltAtMs;', expect: { hidden: 'fail' }, observe: ['visible:test', 'net'] },
  { cand: '070e9850b1', id: 'missing-timestamp-fails-open', kind: 'wrong', file: 'electron/updater.cjs',
    from: 'if (Number.isNaN(manifestBuiltAtMs) || Number.isNaN(currentBuiltAtMs)) return false;', to: 'if (Number.isNaN(manifestBuiltAtMs) || Number.isNaN(currentBuiltAtMs)) return true;', expect: { hidden: 'fail' }, observe: ['visible:test', 'net'] },
  { cand: '070e9850b1', id: 'version-compared-as-string', kind: 'wrong', file: 'electron/updater.cjs',
    from: 'const versionComparison = compareVersions(manifest.version, currentVersion);', to: 'const versionComparison = manifest.version === currentVersion ? 0 : (manifest.version > currentVersion ? 1 : -1);', expect: { hidden: 'fail' }, observe: ['visible:test', 'net'] },
  { cand: '070e9850b1', id: 'lower-version-falls-through-to-builtAt', kind: 'wrong', file: 'electron/updater.cjs',
    from: '  if (versionComparison === -1) return false;\n', to: '', expect: { hidden: 'fail' }, observe: ['visible:test', 'net'] },
  { cand: '070e9850b1', id: 'higher-version-falls-through-to-builtAt', kind: 'wrong', file: 'electron/updater.cjs',
    from: '  if (versionComparison === 1) return true;\n', to: '', expect: { hidden: 'fail' }, observe: ['visible:test', 'net'] },
  { cand: '070e9850b1', id: 'install-refuses-everything', kind: 'wrong', file: 'electron/updater.cjs',
    from: '  if (!isManifestNewer({ manifest, currentVersion, currentBuiltAt })) {\n    throw new Error', to: '  if (true) {\n    throw new Error', expect: { hidden: 'fail' }, observe: ['visible:test', 'net'] },
  { cand: '070e9850b1', id: 'install-no-longer-requires-user-approval (unchanged behavior)', kind: 'wrong', file: 'electron/updater.cjs',
    from: "if (userApproved !== true) throw new Error('Local user approval is required before installing an update.');", to: '', expect: { hidden: 'fail' }, observe: ['visible:test', 'net'] },
  { cand: '070e9850b1', id: 'equivalent-comparison-written-differently', kind: 'altOk', file: 'electron/updater.cjs',
    from: 'return manifestBuiltAtMs > currentBuiltAtMs;', to: 'return !(manifestBuiltAtMs <= currentBuiltAtMs);', expect: { hidden: 'pass', net: 'pass' }, observe: ['visible:test'] },
  // ---- Gold v1.2: the two findings from the Step-6E real-model run ----
  { cand: '070e9850b1', id: 'public-manifest-drops-buildId (what the Qwen patch did)', kind: 'wrong', file: 'electron/updater.cjs',
    from: 'version: manifest.version, buildId: manifest.buildId, builtAt: manifest.builtAt,', to: 'version: manifest.version, builtAt: manifest.builtAt,', expect: { hidden: 'fail' }, observe: ['visible:test', 'net'] },
  { cand: '070e9850b1', id: 'equivalent-fix-with-different-error-message (net must not flag it)', kind: 'altOk', file: 'electron/updater.cjs',
    from: "throw new Error('The selected build is not newer than the currently running version.');", to: "throw new Error('The update is not newer than the running version.');", expect: { hidden: 'pass', net: 'pass' }, observe: ['visible:test'] },
  // 8d08bc3621 (asar staging)
  { cand: '8d08bc3621', id: 'failure-cleanup-uses-patched-fs', kind: 'wrong', file: 'electron/remote-update-stager.cjs',
    from: "  if (stagingError) {\n    // Staging itself failed: the staged candidate (if any partial state\n    // exists) is never trusted, regardless of what happens to the mount.\n    await physicalFs.promises.rm(",
    to: "  if (stagingError) {\n    // Staging itself failed: the staged candidate (if any partial state\n    // exists) is never trusted, regardless of what happens to the mount.\n    await fs.promises.rm(", expect: { hidden: 'fail' }, observe: ['visible:test', 'net'] },
  { cand: '8d08bc3621', id: 'copy-merges-into-existing-destination', kind: 'wrong', file: 'electron/remote-update-stager.cjs',
    from: '    force: false,\n    errorOnExist: true,', to: '    force: true,\n    errorOnExist: false,', expect: { hidden: 'fail' }, observe: ['visible:test', 'net'] },
  { cand: '8d08bc3621', id: 'symlinks-dereferenced', kind: 'wrong', file: 'electron/remote-update-stager.cjs',
    from: '    verbatimSymlinks: true,', to: '    verbatimSymlinks: false,', expect: { hidden: 'fail' }, observe: ['visible:test', 'net'] },
  { cand: '8d08bc3621', id: 'top-level-symlink-candidate-accepted (unchanged behavior)', kind: 'wrong', file: 'electron/remote-update-stager.cjs',
    from: "  if (stat.isSymbolicLink()) throw new Error(`Top-level '${PRODUCT_NAME}' must not be a symlink.`);\n", to: '', expect: { hidden: 'fail' }, observe: ['visible:test', 'net'] },
  { cand: '8d08bc3621', id: 'traversal-buildId-accepted (unchanged behavior)', kind: 'wrong', file: 'electron/remote-update-stager.cjs',
    from: "if (!isCleanBuildIdSegment(manifest.buildId)) throw new Error('Manifest buildId is invalid for staging.');", to: '', expect: { hidden: 'fail' }, observe: ['visible:test', 'net'] },
  { cand: '8d08bc3621', id: 'tree-checksum-not-enforced (unchanged behavior)', kind: 'wrong', file: 'electron/remote-update-stager.cjs',
    from: "if (typeof manifest.sha256 === 'string' && actualSha256 !== manifest.sha256.toLowerCase()) {", to: "if (typeof manifest.sha256 === 'string' && false) {", expect: { hidden: 'fail' }, observe: ['visible:test', 'net'] },
  { cand: '8d08bc3621', id: 'equivalent-extra-dereference-false', kind: 'altOk', file: 'electron/remote-update-stager.cjs',
    from: '    verbatimSymlinks: true,', to: '    verbatimSymlinks: true,\n    dereference: false,', expect: { hidden: 'pass', net: 'pass' }, observe: ['visible:test'] },
];
