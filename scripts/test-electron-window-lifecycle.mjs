// Focused tests for the Electron main-window lifecycle: createWindow's
// stale-reference cleanup on 'closed', and the second-instance handler's
// destruction-safety. Regression coverage for a real, previously-observed
// production crash: reopening Hearth Control while an older process was
// still alive (window closed, but the app intentionally does not quit on
// macOS) threw `TypeError: Object has been destroyed` from
// `mainWindow.isMinimized()`, because `mainWindow` was never cleared when
// its window was destroyed.
//
// electron/main.cjs requires the real `electron` module and Electron app
// lifecycle, so it cannot be executed directly in a plain Node test process
// (same constraint scripts/test-updater.mjs, scripts/test-electron-x-wakeup.mjs,
// and scripts/test-electron-x-queue-integration.mjs already work around).
// This suite statically verifies the real committed source, then extracts
// the EXACT createWindow / second-instance text and executes it via a
// factory wrapper against fake BrowserWindow/app doubles -- never a
// hand-copied duplicate of the logic.
//
// Deliberately scoped to just this window-lifecycle concern: not mixed into
// the X-specific electron-x-wakeup/electron-x-queue-integration suites,
// which cover an unrelated feature.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const mainSource = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');

// ── extraction ───────────────────────────────────────────────────────────

const createWindowStart = mainSource.indexOf('const createWindow = () => {');
const createWindowEnd = mainSource.indexOf('\nconst hasSingleInstanceLock = app.requestSingleInstanceLock();');
assert.ok(createWindowStart !== -1 && createWindowEnd !== -1, 'the createWindow function must be found in electron/main.cjs');
const createWindowSource = mainSource.slice(createWindowStart, createWindowEnd);

const secondInstanceStart = mainSource.indexOf("app.on('second-instance', () => {");
const secondInstanceEnd = mainSource.indexOf('\napp.whenReady().then(async () => {');
assert.ok(secondInstanceStart !== -1 && secondInstanceEnd !== -1, 'the second-instance handler must be found in electron/main.cjs');
const secondInstanceSource = mainSource.slice(secondInstanceStart, secondInstanceEnd);

/**
 * Builds a fresh, isolated instance of the EXACT createWindow + second-instance
 * text extracted above, sharing the same `let mainWindow` closure they both
 * reference in the real file. `app.on(...)` is faked to just capture the
 * registered handler by event name, so tests can invoke it directly instead
 * of relying on a real Electron event loop. `setMainWindow` is test-only
 * plumbing (electron/main.cjs itself never exposes such a setter) used to
 * force the exact destroyed-but-truthy-reference precondition the real
 * crash required, since the fixed closed-handler would otherwise make that
 * state unreachable through createWindow()/simulateClosed() alone.
 */
function buildLifecycleHarness({ devServerUrl } = {}) {
  const windows = [];
  const makeFakeWindow = (opts) => {
    const win = {
      opts,
      destroyed: false,
      minimized: false,
      calls: { loadURL: 0, loadFile: 0, restore: 0, focus: 0 },
      listeners: {},
      on(event, cb) { (this.listeners[event] ??= []).push(cb); return this; },
      loadURL() { this.calls.loadURL += 1; },
      loadFile() { this.calls.loadFile += 1; },
      isMinimized() {
        if (this.destroyed) throw new Error('Object has been destroyed');
        return this.minimized;
      },
      isDestroyed() { return this.destroyed; },
      restore() {
        if (this.destroyed) throw new Error('Object has been destroyed');
        this.calls.restore += 1;
        this.minimized = false;
      },
      focus() {
        if (this.destroyed) throw new Error('Object has been destroyed');
        this.calls.focus += 1;
      },
      simulateClosed() {
        this.destroyed = true;
        for (const cb of this.listeners.closed || []) cb();
      },
    };
    windows.push(win);
    return win;
  };
  const FakeBrowserWindow = function (opts) { return makeFakeWindow(opts); };

  const handlers = {};
  const app = { on: (event, cb) => { handlers[event] = cb; } };
  const readSettings = () => ({});
  const path = { join: (...parts) => parts.join('/') };
  const processDouble = { env: { VITE_DEV_SERVER_URL: devServerUrl } };

  const factorySource = `
    let mainWindow;
    ${createWindowSource}
    ${secondInstanceSource}
    return { createWindow, getMainWindow: () => mainWindow, setMainWindow: (w) => { mainWindow = w; } };
  `;
  const factory = new Function(
    'BrowserWindow', 'app', 'readSettings', 'path', '__dirname', 'process',
    factorySource,
  );
  const instance = factory(FakeBrowserWindow, app, readSettings, path, '/fake/electron', processDouble);
  return {
    ...instance,
    windows,
    triggerSecondInstance: () => handlers['second-instance'](),
  };
}

// ── static: real committed source shape ─────────────────────────────────

test('WL-S1 createWindow registers a closed handler that identity-checks before clearing mainWindow', () => {
  assert.match(
    createWindowSource,
    /const window = mainWindow;\s*\n\s*window\.on\('closed', \(\) => \{\s*\n\s*if \(mainWindow === window\) mainWindow = null;/,
    'createWindow must clear mainWindow on close only if it is still the same window instance',
  );
});

test('WL-S2 second-instance never calls a BrowserWindow method before checking destruction', () => {
  assert.match(
    secondInstanceSource,
    /if \(!mainWindow \|\| mainWindow\.isDestroyed\(\)\) \{\s*\n\s*createWindow\(\);\s*\n\s*return;\s*\n\s*\}/,
    'second-instance must create a fresh window whenever there is no valid, live mainWindow',
  );
});

test('WL-S3 second-instance restores-if-minimized then focuses only after the destruction guard', () => {
  const guardIdx = secondInstanceSource.indexOf('mainWindow.isDestroyed()');
  const restoreIdx = secondInstanceSource.indexOf('mainWindow.isMinimized()');
  const focusIdx = secondInstanceSource.indexOf('mainWindow.focus();');
  assert.ok(guardIdx !== -1 && restoreIdx !== -1 && focusIdx !== -1);
  assert.ok(guardIdx < restoreIdx && restoreIdx < focusIdx, 'the destruction guard must run before isMinimized()/restore()/focus()');
});

test('WL-S4 window-all-closed still only quits on non-macOS (unchanged by this fix)', () => {
  assert.match(
    mainSource,
    /app\.on\('window-all-closed', \(\) => \{ if \(process\.platform !== 'darwin'\) app\.quit\(\); \}\);/,
    'macOS must keep running with all windows closed, exactly as before',
  );
});

test('WL-S5 this fix does not touch serverProcess start/stop wiring', () => {
  assert.doesNotMatch(createWindowSource, /serverProcess/, 'createWindow must not reference serverProcess');
  assert.doesNotMatch(secondInstanceSource, /serverProcess/, 'second-instance must not reference serverProcess');
});

// ── dynamic: the exact extracted code, executed against fake doubles ─────

test('WL1 a destroyed-but-truthy mainWindow reference is never used by second-instance -- a fresh window replaces it', () => {
  const harness = buildLifecycleHarness();
  harness.createWindow();
  const first = harness.getMainWindow();
  first.simulateClosed();
  assert.equal(harness.getMainWindow(), null, 'closing the window must clear the stale mainWindow reference');

  // Force mainWindow back to the destroyed object -- exactly reproducing the
  // real crash precondition (a truthy reference to an already-destroyed
  // BrowserWindow) that the closed-handler fix normally prevents from ever
  // occurring on its own. This proves second-instance's OWN destruction
  // guard is what makes it safe, independent of the closed-handler fix.
  harness.setMainWindow(first);
  assert.doesNotThrow(() => harness.triggerSecondInstance());
  assert.equal(harness.windows.length, 2, 'exactly one fresh replacement window must be created');
  const replacement = harness.windows[1];
  assert.equal(replacement.destroyed, false);
  assert.equal(harness.getMainWindow(), replacement, 'mainWindow must now point at the fresh, live window');
  assert.equal(first.calls.restore, 0, 'restore() must never be called on the destroyed window');
  assert.equal(first.calls.focus, 0, 'focus() must never be called on the destroyed window');
});

test('WL2 second-instance with no valid window (never created) creates a new window', () => {
  const harness = buildLifecycleHarness();
  assert.equal(harness.getMainWindow(), undefined);
  harness.triggerSecondInstance();
  assert.equal(harness.windows.length, 1, 'a fresh window must be created');
  assert.equal(harness.getMainWindow(), harness.windows[0]);
});

test('WL3 second-instance with no valid window (closed) creates a new window, not a second stale one', () => {
  const harness = buildLifecycleHarness();
  harness.createWindow();
  harness.getMainWindow().simulateClosed();
  harness.triggerSecondInstance();
  assert.equal(harness.windows.length, 2, 'exactly one new window must be created');
  assert.equal(harness.windows[1].destroyed, false);
  assert.equal(harness.getMainWindow(), harness.windows[1]);
});

test('WL4 second-instance with a live minimized window restores and focuses it, without creating a new one', () => {
  const harness = buildLifecycleHarness();
  harness.createWindow();
  const win = harness.getMainWindow();
  win.minimized = true;
  harness.triggerSecondInstance();
  assert.equal(harness.windows.length, 1, 'no new window may be created for a live window');
  assert.equal(win.calls.restore, 1);
  assert.equal(win.calls.focus, 1);
  assert.equal(win.minimized, false);
});

test('WL5 second-instance with a live, non-minimized window only focuses it -- no restore, no recreation', () => {
  const harness = buildLifecycleHarness();
  harness.createWindow();
  const win = harness.getMainWindow();
  win.minimized = false;
  harness.triggerSecondInstance();
  assert.equal(harness.windows.length, 1);
  assert.equal(win.calls.restore, 0, 'restore() must not be called on an already-visible window');
  assert.equal(win.calls.focus, 1);
});

test("WL6 an older, already-superseded window's closed event never clobbers a newer live mainWindow", () => {
  const harness = buildLifecycleHarness();
  harness.createWindow();
  const first = harness.getMainWindow();
  harness.createWindow(); // supersedes `first` without it ever closing (e.g. a second createWindow() call)
  const second = harness.getMainWindow();
  assert.notEqual(first, second);
  first.simulateClosed(); // a delayed/late 'closed' event from the OLD window
  assert.equal(harness.getMainWindow(), second, "the stale window's close must not null out the current, different mainWindow");
});

test('WL7 createWindow always wires exactly one closed handler per window', () => {
  const harness = buildLifecycleHarness();
  harness.createWindow();
  const win = harness.getMainWindow();
  assert.equal((win.listeners.closed || []).length, 1);
});
