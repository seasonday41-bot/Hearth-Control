# Hearth Market Specialists V1 — XAU/USD First

Status: implemented and validated on feature branch
Branch: `feature/market-specialists-v1`
Scope: Search AI + Invest AI before any Investment App work.

## Objective

Two specialized market roles run behind the existing Hearth control plane:

```text
hearth-job-v1
  |
  +-- market_search
  |     -> Browser permission
  |     -> fixed-origin live sources
  |     -> Search AI
  |     -> xau-research-v1
  |
  +-- investment_analysis
        -> Browser permission
        -> Search AI
        -> MT5 loopback market bars
        -> deterministic Invest engine
        -> bounded Invest AI explanation
        -> xau-invest-result-v1
```

No new queue, executor, JobManager, or task database is introduced. Market jobs reuse the existing P8 universal ingress and existing TaskStore.

XAU/USD is the only supported asset in V1.

## Original 10 Invest capabilities

The original capability set is preserved as stable IDs:

1. `market_analysis`
2. `technical_analysis`
3. `risk_management`
4. `portfolio_diversification`
5. `economic_indicators`
6. `value_investing`
7. `earnings_reports`
8. `market_sentiment`
9. `growth_vs_dividend`
10. `global_events`

For spot XAU/USD:

- core: market_analysis, technical_analysis, risk_management, economic_indicators, market_sentiment, global_events
- contextual: portfolio_diversification
- not applicable: value_investing, earnings_reports, growth_vs_dividend

The system must not fabricate equity-only evidence for spot gold.

## Search AI V1

Search AI owns FIND + VERIFY + SOURCE. It does not issue Buy/Sell/Hold output.

Research themes:

- XAU/USD / gold market drivers
- Federal Reserve policy and rate path
- US inflation and labor evidence
- DXY / Treasury-yield context when available
- gold-market sentiment / positioning when available
- geopolitical / global-risk context when available

### Live source boundary

Current fixed origins:

```text
https://api.gdeltproject.org
https://www.federalreserve.gov
https://www.bls.gov
```

Implemented feeds:

- GDELT DOC API for broad news discovery
- Federal Reserve monetary-policy RSS
- BLS latest-numbers RSS

The provider never accepts a caller-supplied origin. Redirects are rejected. Responses are size/time bounded.

GDELT may rate-limit requests. Search therefore batches broad discovery into one request and falls back to Federal Reserve/BLS official feeds. If no usable evidence remains, Search fails closed instead of asking the model to guess.

### Provenance

`xau-research-v1` preserves:

- source URL
- title / publisher
- publication timestamp
- retrieval timestamp
- source type / credibility class
- fact vs claim vs interpretation
- bias / impact / horizon
- source_ids on every research item

The live default uses a lean classifier:

```text
Hearth
  -> owns URL/title/publisher/timestamps
  -> assigns capability from the search topic

Local Qwen
  -> summary
  -> fact_type
  -> bias
  -> impact
  -> horizon
```

The model cannot create or replace source URLs/capabilities in the final contract.

## Local Search model

Validated local Ollama runtime on this machine exposes:

```text
qwen3.5:9b-hermes
qwen3.5:9b
qwen3:8b
```

Market Search defaults to the existing local Ollama provider and uses a bounded fast JSON-classification turn.

A live end-to-end Search smoke completed successfully:

```text
live Fed/BLS evidence
 -> local Qwen classifier
 -> xau-research-v1
 -> PASS
```

## MT5 V1 adapter

Invest AI market data is supplied by a loopback-only adapter:

```text
http://127.0.0.1:8765/v1/bars
  ?symbol=XAUUSD
  &timeframe=H1
  &limit=...
```

Rules:

- loopback HTTP only
- no arbitrary remote broker URL
- symbol fixed to XAUUSD
- allowed timeframes: M1, M5, M15, M30, H1, H4, D1
- strict OHLC/range/time/volume validation
- bounded bar count / response size / timeout
- transport failure normalizes to `mt5_unavailable`

The adapter is implemented and unit-tested. Hearth now also owns a loopback MT5 bridge:

```text
MetaTrader 5 + HearthXauBridge.mq5
  -> TCP 127.0.0.1:8766
  -> Hearth bridge
  -> HTTP 127.0.0.1:8765
  -> Mt5LoopbackAdapter
  -> Invest AI
```

The bridge starts with Hearth Control and stops with Hearth. It is read-only and contains no trade/account API path.

The Mac currently has the App Store/iPhoneOS MetaTrader 5 build installed at `/Applications/MetaTrader 5.app`. That build can display/trade markets but does not provide the Desktop/Wine `MQL5/Experts` + MetaEditor environment required by this bridge.

The repo includes `mql5/HearthXauBridge.mq5` plus `npm run mt5:setup`. The setup command now detects this mobile-only state as `mt5_mobile_app_only` and refuses to pretend the EA was installed. The remaining external dependency is the official MetaTrader 5 Desktop macOS/Wine build from MetaQuotes, launched once so its Wine data directory exists.

V1 Hearth routing currently uses H1 as the default Invest timeframe. See `docs/HEARTH-MT5-BRIDGE-V1.md` for setup and security details.

## Invest AI V1

The deterministic core consumes:

```text
xau-research-v1
+
validated MT5-style XAUUSD bars
```

It computes:

- SMA20 / SMA50 / SMA200 when history is sufficient
- RSI14
- ATR14
- recent support / resistance
- short momentum
- technical bias
- evidence-weighted research bias
- UP / DOWN / NEUTRAL
- confidence
- entry zone
- invalidation
- targets
- risk level

Current composite weighting:

```text
technical = 60%
evidence  = 40%
```

The AI narrative is separate from the deterministic result. It may explain bull/base/bear scenarios and risks, but its JSON contract cannot contain numeric override fields such as direction, confidence, support, resistance, entry, invalidation, or targets.

Qwen narrative robustness:

- a string `risks` value is normalized to a one-item list
- missing, null, oversized, empty, or non-text risk entries are safely omitted
- at most 20 valid risk strings are retained
- malformed `risks` cannot discard an otherwise valid deterministic analysis
- unknown narrative fields still fail closed, so AI output cannot inject direction, confidence, numeric levels, or any other override

## Invest Mode Controller foundation

Hearth now owns three explicit Invest modes:

```text
OFF       -> no automatic analysis; no trade execution
MONITOR   -> automatic-analysis intent; no trade execution
DEMO_AUTO -> current-session demo-auto intent; trade executor is not implemented yet
```

Startup safety is enforced in the controller and its persisted document:

- a fresh install starts in `OFF`
- `OFF` and `MONITOR` are safe restart modes and may be persisted
- `DEMO_AUTO` is runtime-only and is never written as a restart mode
- if `DEMO_AUTO` is selected after `MONITOR`, a restart returns to `MONITOR`
- if `DEMO_AUTO` is selected after `OFF`, a restart returns to `OFF`
- a corrupt, unknown, or manually persisted `DEMO_AUTO` startup value fails closed to `OFF`
- the kill switch changes the current and restart modes to `OFF`

The controller is initialized by Electron from `invest-mode.json` and exposes bounded local get/set/kill-switch IPC calls for a future control surface. This slice does not add the analysis loop, signal journal, risk gate, order APIs, or real/demo trade execution. Controller state therefore reports `trade_execution_enabled: false` in every mode.

## Hearth Router integration

`hearth-job-v1` semantic kinds now include:

```text
code_change         -> X
code_inspect        -> X
general             -> Antigravity
market_search       -> Market/Search
investment_analysis -> Market/Invest
```

Callers still cannot supply a worker, agent, provider, workspace root, or repair budget.

Market execution:

- uses existing Browser permission
- `Blocked` fails before network access
- `Ask` uses existing local approval lifecycle
- disconnect before commit aborts uncommitted work
- reuses existing TaskStore for status/result persistence
- same job ID + same fingerprint is idempotent
- changed payload/cross-route collision fails closed

Codex remains outside fresh-job routing.

## Validation

Final focused regression:

```text
Market specialists tests = 62/62 PASS
P8 router tests          = 24/24 PASS
focused total            = 86/86 PASS
failures                 = 0

Live Search smoke
  fixed-origin sources -> local Qwen -> xau-research-v1 = PASS

MT5 bridge smoke
  MT5-format TCP snapshot
  -> Hearth bridge
  -> Mt5LoopbackAdapter
  -> live Search AI
  -> Invest Engine
  = PASS

Local Ollama health
  available = PASS

MT5 terminal discovery
  App Store/iPhoneOS build detected = PASS
  Desktop/Wine MQL5 data folder     = NOT PRESENT
  setup result                      = mt5_mobile_app_only

MQL5 source checks       = PASS
electron/main.cjs syntax = PASS
package.json parse       = PASS
git diff --check         = PASS
production build         = PASS
TypeScript               = PASS
Vite                     = PASS
```

The EA protocol/source invariants are covered by automated tests and the same payload shape passed the production bridge integration smoke. Installed terminal, broker connection, compiled EA, and current chart attachment remain external runtime state and must be revalidated before any later live-broker claim.

The pre-existing dirty `electron/build-meta.json` was backed up before validation build and restored afterward. This Market V1 work does not intentionally own that file.

## Remaining work before the Investment App

1. Add the MONITOR auto-analysis loop with a fixed cadence and same-bar deduplication.
2. Add the Signal Journal for UP / DOWN / NEUTRAL outcomes before measuring win rate or profit factor.
3. Add the visible OFF / MONITOR / DEMO AUTO controls and kill switch, consuming the existing bounded controller IPC.
4. Design the demo-only risk gate and executor separately; require confidence threshold, stop loss, position cap, daily loss limit, and explicit current-session enablement. Do not add live-account execution.
5. Revalidate the installed MT5 Desktop terminal, compiled EA, broker connection, and current XAUUSD chart attachment before any later live smoke.
6. Freeze/commit the Market Specialists checkpoint only when authorized.
7. Build the Investment App as a consumer of these contracts after the backend contracts and journal are stable.

The software path from MT5-format TCP snapshot through live Search AI and the Invest engine has already passed an end-to-end smoke using the production bridge protocol.

No commit, push, deploy, or Investment App work is part of this checkpoint.
