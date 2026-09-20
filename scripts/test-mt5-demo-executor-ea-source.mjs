import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../mql5/HearthXauDemoExecutorV3.mq5', import.meta.url), 'utf8');

test('MT5 Demo EA V3.1 advertises executor capability over loopback only', () => {
  assert.match(source, /InpHost = "127\.0\.0\.1"/);
  assert.match(source, /type\\":\\"executor_hello/);
  assert.match(source, /type\\":\\"risk_snapshot/);
  assert.match(source, /type\\":\\"snapshot/);
  assert.match(source, /SocketRead\(/);
  assert.match(source, /SocketSend\(/);
});

test('MT5 Demo EA V3.2 checks DEMO account immediately before every order', () => {
  assert.match(source, /AccountInfoInteger\(ACCOUNT_TRADE_MODE\) != ACCOUNT_TRADE_MODE_DEMO/);
  assert.match(source, /demo_account_required/);
  assert.doesNotMatch(source, /ACCOUNT_LOGIN|ACCOUNT_NAME|ACCOUNT_SERVER|account_number/i);
});

test('MT5 Demo EA V3.3 uses OrderCheck before OrderSend and only market DEAL requests', () => {
  const checkIndex = source.indexOf('OrderCheck(request, check)');
  const sendIndex = source.indexOf('OrderSend(request, result)');
  assert.ok(checkIndex >= 0);
  assert.ok(sendIndex > checkIndex);
  assert.match(source, /request\.action = TRADE_ACTION_DEAL/);
  assert.match(source, /request\.type = side == "BUY" \? ORDER_TYPE_BUY : ORDER_TYPE_SELL/);
  assert.doesNotMatch(source, /TRADE_ACTION_PENDING/);
});

test('MT5 Demo EA V3.4 stable request tag prevents duplicate execution across retry/restart evidence', () => {
  assert.match(source, /ExistingRequest\(/);
  assert.match(source, /POSITION_COMMENT/);
  assert.match(source, /DEAL_COMMENT/);
  assert.match(source, /g_last_request_id/);
  assert.match(source, /"DUPLICATE"/);
});

test('MT5 Demo EA V3.5 command expiry, deviation, broker volume step and stops are validated before send', () => {
  assert.match(source, /command_expired/);
  assert.match(source, /price_moved_beyond_deviation/);
  assert.match(source, /volume_step_invalid/);
  assert.match(source, /SYMBOL_TRADE_STOPS_LEVEL/);
  assert.match(source, /stop_target_invalid/);
});

test('MT5 Demo EA V3.6 there is no live-account override or remote HTTP execution endpoint in EA', () => {
  assert.doesNotMatch(source, /LIVE_AUTO|allow_live|force_live|WebRequest\(/i);
  assert.match(source, /ACCOUNT_TRADE_MODE_DEMO/);
});
