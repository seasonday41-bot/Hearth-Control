import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../mql5/HearthXauBridge.mq5', import.meta.url), 'utf8');

test('MT5 EA V1.1 uses localhost socket transport and H1 default', () => {
  assert.match(source, /InpHost = "127\.0\.0\.1"/);
  assert.match(source, /InpPort = 8766/);
  assert.match(source, /InpTimeframe = PERIOD_H1/);
  assert.match(source, /SocketCreate\(/);
  assert.match(source, /SocketConnect\(/);
  assert.match(source, /SocketSend\(/);
});

test('MT5 EA V1.2 is market-data only and has no trade/account APIs', () => {
  assert.match(source, /CopyRates\(/);
  assert.match(source, /tick_volume/);
  assert.doesNotMatch(source, /OrderSend|CTrade|PositionOpen|PositionClose|trade\.Buy|trade\.Sell/i);
  assert.doesNotMatch(source, /AccountInfo|ACCOUNT_LOGIN|ACCOUNT_BALANCE|ACCOUNT_EQUITY/i);
});

test('MT5 EA V1.3 protocol is canonical XAUUSD snapshot v1', () => {
  assert.match(source, /canonical_symbol\\":\\"XAUUSD/);
  assert.match(source, /type\\":\\"snapshot/);
  assert.match(source, /version\\":1/);
  assert.match(source, /broker_symbol/);
  assert.match(source, /timeframe/);
  assert.match(source, /bars/);
});

test('MT5 EA V1.4 documents the MT5 allowlist requirement', () => {
  assert.match(source, /Add 127\.0\.0\.1/);
  assert.match(source, /allowed addresses/i);
});
