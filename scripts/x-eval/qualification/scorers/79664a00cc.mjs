// Hidden scorer: after the main window is closed (macOS keeps the app alive), a
// second launch must open a fresh window and never call a method on a destroyed
// BrowserWindow. Independent of the visible test: own fake window (EVERY method,
// including `on`, throws once destroyed; only isDestroyed() stays callable, as in
// Electron) and scenario-style checks. It still extracts createWindow /
// second-instance from electron/main.cjs by marker, so it is coupled to those two
// markers but NOT to any literal implementation text.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createScorer, parseRoot } from './_lib.mjs';

const root = parseRoot();
const s = createScorer();
let build;
await s.check('extract createWindow + second-instance from electron/main.cjs', () => {
  const main = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8');
  const cwStart = main.indexOf('const createWindow = () => {');
  const cwEnd = main.indexOf('\nconst hasSingleInstanceLock = app.requestSingleInstanceLock();');
  const siStart = main.indexOf("app.on('second-instance', () => {");
  const siEnd = main.indexOf('\napp.whenReady().then(async () => {');
  assert.ok(cwStart >= 0 && cwEnd > cwStart && siStart >= 0 && siEnd > siStart, 'markers not found');
  const source = `let mainWindow;\n${main.slice(cwStart, cwEnd)}\n${main.slice(siStart, siEnd)}\nreturn { createWindow, get: () => mainWindow };`;
  build = () => {
    const windows = [];
    const handlers = {};
    class FakeWindow {
      constructor() { this.destroyed = false; this.minimized = false; this.log = []; this.closedCbs = []; windows.push(this); }
      guard(m) { if (this.destroyed) throw new Error(`Object has been destroyed (${m})`); this.log.push(m); }
      on(event, cb) { this.guard('on'); if (event === 'closed') this.closedCbs.push(cb); return this; }
      loadURL() { this.guard('loadURL'); }
      loadFile() { this.guard('loadFile'); }
      isMinimized() { this.guard('isMinimized'); return this.minimized; }
      isDestroyed() { return this.destroyed; }
      restore() { this.guard('restore'); this.minimized = false; }
      focus() { this.guard('focus'); }
      close() { this.destroyed = true; for (const cb of this.closedCbs) cb(); }
      get webContents() { this.guard('webContents'); return { on() {}, setWindowOpenHandler() {} }; }
    }
    const factory = new Function('BrowserWindow', 'app', 'readSettings', 'path', '__dirname', 'process', source);
    const api = factory(FakeWindow, { on: (e, cb) => { handlers[e] = cb; } }, () => ({}), { join: (...p) => p.join('/') }, '/fake', { env: {} });
    return { ...api, windows, secondInstance: () => handlers['second-instance']() };
  };
});
if (!build) s.finish();

await s.check('window closed, then second launch -> a fresh live window replaces it, no call on the destroyed one', () => {
  const h = build(); h.createWindow(); const first = h.windows[0];
  first.close(); h.secondInstance();
  assert.equal(h.windows.length, 2);
  assert.equal(h.get(), h.windows[1]);
  assert.equal(h.windows[1].isDestroyed(), false);
});
await s.check('closed then two second launches -> exactly one replacement window; the second launch just focuses it', () => {
  const h = build(); h.createWindow(); h.windows[0].close();
  h.secondInstance(); h.secondInstance();
  assert.equal(h.windows.length, 2);
  assert.ok(h.windows[1].log.includes('focus'));
});
await s.check('second launch before any window exists -> creates one', () => {
  const h = build(); h.secondInstance();
  assert.equal(h.windows.length, 1);
});
await s.check('live minimized window -> restored then focused, no new window', () => {
  const h = build(); h.createWindow(); h.windows[0].minimized = true; h.secondInstance();
  assert.equal(h.windows.length, 1);
  assert.equal(h.windows[0].minimized, false);
  assert.ok(h.windows[0].log.indexOf('restore') < h.windows[0].log.lastIndexOf('focus'));
});
await s.check('live non-minimized window -> focused only (no restore, no new window)', () => {
  const h = build(); h.createWindow(); h.secondInstance();
  assert.equal(h.windows.length, 1);
  assert.ok(!h.windows[0].log.includes('restore'));
});
await s.check('a superseded window closing later must not clear the newer live window', () => {
  const h = build(); h.createWindow(); h.createWindow();
  const [older, newer] = h.windows;
  older.close();
  assert.equal(h.get(), newer);
  h.secondInstance();
  assert.equal(h.windows.length, 2, 'must reuse the live window');
});
s.finish();
