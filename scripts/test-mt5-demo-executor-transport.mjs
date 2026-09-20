import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createMt5SocketBridge } from '../mcp/market/mt5-bridge-server.mjs';

const baseMs = Date.UTC(2026, 8, 21, 2, 0, 0);
const baseEpoch = Math.floor(baseMs / 1000);

const command = (overrides = {}) => ({
  version: 'demo-execution-v1',
  type: 'demo_order',
  request_id: 'exec:v1:aaaaaaaaaaaaaaaaaaaaaaaa',
  request_tag: 'HRT8_AAAAAAAAAAAA',
  risk_decision_id: 'riskdec:v1:bbbbbbbbbbbbbbbbbbbbbbbb',
  proposal_id: 'techsig:v1:cccccccccccccccccccccccc',
  demo_session_id: 'demo:11111111-1111-4111-8111-111111111111',
  strategy: 'SMC_IDM',
  canonical_symbol: 'XAUUSD',
  side: 'BUY',
  volume: 0.5,
  reference_price: 2501,
  stop_loss: 2495,
  take_profit: 2512,
  max_deviation_points: 3,
  created_at: new Date(baseMs).toISOString(),
  expires_at: new Date(baseMs + 5000).toISOString(),
  expires_epoch: Math.floor((baseMs + 5000) / 1000),
  ...overrides,
});

const connectExecutor = ({ port, accountType = 'demo', onCommand }) => new Promise((resolve, reject) => {
  const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
    socket.setEncoding('utf8');
    socket.write(`${JSON.stringify({
      type: 'executor_hello',
      version: 1,
      canonical_symbol: 'XAUUSD',
      broker_symbol: 'GOLD',
      account_type: accountType,
      as_of: baseEpoch,
    })}\n`);
    resolve(socket);
  });
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      onCommand?.(JSON.parse(line), socket);
    }
  });
  socket.on('error', reject);
});

test('MT5 Demo Transport V3.1 executor hello registers one demo-only command channel', async () => {
  const bridge = createMt5SocketBridge({
    httpPort: 18825,
    ingestPort: 18826,
    executorStaleAfterMs: 30_000,
    now: () => baseMs,
  });

  let socket;
  try {
    await bridge.start();
    socket = await connectExecutor({ port: 18826 });
    await new Promise((resolve) => setTimeout(resolve, 15));

    const status = bridge.status();
    assert.equal(status.executor_ready, true);
    assert.equal(status.executor_account_type, 'demo');
    assert.equal(status.executor_broker_symbol, 'GOLD');
  } finally {
    socket?.destroy();
    await bridge.stop();
  }
});

test('MT5 Demo Transport V3.2 in-process demo command receives a matching broker receipt', async () => {
  const bridge = createMt5SocketBridge({
    httpPort: 18827,
    ingestPort: 18828,
    executorStaleAfterMs: 30_000,
    now: () => baseMs,
  });

  let socket;
  try {
    socket = null;
    await bridge.start();
    socket = await connectExecutor({
      port: 18828,
      onCommand: (request, client) => {
        assert.equal(request.type, 'demo_order');
        assert.equal(request.request_id, command().request_id);
        assert.equal(request.expires_epoch, command().expires_epoch);
        client.write(`${JSON.stringify({
          type: 'execution_receipt',
          version: 1,
          request_id: request.request_id,
          status: 'FILLED',
          account_type: 'demo',
          retcode: 10009,
          reason: 'done',
          order_ticket: '101',
          deal_ticket: '202',
          position_ticket: '303',
          fill_price: 2501,
          volume: 0.5,
          stop_loss: 2495,
          take_profit: 2512,
          as_of: baseEpoch + 1,
        })}\n`);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 15));

    const receipt = await bridge.executeDemoOrder(command());
    assert.equal(receipt.status, 'FILLED');
    assert.equal(receipt.account_type, 'demo');
    assert.equal(receipt.request_id, command().request_id);
    assert.equal(receipt.volume, 0.5);
  } finally {
    socket?.destroy();
    await bridge.stop();
  }
});

test('MT5 Demo Transport V3.3 a live-account executor channel can never receive a demo order', async () => {
  const bridge = createMt5SocketBridge({
    httpPort: 18829,
    ingestPort: 18830,
    executorStaleAfterMs: 30_000,
    now: () => baseMs,
  });

  let socket;
  try {
    await bridge.start();
    socket = await connectExecutor({ port: 18830, accountType: 'live' });
    await new Promise((resolve) => setTimeout(resolve, 15));

    await assert.rejects(
      () => bridge.executeDemoOrder(command()),
      /demo_account_required/,
    );
  } finally {
    socket?.destroy();
    await bridge.stop();
  }
});

test('MT5 Demo Transport V3.4 stale executor heartbeat fails closed', async () => {
  let now = baseMs;
  const bridge = createMt5SocketBridge({
    httpPort: 18831,
    ingestPort: 18832,
    executorStaleAfterMs: 1000,
    now: () => now,
  });

  let socket;
  try {
    await bridge.start();
    socket = await connectExecutor({ port: 18832 });
    await new Promise((resolve) => setTimeout(resolve, 15));
    now += 2000;

    assert.equal(bridge.status().executor_ready, false);
    await assert.rejects(
      () => bridge.executeDemoOrder(command({
        created_at: new Date(now).toISOString(),
        expires_at: new Date(now + 5000).toISOString(),
        expires_epoch: Math.floor((now + 5000) / 1000),
      })),
      /executor_unavailable/,
    );
  } finally {
    socket?.destroy();
    await bridge.stop();
  }
});

test('MT5 Demo Transport V3.5 HTTP surface remains read-only and cannot submit orders', async () => {
  const bridge = createMt5SocketBridge({
    httpPort: 18833,
    ingestPort: 18834,
    now: () => baseMs,
  });
  try {
    await bridge.start();
    const response = await fetch('http://127.0.0.1:18833/v1/demo-order', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(command()),
    });
    assert.equal(response.status, 405);
  } finally {
    await bridge.stop();
  }
});
