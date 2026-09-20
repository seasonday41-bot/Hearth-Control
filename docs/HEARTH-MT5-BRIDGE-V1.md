# Hearth MT5 Bridge V1 — XAU/USD

Status: implemented in Hearth. The Mac currently has the App Store/iPhoneOS MT5 build, but the Desktop/Wine build required for MQL5 Expert Advisors is not installed yet.

## Architecture

```text
MetaTrader 5 (macOS/Wine)
  |
  | HearthXauBridge.mq5
  | read-only CopyRates()
  | TCP push every 2s
  v
127.0.0.1:8766
  |
  | Hearth MT5 bridge
  v
127.0.0.1:8765
  |
  | GET /v1/bars?symbol=XAUUSD&timeframe=H1&limit=...
  v
Mt5LoopbackAdapter
  |
  v
Invest AI
```

Hearth owns both loopback listeners. They start with Hearth Control and stop during Hearth shutdown.

## Security boundary

The bridge is market-data only.

The MQL5 EA:

- uses `CopyRates()`
- sends OHLC + tick volume
- does not read account balance/equity/login
- does not call OrderSend/CTrade/position APIs
- connects only to the configured local bridge host/port

The Hearth bridge:

- binds only to `127.0.0.1`
- accepts canonical `XAUUSD` snapshot v1
- validates timeframe, bar count, OHLC ranges and monotonic timestamps
- exposes only read-only HTTP market-data/health endpoints
- rejects stale snapshots
- does not expose trade/account operations

## Ports

```text
TCP ingest : 127.0.0.1:8766
HTTP bars  : 127.0.0.1:8765
```

## MT5 EA

Source:

```text
mql5/HearthXauBridge.mq5
```

Defaults:

```text
Host       127.0.0.1
Port       8766
Timeframe  H1
Bars       250
Push       every 2 seconds
```

The EA accepts a broker chart whose symbol contains `XAUUSD` or `GOLD`.

## macOS setup

The MetaTrader 5 App Store build currently installed on this Mac is an iPhoneOS/mobile build. It does not expose the Desktop `MQL5/Experts` + MetaEditor environment used by this bridge.

Use the official MetaTrader 5 Desktop macOS installer from MetaQuotes. That installer creates a Wine-backed Desktop terminal and its standard data root under `~/Library/Application Support/net.metaquotes.wine.metatrader5`.

After the Desktop build has been installed and launched once:

```bash
npm run mt5:setup
```

The setup script searches the standard MetaQuotes Wine/data directories and copies `HearthXauBridge.mq5` into an discovered `MQL5/Experts` directory.

It will not overwrite a different existing file with the same name.

Then complete the MT5-side actions:

1. Open MetaEditor and compile `HearthXauBridge.mq5`.
2. In MetaTrader 5 open **Tools > Options > Expert Advisors**.
3. Add `127.0.0.1` to the terminal's allowed addresses.
4. Open the broker's XAUUSD/Gold chart.
5. Attach **HearthXauBridge** to that chart.
6. Keep Hearth Control running.

The allowed-address entry is an MT5 security setting and cannot be added programmatically by the EA.

## Health check

When Hearth is running:

```text
GET http://127.0.0.1:8765/health
```

Before an EA snapshot arrives, `/v1/bars` returns `503 mt5_no_snapshot`.

If the EA stops sending for longer than the freshness window, it returns `503 mt5_snapshot_stale`.

## Validation completed

Implemented tests cover:

- strict snapshot normalization
- unsupported symbol/timeframe rejection
- malformed OHLC/range rejection
- monotonic timestamp enforcement
- loopback-only binding
- TCP snapshot ingest
- HTTP bars retrieval
- no-snapshot fail-closed behavior
- stale-snapshot fail-closed behavior
- Hearth lifecycle start/stop ownership
- EA source contains socket + CopyRates data path
- EA source contains no trading/account APIs
- packaged release includes `mql5/**/*`

A full integration smoke also completed:

```text
synthetic MT5-format TCP snapshot
 -> Hearth MT5 bridge
 -> Mt5LoopbackAdapter
 -> live Search AI
 -> local Qwen
 -> Invest Engine
 -> UP / confidence / S-R / entry / invalidation / targets
 -> PASS
```

The remaining external dependency is the official Desktop/Wine MetaTrader 5 terminal, logged in to a broker and running the EA against a real XAU/USD/Gold chart. `npm run mt5:setup` currently reports `mt5_mobile_app_only`, which is the expected fail-closed result for the installed App Store build.

No automated trade execution is part of V1.
