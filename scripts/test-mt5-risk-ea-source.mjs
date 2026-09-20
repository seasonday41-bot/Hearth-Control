import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../mql5/HearthXauBridgeV2.mq5', import.meta.url), 'utf8');

test('MT5 Risk EA V2.1 keeps loopback socket transport and sends both market and risk snapshots', () => {
  assert.match(source, /InpHost = "127\.0\.0\.1"/);
  assert.match(source, /InpPort = 8766/);
  assert.match(source, /type\\":\\"snapshot/);
  assert.match(source, /type\\":\\"risk_snapshot/);
  assert.match(source, /SocketCreate\(/);
  assert.match(source, /SocketConnect\(/);
  assert.match(source, /SocketSend\(/);
});

test('MT5 Risk EA V2.2 reads only bounded account/broker telemetry and does not send account identifiers', () => {
  assert.match(source, /ACCOUNT_EQUITY/);
  assert.match(source, /ACCOUNT_MARGIN_FREE/);
  assert.match(source, /ACCOUNT_TRADE_MODE/);
  assert.match(source, /SYMBOL_TRADE_TICK_SIZE/);
  assert.match(source, /SYMBOL_TRADE_TICK_VALUE/);
  assert.match(source, /SYMBOL_VOLUME_STEP/);
  assert.match(source, /OrderCalcMargin\(/);
  assert.match(source, /PositionsTotal\(/);
  assert.match(source, /HistorySelect\(/);
  assert.doesNotMatch(source, /ACCOUNT_LOGIN|ACCOUNT_NAME|ACCOUNT_SERVER|login|account_number/i);
});

test('MT5 Risk EA V2.3 has no order placement or position mutation path', () => {
  assert.doesNotMatch(source, /OrderSend\s*\(/i);
  assert.doesNotMatch(source, /CTrade|trade\.Buy|trade\.Sell|PositionOpen|PositionClose|PositionModify/i);
  assert.match(source, /OrderCalcMargin\(/);
});

test('MT5 Risk EA V2.4 open risk is fail-closed when any position lacks SL or sizing metadata', () => {
  assert.match(source, /if\(stopLoss <= 0\.0 \|\| volume <= 0\.0\)/);
  assert.match(source, /return false;/);
  assert.match(source, /open_risk_complete/);
});

test('MT5 Risk EA V2.5 daily peak equity is persisted locally without exposing an account id', () => {
  assert.match(source, /GlobalVariableCheck\(/);
  assert.match(source, /GlobalVariableGet\(/);
  assert.match(source, /GlobalVariableSet\(/);
  assert.match(source, /HEARTH_XAU_PEAK_/);
});
