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

const finiteNumber = (value, code) => {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(code);
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

export const createMt5SocketBridge = ({
  host = LOOPBACK_HOST,
  httpPort = DEFAULT_HTTP_PORT,
  ingestPort = DEFAULT_INGEST_PORT,
  staleAfterMs = 15_000,
  now = () => Date.now(),
} = {}) => {
  if (host !== LOOPBACK_HOST) throw new Error('mt5_bridge_loopback_required');

  const snapshots = new Map();
  const activeSockets = new Set();
  let httpServer = null;
  let ingestServer = null;
  let started = false;

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
      received_at: new Date(entry.receivedAt).toISOString(),
      age_ms: Math.max(0, now() - entry.receivedAt),
      bar_count: entry.snapshot.bars.length,
    })),
  });

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
      json(res, 200, {
        ok: true,
        ...status(),
      });
      return;
    }

    if (url.pathname !== '/v1/bars') {
      json(res, 404, { error: 'not_found' });
      return;
    }

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
          const snapshot = normalizeMt5Snapshot(payload);
          snapshots.set(snapshot.timeframe, {
            snapshot,
            receivedAt: now(),
          });
        } catch {
          fail();
          return;
        }
      }
    });

    socket.on('error', () => {});
    socket.on('close', () => activeSockets.delete(socket));
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
    for (const socket of activeSockets) {
      try { socket.destroy(); } catch {}
    }
    activeSockets.clear();
    await Promise.all([closeServer(httpServer), closeServer(ingestServer)]);
    httpServer = null;
    ingestServer = null;
    snapshots.clear();
  };

  return {
    start,
    stop,
    status,
  };
};

export const MT5_BRIDGE_HTTP_PORT = DEFAULT_HTTP_PORT;
export const MT5_BRIDGE_INGEST_PORT = DEFAULT_INGEST_PORT;