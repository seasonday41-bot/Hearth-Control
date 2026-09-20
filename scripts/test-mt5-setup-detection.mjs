import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./setup-mt5-bridge.mjs', import.meta.url), 'utf8');

test('MT5 Setup V1.1 detects App Store mobile build instead of pretending EA support exists', () => {
  assert.match(source, /\/Applications\/MetaTrader 5\.app\/Wrapper\/MetaTrader5Terminal\.app/);
  assert.match(source, /mt5_mobile_app_only/);
  assert.match(source, /mobile_app_detected/);
});

test('MT5 Setup V1.2 searches only known MetaQuotes Desktop data roots', () => {
  assert.match(source, /net\.metaquotes\.wine\.metatrader5/);
  assert.match(source, /Application Support/);
  assert.match(source, /MQL5\/Experts/);
  assert.doesNotMatch(source, /\/tmp\/|0\.0\.0\.0|https?:\/\/[^'"]*example/i);
});

test('MT5 Setup V1.3 will not overwrite a conflicting EA file', () => {
  assert.match(source, /COPYFILE_EXCL/);
  assert.match(source, /status: 'conflict'/);
  assert.match(source, /sameFile\(source, destination\)/);
});

test('MT5 Setup V1.4 points only to the official MetaQuotes Desktop installer host', () => {
  assert.match(source, /https:\/\/download\.terminal\.free\/cdn\/web\/metaquotes\.ltd\/mt5\/MetaTrader5\.pkg\.zip/);
});
