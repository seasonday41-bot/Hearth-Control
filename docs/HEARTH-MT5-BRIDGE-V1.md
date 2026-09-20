# Hearth MT5 Bridge V1 — XAU/USD

Status: V1 market-only bridge remains implemented; an additive V2 read-only demo risk telemetry path is also implemented. The Mac currently has the App Store/iPhoneOS MT5 build, but the Desktop/Wine build required for MQL5 Expert Advisors is not installed yet.

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

The original V1 EA is market-data only. The shared Hearth loopback server now also accepts an optional V2 read-only risk telemetry snapshot from HearthXauBridgeV2.mq5. Neither path can place, modify, or close orders.

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

## V2 read-only demo risk telemetry

Additive source:

```text
mql5/HearthXauBridgeV2.mq5
```

The V2 EA keeps the same loopback TCP connection and sends two independent payloads:

```text
snapshot v1       -> OHLC/tick-volume bars
risk_snapshot v1  -> bounded account/broker risk telemetry
```

Hearth exposes the risk snapshot locally at:

```text
GET http://127.0.0.1:8765/v1/risk-state?symbol=XAUUSD
```

The risk payload intentionally excludes account login, account name, account server, credentials, and any order command. It includes only fields required for deterministic demo risk checks: equity, observed daily peak equity, free margin, daily realized loss, open-position count/open risk, bid/ask, tick/point values, broker volume limits/step, margin-per-lot, and configured slippage estimate.

If any open position lacks a stop loss or required tick metadata, the EA marks open risk incomplete and the Hearth adapter refuses to pass the snapshot to the Risk Gate.

The V2 EA uses `OrderCalcMargin()` for read-only margin estimation only. It contains no `OrderSend`, `CTrade`, position open/close, or position modification path.

The original `HearthXauBridge.mq5` remains available for strict market-only V1 behavior.

## V3 demo-only execution channel

Execution source:

```text
mql5/HearthXauDemoExecutorV3.mq5
```

V3 is additive. V1 remains market-only and V2 remains read-only market + risk telemetry.

V3 uses the same loopback TCP connection for:

```text
EA -> Hearth : snapshot / risk_snapshot / executor_hello / execution_receipt
Hearth -> EA : demo_order
```

The command path is **not** exposed through HTTP. `/v1/bars`, `/v1/risk-state`, and `/health` remain read-only GET endpoints; all non-GET HTTP requests are rejected.

Before every `OrderSend`, V3:

- requires `ACCOUNT_TRADE_MODE_DEMO`;
- rejects expired commands;
- requires the XAUUSD canonical identity and BUY/SELL side;
- validates broker min/max/step volume without rounding upward;
- verifies price has not moved beyond the Risk-approved deviation budget;
- validates broker minimum stop distance and SL/TP direction;
- requires terminal/MQL trading permission;
- calls `OrderCheck()` before `OrderSend()`;
- searches open positions and deal history for the stable `HRT8_*` request tag to prevent duplicate retry execution.

V3 accepts only market DEAL requests in this first execution slice. Pending orders, live accounts, remote HTTP order submission, and automatic position closing are out of scope.
## macOS setup

The MetaTrader 5 App Store build currently installed on this Mac is an iPhoneOS/mobile build. It does not expose the Desktop `MQL5/Experts` + MetaEditor environment used by this bridge.

Use the official MetaTrader 5 Desktop macOS installer from MetaQuotes. That installer creates a Wine-backed Desktop terminal and its standard data root under `~/Library/Application Support/net.metaquotes.wine.metatrader5`.

After the Desktop build has been installed and launched once:

```bash
npm run mt5:setup
```

The setup script searches the standard MetaQuotes Wine/data directories and installs `HearthXauBridge.mq5`, `HearthXauBridgeV2.mq5`, and `HearthXauDemoExecutorV3.mq5` into each discovered `MQL5/Experts` directory without overwriting a different existing file.

It will not overwrite a different existing file with the same name.

Then complete the MT5-side actions:

1. Open MetaEditor and compile `HearthXauDemoExecutorV3.mq5` for DEMO_AUTO execution, `HearthXauBridgeV2.mq5` for read-only V2 telemetry, or `HearthXauBridge.mq5` for V1 market data.
2. In MetaTrader 5 open **Tools > Options > Expert Advisors**.
3. Add `127.0.0.1` to the terminal's allowed addresses.
4. Open the broker's XAUUSD/Gold chart.
5. Attach exactly one **HearthXauDemoExecutorV3** for demo execution. Use **HearthXauBridgeV2** instead when you want read-only V2 telemetry, or **HearthXauBridge** for market-only V1.
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
