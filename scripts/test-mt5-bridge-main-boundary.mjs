import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const main = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');

test('MT5 Bridge Main V1.1 Hearth owns exactly one bridge lifecycle reference', () => {
  assert.match(main, /let mt5BridgeServer = null;/);
  assert.match(main, /createMt5SocketBridge/);
  assert.match(main, /mt5BridgeServer = createMt5SocketBridge\(\)/);
});

test('MT5 Bridge Main V1.2 startup failure does not abort Hearth startup', () => {
  assert.match(main, /\[MT5Bridge\] Failed to start local bridge:/);
  assert.match(main, /mt5BridgeServer = null;/);
  assert.match(main, /createWindow\(\);/);
});

test('MT5 Bridge Main V1.3 bridge is stopped during Hearth shutdown', () => {
  assert.match(main, /if \(mt5BridgeServer\) \{/);
  assert.match(main, /void bridge\.stop\(\)\.catch/);
});

test('MT5 Bridge Main V1.4 bridge module is loopback data-plane only', () => {
  const bridge = fs.readFileSync(new URL('../mcp/market/mt5-bridge-server.mjs', import.meta.url), 'utf8');
  assert.match(bridge, /const LOOPBACK_HOST = '127\.0\.0\.1'/);
  assert.doesNotMatch(bridge, /listen\([^\n]*0\.0\.0\.0/);
  assert.doesNotMatch(bridge, /order_send|positions_get|account_info|trade/i);
});

test('MT5 Bridge Main V1.5 packaged release includes the MQL5 EA source', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.build.files.includes('mql5/**/*'));
});
