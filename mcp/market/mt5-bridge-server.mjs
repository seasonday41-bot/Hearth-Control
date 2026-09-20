import http from 'node:http';
import net from 'node:net';

const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_HTTP_PORT = 8765;
const DEFAULT_INGEST_PORT = 8766;
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const ALLOWED_TIMEFRAMES = new Set(['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1']);

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
};

const normalizeSymbol = (value) => String(value || '').trim().toUpperCase().replace('/', '');

const isoFromEpochSeconds = (value, code) => {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(code);
  const date = new Date(seconds * 1000);
  if (!Number.isFinite(date.getTime())) throw new Error(code);
  return date.toISOString();
};

const isoString = (value, code) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(code);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(code);
  return date.toISOString();
};

const finiteNumber = (value, code, { positive = false, allowZero = true } = {}) => {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(code);
  if (positive && (allowZero ? number < 0 : number <= 0)) throw new Error(code);
  return number;
};

export const normalizeMt5Snapshot = (payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('mt5_bridge_invalid_payload');
  if (payload.type !== 'snapshot' || Number(payload.version) !== 1) throw new Error('mt5_bridge_invalid_version');
  if (normalizeSymbol(payload.canonical_symbol) !== 'XAUUSD') throw new Error('mt5_bridge_unsupported_symbol');

  const timeframe = String(payload.timeframe || '').trim().toUpperCase();
  if (!ALLOWED_TIMEFRAMES.has(timeframe)) throw new Error('mt5_bridge_unsupported_timeframe');

  const brokerSymbol = String(payload.broker_symbol || '').trim().slice(0, 64);
  if (!brokerSymbol) throw new Error('mt5_bridge_broker_symbol_required');

  if (!Array.isArray(payload.bars) || payload.bars.length < 20 || payload.bars.length > 500) {
    throw new Error('mt5_bridge_invalid_bar_count');
  }

  const bars = payload.bars.map((bar, index) => {
    if (!bar || typeof bar !== 'object' || Array.isArray(bar)) throw new Error(`mt5_bridge_invalid_bar:${index}`);
    const open = finiteNumber(bar.open, `mt5_bridge_invalid_open:${index}`);
    const high = finiteNumber(bar.high, `mt5_bridge_invalid_high:${index}`);
    const low = finiteNumber(bar.low, `mt5_bridge_invalid_low:${index}`);
    const close = finiteNumber(bar.close, `mt5_bridge_invalid_close:${index}`);
    if (high < low || high < Math.max(open, close) || low > Math.min(open, close)) {
      throw new Error(`mt5_bridge_invalid_range:${index}`);
    }
    const volume = bar.volume == null ? null : finiteNumber(bar.volume, `mt5_bridge_invalid_volume:${index}`);
    if (volume != null && volume < 0) throw new Error(`mt5_bridge_invalid_volume:${index}`);
    return {
      time: isoFromEpochSeconds(bar.time, `mt5_bridge_invalid_time:${index}`),
      open,
      high,
      low,
      close,
      volume,
    };
  });

  for (let index = 1; index < bars.length; index += 1) {
    if (bars[index - 1].time >= bars[index].time) throw new Error(`mt5_bridge_non_monotonic_time:${index}`);
  }

  const asOf = isoFromEpochSeconds(payload.as_of, 'mt5_bridge_invalid_as_of');
  if (bars.at(-1).time > asOf) throw new Error('mt5_bridge_as_of_before_latest_bar');

  return {
    symbol: 'XAUUSD',
    broker_symbol: brokerSymbol,
    timeframe,
    as_of: asOf,
    source: 'MT5',
    bars,
  };
};

export const normalizeMt5RiskSnapshot = (payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('mt5_risk_invalid_payload');
  if (payload.type !== 'risk_snapshot' || Number(payload.version) !== 1) throw new Error('mt5_risk_invalid_version');
  if (normalizeSymbol(payload.canonical_symbol) !== 'XAUUSD') throw new Error('mt5_risk_unsupported_symbol');

  const brokerSymbol = String(payload.broker_symbol || '').trim().slice(0, 64);
  if (!brokerSymbol) throw new Error('mt5_risk_broker_symbol_required');
  const asOf = isoFromEpochSeconds(payload.as_of, 'mt5_risk_invalid_as_of');

  const account = payload.account;
  const broker = payload.broker;
  if (!account || typeof account !== 'object' || Array.isArray(account)) throw new Error('mt5_risk_account_required');
  if (!broker || typeof broker !== 'object' || Array.isArray(broker)) throw new Error('mt5_risk_broker_required');

  const accountType = String(account.account_type || '').trim().toLowerCase();
  if (!['demo', 'live'].includes(accountType)) throw new Error('mt5_risk_account_type_invalid');
  const currency = String(account.currency || '').trim().toUpperCase().slice(0, 16);
  if (!currency) throw new Error('mt5_risk_currency_required');

  const equity = finiteNumber(account.equity, 'mt5_risk_equity_invalid', { positive: true, allowZero: false });
  const peakEquity = finiteNumber(account.peak_equity, 'mt5_risk_peak_equity_invalid', { positive: true, allowZero: false });
  const freeMargin = finiteNumber(account.free_margin, 'mt5_risk_free_margin_invalid', { positive: true });
  const dailyRealizedLoss = finiteNumber(account.daily_realized_loss, 'mt5_risk_daily_loss_invalid', { positive: true });
  const openRiskCurrency = finiteNumber(account.open_risk_currency, 'mt5_risk_open_risk_invalid', { positive: true });
  const openPositions = Number(account.open_positions);
  if (!Number.isInteger(openPositions) || openPositions < 0) throw new Error('mt5_risk_open_positions_invalid');
  if (typeof account.open_risk_complete !== 'boolean') throw new Error('mt5_risk_open_risk_complete_required');
  if (peakEquity < equity) throw new Error('mt5_risk_peak_equity_below_equity');

  const bid = finiteNumber(broker.bid, 'mt5_risk_bid_invalid', { positive: true, allowZero: false });
  const ask = finiteNumber(broker.ask, 'mt5_risk_ask_invalid', { positive: true, allowZero: false });
  if (ask < bid) throw new Error('mt5_risk_quote_invalid');

  const pointSize = finiteNumber(broker.point_size, 'mt5_risk_point_size_invalid', { positive: true, allowZero: false });
  const tickSize = finiteNumber(broker.tick_size, 'mt5_risk_tick_size_invalid', { positive: true, allowZero: false });
  const tickValuePerLot = finiteNumber(broker.tick_value_per_lot, 'mt5_risk_tick_value_invalid', { positive: true, allowZero: false });
  const volumeMin = finiteNumber(broker.volume_min, 'mt5_risk_volume_min_invalid', { positive: true, allowZero: false });
  const volumeMax = finiteNumber(broker.volume_max, 'mt5_risk_volume_max_invalid', { positive: true, allowZero: false });
  const volumeStep = finiteNumber(broker.volume_step, 'mt5_risk_volume_step_invalid', { positive: true, allowZero: false });
  const marginPerLot = finiteNumber(broker.margin_per_lot, 'mt5_risk_margin_invalid', { positive: true, allowZero: false });
  const estimatedSlippagePoints = finiteNumber(
    broker.estimated_slippage_points,
    'mt5_risk_slippage_invalid',
    { positive: true },
  );
  if (volumeMax < volumeMin || volumeStep > volumeMax) throw new Error('mt5_risk_volume_bounds_invalid');

  return {
    symbol: 'XAUUSD',
    broker_symbol: brokerSymbol,
    as_of: asOf,
    source: 'MT5',
    account: {
      account_type: accountType,
      currency,
      equity,
      peak_equity: peakEquity,
      free_margin: freeMargin,
      daily_realized_loss: dailyRealizedLoss,
      open_risk_currency: openRiskCurrency,
      open_positions: openPositions,
      open_risk_complete: account.open_risk_complete,
    },
    broker: {
      bid,
      ask,
      point_size: pointSize,
      tick_size: tickSize,
      tick_value_per_lot: tickValuePerLot,
      volume_min: volumeMin,
      volume_max: volumeMax,
      volume_step: volumeStep,
      margin_per_lot: marginPerLot,
      estimated_slippage_points: estimatedSlippagePoints,
    },
  };
};

export const normalizeMt5ExecutorHello = (payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('mt5_executor_hello_invalid');
  if (payload.type !== 'executor_hello' || Number(payload.version) !== 1) throw new Error('mt5_executor_hello_version_invalid');
  if (normalizeSymbol(payload.canonical_symbol) !== 'XAUUSD') throw new Error('mt5_executor_hello_symbol_invalid');
  const accountType = String(payload.account_type || '').toLowerCase();
  if (!['demo', 'live'].includes(accountType)) throw new Error('mt5_executor_hello_account_type_invalid');
  const brokerSymbol = String(payload.broker_symbol || '').trim().slice(0, 64);
  if (!brokerSymbol) throw new Error('mt5_executor_hello_broker_symbol_required');
  return {
    symbol: 'XAUUSD',
    broker_symbol: brokerSymbol,
    account_type: accountType,
    as_of: isoFromEpochSeconds(payload.as_of, 'mt5_executor_hello_as_of_invalid'),
  };
};

const normalizeDemoOrderCommand = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('mt5_demo_order_invalid');
  if (value.type !== 'demo_order' || value.version !== 'demo-execution-v1') throw new Error('mt5_demo_order_version_invalid');
  if (typeof value.request_id !== 'string' || !/^exec:v1:[a-f0-9]{24}$/.test(value.request_id)) throw new Error('mt5_demo_order_id_invalid');
  if (typeof value.request_tag !== 'string' || !/^HRT8_[A-F0-9]{12}$/.test(value.request_tag)) throw new Error('mt5_demo_order_tag_invalid');
  if (normalizeSymbol(value.canonical_symbol) !== 'XAUUSD') throw new Error('mt5_demo_order_symbol_invalid');
  if (!['BUY', 'SELL'].includes(value.side)) throw new Error('mt5_demo_order_side_invalid');
  const volume = finiteNumber(value.volume, 'mt5_demo_order_volume_invalid', { positive: true, allowZero: false });
  const referencePrice = finiteNumber(value.reference_price, 'mt5_demo_order_reference_price_invalid', { positive: true, allowZero: false });
  const stopLoss = finiteNumber(value.stop_loss, 'mt5_demo_order_stop_invalid', { positive: true, allowZero: false });
  const takeProfit = finiteNumber(value.take_profit, 'mt5_demo_order_target_invalid', { positive: true, allowZero: false });
  const maxDeviationPoints = Number(value.max_deviation_points);
  if (!Number.isInteger(maxDeviationPoints) || maxDeviationPoints < 0 || maxDeviationPoints > 100) {
    throw new Error('mt5_demo_order_deviation_invalid');
  }
  const createdAt = isoString(value.created_at, 'mt5_demo_order_created_at_invalid');
  const expiresAt = isoString(value.expires_at, 'mt5_demo_order_expires_at_invalid');
  const expiresEpoch = Number(value.expires_epoch);
  if (!Number.isInteger(expiresEpoch) || expiresEpoch <= 0) throw new Error('mt5_demo_order_expires_epoch_invalid');
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) throw new Error('mt5_demo_order_expiry_invalid');
  if (Math.abs((Date.parse(expiresAt) / 1000) - expiresEpoch) > 1) throw new Error('mt5_demo_order_expiry_mismatch');

  return {
    version: 'demo-execution-v1',
    type: 'demo_order',
    request_id: value.request_id,
    request_tag: value.request_tag,
    risk_decision_id: String(value.risk_decision_id || '').slice(0, 64),
    proposal_id: String(value.proposal_id || '').slice(0, 64),
    demo_session_id: String(value.demo_session_id || '').slice(0, 64),
    strategy: String(value.strategy || '').slice(0, 32),
    canonical_symbol: 'XAUUSD',
    side: value.side,
    volume,
    reference_price: referencePrice,
    stop_loss: stopLoss,
    take_profit: takeProfit,
    max_deviation_points: maxDeviationPoints,
    created_at: createdAt,
    expires_at: expiresAt,
    expires_epoch: expiresEpoch,
  };
};

const normalizeExecutionReceipt = (payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('mt5_execution_receipt_invalid');
  if (payload.type !== 'execution_receipt' || Number(payload.version) !== 1) throw new Error('mt5_execution_receipt_version_invalid');
  if (typeof payload.request_id !== 'string' || !/^exec:v1:[a-f0-9]{24}$/.test(payload.request_id)) {
    throw new Error('mt5_execution_receipt_request_invalid');
  }
  const accountType = String(payload.account_type || '').toLowerCase();
  if (!['demo', 'live'].includes(accountType)) throw new Error('mt5_execution_receipt_account_type_invalid');
  if (!['FILLED', 'REJECTED', 'DUPLICATE'].includes(payload.status)) throw new Error('mt5_execution_receipt_status_invalid');
  return {
    type: 'execution_receipt',
    version: 1,
    request_id: payload.request_id,
    status: payload.status,
    account_type: accountType,
    retcode: payload.retcode == null ? null : Number(payload.retcode),
    reason: String(payload.reason || '').slice(0, 200),
    order_ticket: payload.order_ticket == null ? null : String(payload.order_ticket).slice(0, 40),
    deal_ticket: payload.deal_ticket == null ? null : String(payload.deal_ticket).slice(0, 40),
    position_ticket: payload.position_ticket == null ? null : String(payload.position_ticket).slice(0, 40),
    fill_price: payload.fill_price == null ? null : Number(payload.fill_price),
    volume: payload.volume == null ? null : Number(payload.volume),
    stop_loss: payload.stop_loss == null ? null : Number(payload.stop_loss),
    take_profit: payload.take_profit == null ? null : Number(payload.take_profit),
    as_of: isoFromEpochSeconds(payload.as_of, 'mt5_execution_receipt_as_of_invalid'),
  };
};

export const createMt5SocketBridge = ({
  host = LOOPBACK_HOST,
  httpPort = DEFAULT_HTTP_PORT,
  ingestPort = DEFAULT_INGEST_PORT,
  staleAfterMs = 15_000,
  riskStaleAfterMs = staleAfterMs,
  executorStaleAfterMs = 15_000,
  now = () => Date.now(),
} = {}) => {
  if (host !== LOOPBACK_HOST) throw new Error('mt5_bridge_loopback_required');

  const snapshots = new Map();
  let riskEntry = null;
  let executorEntry = null;
  const pendingReceipts = new Map();
  const activeSockets = new Set();
  let httpServer = null;
  let ingestServer = null;
  let started = false;

  const executorFresh = () => executorEntry && Math.max(0, now() - executorEntry.receivedAt) <= executorStaleAfterMs;

  const status = () => ({
    running: started,
    host,
    http_port: httpPort,
    ingest_port: ingestPort,
    snapshots: [...snapshots.values()].map((entry) => ({
      symbol: entry.snapshot.symbol,
      broker_symbol: entry.snapshot.broker_symbol,
      timeframe: entry.snapshot.timeframe,
      as_of: entry.snapshot.as_of,
      latest_bar_time: entry.snapshot.bars.at(-1)?.time ?? null,
      latest_closed_bar_time: entry.snapshot.bars.at(-2)?.time ?? null,
      received_at: new Date(entry.receivedAt).toISOString(),
      age_ms: Math.max(0, now() - entry.receivedAt),
      bar_count: entry.snapshot.bars.length,
    })),
    risk_snapshot: riskEntry ? {
      symbol: riskEntry.snapshot.symbol,
      broker_symbol: riskEntry.snapshot.broker_symbol,
      account_type: riskEntry.snapshot.account.account_type,
      as_of: riskEntry.snapshot.as_of,
      received_at: new Date(riskEntry.receivedAt).toISOString(),
      age_ms: Math.max(0, now() - riskEntry.receivedAt),
      open_risk_complete: riskEntry.snapshot.account.open_risk_complete,
    } : null,
    executor_ready: Boolean(executorFresh()),
    executor_account_type: executorFresh() ? executorEntry.hello.account_type : null,
    executor_broker_symbol: executorFresh() ? executorEntry.hello.broker_symbol : null,
    executor_age_ms: executorEntry ? Math.max(0, now() - executorEntry.receivedAt) : null,
  });

  const handleRiskHttp = (url, res) => {
    const symbol = normalizeSymbol(url.searchParams.get('symbol'));
    if (symbol !== 'XAUUSD') {
      json(res, 400, { error: 'mt5_unsupported_symbol' });
      return;
    }
    if (!riskEntry) {
      json(res, 503, { error: 'mt5_no_risk_snapshot' });
      return;
    }
    const ageMs = Math.max(0, now() - riskEntry.receivedAt);
    if (ageMs > riskStaleAfterMs) {
      json(res, 503, { error: 'mt5_risk_snapshot_stale', age_ms: ageMs });
      return;
    }
    json(res, 200, riskEntry.snapshot);
  };

  const handleBarsHttp = (url, res) => {
    const symbol = normalizeSymbol(url.searchParams.get('symbol'));
    const timeframe = String(url.searchParams.get('timeframe') || '').trim().toUpperCase();
    const limit = Number(url.searchParams.get('limit') || 250);

    if (symbol !== 'XAUUSD') {
      json(res, 400, { error: 'mt5_unsupported_symbol' });
      return;
    }
    if (!ALLOWED_TIMEFRAMES.has(timeframe)) {
      json(res, 400, { error: 'mt5_unsupported_timeframe' });
      return;
    }
    if (!Number.isInteger(limit) || limit < 20 || limit > 500) {
      json(res, 400, { error: 'mt5_invalid_limit' });
      return;
    }

    const entry = snapshots.get(timeframe);
    if (!entry) {
      json(res, 503, { error: 'mt5_no_snapshot', timeframe });
      return;
    }

    const ageMs = Math.max(0, now() - entry.receivedAt);
    if (ageMs > staleAfterMs) {
      json(res, 503, { error: 'mt5_snapshot_stale', timeframe, age_ms: ageMs });
      return;
    }

    const bars = entry.snapshot.bars.slice(-limit);
    json(res, 200, {
      symbol: entry.snapshot.symbol,
      broker_symbol: entry.snapshot.broker_symbol,
      timeframe: entry.snapshot.timeframe,
      as_of: entry.snapshot.as_of,
      source: entry.snapshot.source,
      bars,
    });
  };

  const handleHttp = (req, res) => {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method_not_allowed' });
      return;
    }

    let url;
    try { url = new URL(req.url, `http://${host}:${httpPort}`); }
    catch {
      json(res, 400, { error: 'invalid_url' });
      return;
    }

    if (url.pathname === '/health') {
      json(res, 200, { ok: true, ...status() });
      return;
    }
    if (url.pathname === '/v1/risk-state') {
      handleRiskHttp(url, res);
      return;
    }
    if (url.pathname === '/v1/bars') {
      handleBarsHttp(url, res);
      return;
    }
    json(res, 404, { error: 'not_found' });
  };

  const rejectPendingForSocket = (socket, reason) => {
    for (const [requestId, pending] of pendingReceipts.entries()) {
      if (pending.socket !== socket) continue;
      clearTimeout(pending.timer);
      pendingReceipts.delete(requestId);
      pending.reject(new Error(reason));
    }
  };

  const handleSocket = (socket) => {
    activeSockets.add(socket);
    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    let buffer = '';

    const fail = () => {
      try { socket.destroy(); } catch {}
    };

    socket.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_LINE_BYTES) {
        fail();
        return;
      }

      while (true) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;

        let payload;
        try { payload = JSON.parse(line); }
        catch {
          fail();
          return;
        }

        try {
          if (payload?.type === 'snapshot') {
            const snapshot = normalizeMt5Snapshot(payload);
            snapshots.set(snapshot.timeframe, { snapshot, receivedAt: now() });
            continue;
          }
          if (payload?.type === 'risk_snapshot') {
            const snapshot = normalizeMt5RiskSnapshot(payload);
            riskEntry = { snapshot, receivedAt: now() };
            continue;
          }
          if (payload?.type === 'executor_hello') {
            const hello = normalizeMt5ExecutorHello(payload);
            if (executorEntry && executorEntry.socket !== socket && !executorEntry.socket.destroyed) {
              throw new Error('mt5_executor_already_connected');
            }
            executorEntry = { hello, socket, receivedAt: now() };
            continue;
          }
          if (payload?.type === 'execution_receipt') {
            if (!executorEntry || executorEntry.socket !== socket) throw new Error('mt5_executor_receipt_wrong_socket');
            const receipt = normalizeExecutionReceipt(payload);
            const pending = pendingReceipts.get(receipt.request_id);
            if (!pending) continue;
            clearTimeout(pending.timer);
            pendingReceipts.delete(receipt.request_id);
            pending.resolve(receipt);
            continue;
          }
          throw new Error('mt5_bridge_unknown_payload_type');
        } catch {
          fail();
          return;
        }
      }
    });

    socket.on('error', () => {});
    socket.on('close', () => {
      activeSockets.delete(socket);
      if (executorEntry?.socket === socket) {
        executorEntry = null;
        rejectPendingForSocket(socket, 'mt5_executor_disconnected');
      }
    });
  };

  const executeDemoOrder = (rawCommand, { timeoutMs = 7_000 } = {}) => {
    const command = normalizeDemoOrderCommand(rawCommand);
    if (!started) return Promise.reject(new Error('mt5_bridge_not_running'));
    if (!executorFresh()) return Promise.reject(new Error('mt5_executor_unavailable'));
    if (executorEntry.hello.account_type !== 'demo') return Promise.reject(new Error('mt5_executor_demo_account_required'));
    if (Date.parse(command.expires_at) <= now()) return Promise.reject(new Error('mt5_demo_order_expired'));
    if (pendingReceipts.has(command.request_id)) return Promise.reject(new Error('mt5_demo_order_already_pending'));

    const boundedTimeout = Math.max(1_000, Math.min(Number(timeoutMs) || 7_000, 30_000));
    return new Promise((resolve, reject) => {
      const socket = executorEntry.socket;
      const timer = setTimeout(() => {
        pendingReceipts.delete(command.request_id);
        reject(new Error('mt5_execution_receipt_timeout'));
      }, boundedTimeout);
      timer.unref?.();

      pendingReceipts.set(command.request_id, { resolve, reject, timer, socket });
      socket.write(`${JSON.stringify(command)}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        pendingReceipts.delete(command.request_id);
        reject(new Error('mt5_execution_send_failed'));
      });
    });
  };

  const listen = (server, port) => new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  const start = async () => {
    if (started) return status();
    httpServer = http.createServer(handleHttp);
    ingestServer = net.createServer(handleSocket);
    try {
      await listen(ingestServer, ingestPort);
      await listen(httpServer, httpPort);
      started = true;
      return status();
    } catch (error) {
      try { ingestServer?.close(); } catch {}
      try { httpServer?.close(); } catch {}
      ingestServer = null;
      httpServer = null;
      throw error;
    }
  };

  const closeServer = (server) => new Promise((resolve) => {
    if (!server?.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });

  const stop = async () => {
    if (!started && !httpServer && !ingestServer) return;
    started = false;
    for (const pending of pendingReceipts.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('mt5_bridge_stopped'));
    }
    pendingReceipts.clear();
    for (const socket of activeSockets) {
      try { socket.destroy(); } catch {}
    }
    activeSockets.clear();
    await Promise.all([closeServer(httpServer), closeServer(ingestServer)]);
    httpServer = null;
    ingestServer = null;
    snapshots.clear();
    riskEntry = null;
    executorEntry = null;
  };

  return { start, stop, status, executeDemoOrder };
};

export const MT5_BRIDGE_HTTP_PORT = DEFAULT_HTTP_PORT;
export const MT5_BRIDGE_INGEST_PORT = DEFAULT_INGEST_PORT;
