# Hearth Invest V2 — XAU/USD Multi-Timeframe Technical + Independent Risk

Status: skill foundation + Shared Swing Core + SMC/IDM + Harmonic PRZ + technical-signal-v1 + Outcome Tracker + Independent Risk Gate + Demo Broker/Account Data Plane + DEMO_AUTO Execution Core + Live V2 Coordinator implemented; explicit user risk configuration and real MT5 demo execution smoke remain operational gates.

## Objective

Evolve the current XAU/USD Invest pipeline without replacing Search AI or the validated V1 market-data path.

The key V2 change is responsibility separation:

```text
Search AI
  -> market evidence / macro / news / sentiment
  -> xau-research-v1

MT5 market data
  -> H4/H1 context
  -> M15 setup
  -> M5 trigger

Technical strategy layer
  +-> SMC/IDM skill/engine
  +-> Harmonic PRZ skill/engine
       |
       +-> technical proposal(s)
             |
             v
        Independent Risk Gate
          APPROVE | RESIZE | REJECT
             |
             v
        Demo Executor Core (implemented; live coordinator pending)
```

Search AI does not issue Buy/Sell. Technical strategies do not decide lot size. Risk does not invent technical signals. The executor does not reinterpret either layer.

## Existing V1 preserved

Keep the current components and contracts unless a V2 slice explicitly migrates them:

- fixed-origin Search AI and xau-research-v1 provenance;
- MT5 loopback market-data bridge;
- current deterministic Invest V1 output;
- OFF / MONITOR / DEMO_AUTO mode controller;
- signal journal;
- `trade_execution_enabled` is false in OFF/MONITOR and becomes true only inside the current ephemeral DEMO_AUTO session; it is never restored after restart.

No live-account execution is authorized by this document.

## V2 skills

Declarative playbooks:

- mcp/skills/definitions/xau-smc-idm/SKILL.md
- mcp/skills/definitions/xau-harmonic-prz/SKILL.md
- mcp/skills/definitions/xau-risk-gate/SKILL.md

These skills are policy/playbook definitions. They do not grant tools or permissions and are inert until an Invest runtime explicitly loads/implements the corresponding rules.

## Timeframe policy

Default V2 observation model:

```text
H4/H1 = Context
M15   = Setup
M5    = Trigger
```

Purpose: reduce waiting time without removing mandatory setup conditions.

Do not solve latency by making every strategy M1-only or by deleting confirmations. Lower timeframes increase noise and must not silently widen risk.

## Strategy independence

SMC/IDM and Harmonic PRZ run independently.

```text
SMC READY -----------+
                     +--> Risk Gate
Harmonic READY ------+
```

Agreement is optional confluence. It is not required for every trade.

This prevents the system from waiting for two unrelated structures to align before every proposal.

## PRE_SIGNAL state

Both technical strategies may emit PRE_SIGNAL when the setup is structurally valid but the final M5 trigger is pending.

PRE_SIGNAL is not executable.

Examples:

- SMC: BOS + IDM reference + valid M15 zone exists, waiting for sweep/trigger.
- Harmonic: valid pattern + PRZ exists or price has entered PRZ, waiting for reversal confirmation.

A PRE_SIGNAL should carry a stable setup id and invalidation condition so the monitor can update the same candidate instead of rediscovering it from scratch.

## Event-driven monitoring target

V1 currently polls the H1 snapshot. V2 should progressively shift technical evaluation toward market events:

- new H1/H4 bar -> refresh context;
- new M15 bar -> refresh setup candidates;
- zone/PRZ touch -> promote/watch candidate;
- new M5 bar -> evaluate trigger;
- structure invalidation -> cancel candidate.

An AI model should not reason on every tick. Deterministic code owns market-structure state.

## Technical signal contract

Implemented in `mcp/market/technical-signal.mjs`:

```text
technical-signal-v1
  id                       stable setup id
  strategy                 SMC_IDM | HARMONIC_PRZ
  symbol                   XAUUSD
  direction                BUY | SELL
  state                    PRE_SIGNAL | READY | INVALID
  context_timeframe        H1
  setup_timeframe          M15
  trigger_timeframe        M5
  entry_zone
  invalidation
  targets
  evidence
  reason_codes
  as_of
  expires_at
```

Identity is structural rather than trigger-based:

- SMC/IDM hashes strategy + direction + BOS reference time + BOS break time + IDM time.
- Harmonic hashes strategy + direction + pattern + X/A/B/C times; D and the M5 trigger do not change the setup id.

This lets PRE_SIGNAL mature into READY without creating a duplicate setup.

Default lifecycle TTLs are explicit and versioned:

- PRE_SIGNAL: 4 hours from `as_of`;
- READY: 30 minutes from `as_of`;
- INVALID: terminal and has no expiry.

The defaults are lifecycle guards, not claims about strategy profitability, and can be revised later with outcome evidence.

The contract rejects unknown top-level fields, malformed numeric execution levels, unsupported timeframes, oversized evidence, and risk/account/execution fields such as balance, equity, lot, margin, or approved volume.

## Outcome tracking

Implemented in `mcp/market/outcome-tracker.mjs`.

Outcome tracking is evidence-only. It does not place trades, choose position size, or feed an LLM self-generated performance claims.

The tracker accepts only a `READY` `technical-signal-v1` and post-signal OHLC bars.

Initial deterministic evaluation policy:

```text
entry reference   = midpoint of entry_zone
entry eligibility = midpoint must be touched after signal.as_of
                    and no later than signal.expires_at

WIN      = TP1 reached before invalidation
LOSS     = invalidation reached before TP1
NEUTRAL  = no entry before signal expiry,
           no TP/SL before the evaluation horizon,
           or OHLC ordering is ambiguous
TRACKING = insufficient future bars to resolve yet
```

The signal bar itself is never used for a retroactive fill.

If entry and an exit boundary occur on the same OHLC bar, or TP1 and invalidation both occur on one later bar, the result is `NEUTRAL` because bar data cannot establish intrabar ordering without lower-timeframe/tick evidence.

Default post-entry evaluation horizon is 24 hours. This is an explicit V1 measurement policy, not a claim that 24 hours is optimal.

R-based evidence:

- initial risk distance = absolute midpoint-entry to invalidation distance;
- WIN realized R = TP1 distance / initial risk distance;
- LOSS = -1R;
- NEUTRAL = 0R;
- MAE/MFE are measured in R from bars after the entry bar, avoiding unsupported intrabar ordering assumptions.

Aggregate evidence is available overall and per strategy:

- Win / Loss / Neutral counts;
- win rate, using only WIN + LOSS in the denominator;
- cumulative R;
- gross positive / negative R;
- R-based profit factor;
- peak-to-trough maximum drawdown in cumulative R;
- average MAE / MFE.

Profit factor is null when no losses exist rather than representing infinity in JSON.
## Risk decision contract

Implemented in `mcp/market/risk-gate.mjs`:

```text
xau-risk-decision-v1
  id
  proposal_id
  strategy
  symbol                   XAUUSD
  decision                 APPROVE | RESIZE | REJECT
  approved_risk_fraction
  approved_volume
  reason_codes
  checks
  sizing
  as_of
```

The gate accepts only a valid `READY` technical-signal-v1 plus explicit DEMO mode state, demo account state, broker metadata, and risk configuration.

Risk inputs are fail-closed. Missing or invalid broker contract metadata is never replaced with assumed XAUUSD values.

Required broker sizing inputs currently include:

- point size;
- tick size;
- tick value per lot;
- broker min/max/step volume;
- margin per lot;
- bid/ask;
- estimated slippage;
- fresh broker timestamp.

The original V1 MT5 EA remains market-only. The additive V2 telemetry path now provides the broker/account fields required by the Risk Gate, while the V3 demo-only EA adds the execution command/receipt channel.

Position sizing is deterministic:

```text
entry                = midpoint(entry_zone)
stop_distance        = abs(entry - invalidation)
loss_per_lot         = (stop_distance / tick_size) * tick_value_per_lot

per_trade_budget     = equity * risk_fraction_per_trade
remaining_open_risk  = equity * max_total_open_risk_fraction - open_risk_currency
risk_budget          = min(per_trade_budget, remaining_open_risk)

risk_limited_volume  = risk_budget / loss_per_lot
margin_limited_volume = free_margin / margin_per_lot

approved ceiling     = broker-step floor(
                         min(risk_limited_volume,
                             margin_limited_volume,
                             broker volume max)
                       )
```

If a requested volume is above the approved ceiling, Risk returns `RESIZE`. Hard safety failures return `REJECT`.

Risk does not rewrite strategy direction, entry, stop, targets, BOS, IDM, PRZ, or pattern evidence. It also does not send orders.

## Risk authority

The Risk Gate has veto authority over every strategy.

Technical engines may never:

- set final broker volume;
- bypass daily-loss or drawdown limits;
- override margin/spread/cooldown checks;
- force execution because confidence is high.

A high technical score is not permission to exceed risk policy.

## Rollout sequence

### Slice 1 — Skill foundation
- add the three SKILL.md definitions;
- document boundaries and contracts;
- no runtime behavior change.

### Slice 2 — Shared Swing Core ✅
- implemented in mcp/market/swing-core.mjs;
- strict confirmed 3-bar Swing High / Swing Low rules;
- confirmation records the right-hand bar so no still-forming pivot is treated as confirmed;
- equal-high/equal-low ties do not invent pivots;
- malformed ranges and non-monotonic timestamps fail closed;
- reusable by SMC and Harmonic;
- dedicated deterministic regression coverage in scripts/test-market-swing-core.mjs.

### Slice 3 — SMC/IDM engine ✅
- implemented in mcp/market/smc-idm-engine.mjs;
- H1 context requires confirmed higher-high/higher-low or lower-high/lower-low structure;
- M15 BOS is close-confirmed; wick-only structure breaks do not count;
- IDM uses the latest relevant confirmed opposite swing before BOS;
- post-BOS close through IDM invalidates the setup, while a wick sweep plus reclaim may continue;
- premium/discount uses a deterministic dealing-range midpoint;
- Order Block and 3-bar FVG zones are deterministic; overlapping OB/FVG is retained as confluence;
- PRE_SIGNAL is emitted while IDM sweep, zone touch, or M5 micro-BOS is still pending;
- READY requires valid context + M15 BOS/IDM/zone + sweep + zone touch + close-confirmed M5 micro-BOS;
- output is technical-only: no balance, equity, lot size, margin, account state, or broker execution fields;
- bullish and bearish paths plus malformed-data behavior have dedicated regression tests in scripts/test-market-smc-idm.mjs.

### Slice 4 — Harmonic PRZ engine ✅
- implemented in mcp/market/harmonic-prz-engine.mjs using the shared 3-bar Swing Core;
- alternating ZigZag collapses repeated same-side pivots to the more extreme confirmed swing and skips ambiguous dual pivots on one bar;
- initial deterministic pattern set: Gartley and Bat with explicit AB/XA, BC/AB, AD/XA, CD/BC, and CD/AB ranges;
- PRZ is the intersection of three independent projected intervals: XA retracement, BC extension, and AB-CD projection;
- XABC alone can emit PRE_SIGNAL with a projected PRZ while waiting for a confirmed D;
- READY requires a confirmed D inside the PRZ, full ratio validation, structural validity, and close-confirmed M5 micro-BOS;
- a close through X after D invalidates the setup;
- invalidation uses a bounded XA structural buffer and targets use deterministic AD 38.2% / 61.8% retracements;
- output remains technical-only with no account, position-size, margin, or broker execution authority;
- bullish/bearish Gartley, projected Bat, invalidation, malformed data, and no-execution boundaries are covered in scripts/test-market-harmonic-prz.mjs.

### Slice 5 — Technical proposal contract ✅
- implemented in mcp/market/technical-signal.mjs;
- normalizes SMC/IDM and Harmonic PRZ into strict technical-signal-v1;
- stable structural setup IDs survive PRE_SIGNAL -> READY transitions;
- exact repeat ingestion is idempotent and does not create duplicates;
- PRE_SIGNAL -> READY -> INVALID is monotonic; READY cannot regress to PRE_SIGNAL and INVALID is terminal;
- stale updates fail closed;
- PRE_SIGNAL expires after 4 hours by default and READY after 30 minutes; expiry deterministically converts the same setup id to INVALID with signal_expired;
- invalid engine output without a real setup identity is not admitted as a technical signal;
- the contract rejects risk/account/execution contamination and unknown top-level fields;
- dedicated contract/lifecycle regression coverage lives in scripts/test-market-technical-signal.mjs.

### Slice 6 — Outcome tracker ✅
- implemented in mcp/market/outcome-tracker.mjs;
- accepts READY technical-signal-v1 only;
- deterministic midpoint-entry model with no retroactive fill on the signal bar;
- WIN / LOSS / NEUTRAL outcomes plus TRACKING while future evidence is incomplete;
- same-bar entry/exit or stop/target ambiguity resolves NEUTRAL rather than guessing tick order;
- signal expiry resolves unfilled candidates to NEUTRAL;
- default post-entry measurement horizon is 24 hours;
- realized R, MAE, and MFE are computed without account currency or lot-size assumptions;
- TechnicalOutcomeBook provides idempotent TRACKING -> RESOLVED lifecycle with resolved outcomes terminal;
- summary metrics report overall and per-strategy win rate, cumulative R, profit factor, max drawdown, average MAE, and average MFE;
- no LLM scoring, account state, broker execution, or risk-sizing authority is introduced;
- dedicated outcome/lifecycle/metric regression coverage lives in scripts/test-market-outcome-tracker.mjs.

### Slice 7 — Independent Risk Gate ✅
- implemented in mcp/market/risk-gate.mjs;
- consumes READY technical-signal-v1 without changing its technical content;
- accepts DEMO accounts only and requires DEMO_AUTO to be explicitly enabled for the current runtime session;
- the Risk Gate requires the current session-scoped DEMO_AUTO execution latch and copies that `demo_session_id` into APPROVE/RESIZE decisions;
- returns APPROVE / RESIZE / REJECT with explicit check states and reason codes;
- veto checks cover signal/state freshness, demo mode, account type, broker/account data freshness, stop bounds, spread, estimated slippage, daily loss, drawdown, position count, total open risk, margin, cooldown, and circuit breaker;
- position sizing is deterministic from equity, configured risk fraction, technical stop distance, validated tick size/value, broker volume constraints, remaining portfolio risk, and margin ceiling;
- requested size above the allowed ceiling is RESIZE rather than silently accepted;
- live accounts, missing broker sizing metadata, stale state, unavailable mandatory inputs, and reached safety limits fail closed to REJECT;
- no LLM selects lot size and no order execution API is present;
- the original HearthXauBridge.mq5 remains market-only; the additive HearthXauBridgeV2.mq5 + /v1/risk-state path now provides validated read-only demo broker/account telemetry for the Risk Gate;
- dedicated risk-gate regression coverage lives in scripts/test-market-risk-gate.mjs.

### Slice 7.5 — Demo Broker/Account Data Plane ✅
- implemented as an additive read-only path; the original HearthXauBridge.mq5 is unchanged and remains market-only;
- new mql5/HearthXauBridgeV2.mq5 sends both canonical market snapshots and risk_snapshot v1 over the existing loopback TCP ingest;
- no account login, account name, account server, or account number is transmitted;
- no OrderSend/CTrade/position mutation path is present; OrderCalcMargin is used only to obtain a deterministic margin-per-lot estimate;
- telemetry includes demo/live account type, currency, equity, locally observed daily peak equity, free margin, daily realized loss, total open-position count, and computed open risk;
- open risk is fail-closed: if any open position lacks SL or required tick metadata, open_risk_complete=false and the MT5 risk adapter refuses the snapshot;
- broker metadata includes bid/ask, point size, tick size, tick value per lot, min/max/step volume, margin per lot, and explicitly configured estimated slippage points;
- daily peak equity is stored in an MT5 terminal GlobalVariable keyed by date so EA restarts during the same day retain the observed peak; it is an observed runtime peak, not a claim of complete historical equity reconstruction;
- bridge endpoint GET /v1/risk-state?symbol=XAUUSD is loopback-only, bounded, freshness-checked, and independent from /v1/bars;
- mcp/market/mt5-risk-adapter.mjs re-validates the loopback payload before exposing account/broker telemetry;
- cooldown and circuit-breaker booleans remain Hearth runtime policy inputs; the Risk Gate now requires them explicitly rather than defaulting missing values to false;
- synthetic E2E validation proves TCP risk telemetry -> loopback adapter -> Independent Risk Gate without any executor;
- scripts/setup-mt5-bridge.mjs installs V1, read-only V2, and demo-only V3 EA sources without overwriting conflicts;
- real broker validation still requires the official Desktop/Wine MT5 installation and MetaEditor compile/attach steps.

### Slice 8A — DEMO_AUTO Execution Core ✅
- implemented in `mcp/market/demo-auto-executor.mjs` with a persistent atomic `demo-execution-journal-v1`;
- `DEMO_AUTO` now receives an ephemeral `demo_session_id`; the session is never persisted and restart still restores only OFF/MONITOR;
- `trade_execution_enabled` is true only while that current runtime DEMO_AUTO session is active;
- every execution request must bind the same READY `technical-signal-v1`, an `APPROVE` or `RESIZE` `xau-risk-decision-v1`, and the same current `demo_session_id`;
- Risk checks must all be `pass`; REJECT decisions, stale decisions, stale broker state, expired signals, session mismatch, and prices outside the technical entry zone fail closed;
- executor never increases or derives volume; it uses exactly `approved_volume` from Risk;
- the demo execution core uses market orders only, TP1 only, and requires current ask/bid to remain inside the entry zone before dispatch;
- stable `exec:v1:*` request IDs and `HRT8_*` broker comments make retries idempotent;
- journal state is written before the broker side effect and records PREPARED / SENT / FILLED / REJECTED / DUPLICATE / UNCERTAIN;
- transport failure after SENT is recorded as UNCERTAIN; retry reuses the same request ID so the EA can prove duplicate execution instead of opening another position;
- `mql5/HearthXauDemoExecutorV3.mq5` checks `ACCOUNT_TRADE_MODE_DEMO` immediately before OrderCheck/OrderSend, validates command expiry, price deviation, volume step, stop distance, and broker trading permission;
- V3 searches open positions and deal history for the stable request tag before sending, so process/receipt retry cannot silently double-submit the same request;
- the Hearth bridge exposes execution only as an in-process method; HTTP remains GET/read-only and has no order submission route;
- broker receipts are matched to the exact request and must report demo account type before the journal accepts FILLED/DUPLICATE;
- KILL SWITCH disables the current execution session and blocks new orders; it deliberately does not auto-close already-open positions;
- synthetic end-to-end validation covers READY signal -> Risk Gate -> session-bound executor -> MT5 command -> FILLED receipt.

### Slice 8B — Live V2 Coordinator ✅
- implemented in `mcp/market/live-v2-coordinator.mjs`;
- the legacy V1 H1 analysis journal remains informational and has no route to the executor;
- V2 reads H1, M15, and M5 independently and removes the currently-forming bar from every timeframe before analysis;
- a cycle runs only when the latest confirmed M5 bar changes, preventing repeated evaluation of the same close;
- SMC/IDM and Harmonic remain independent engines and are shown separately as INVALID / PRE_SIGNAL / READY;
- only a normalized `READY technical-signal-v1` can proceed toward Risk;
- if both strategies become READY on the same cycle, execution fails closed with `multiple_ready_setups` rather than inventing a priority;
- `mcp/market/demo-risk-config.mjs` persists explicit user-owned demo risk rules; no hidden defaults are created;
- missing or invalid risk configuration blocks execution while technical monitoring continues;
- fresh MT5 account/broker telemetry is fetched immediately before deterministic Risk evaluation;
- Risk APPROVE/RESIZE is required before the session-bound demo executor is called;
- any proposal already present in the persistent execution journal is not submitted again;
- an uncertain executor failure trips an in-memory coordinator circuit breaker and blocks further automatic submissions;
- V3 EA now streams fixed H1/M15/M5 snapshots over the existing loopback socket while preserving the demo-only order boundary;
- MetaEditor compile of the updated V3 source passes 0 errors / 0 warnings;
- the remaining operational gate is a real broker DEMO smoke after the updated EA is reloaded and explicit demo risk rules are saved.

Live-account automation is a separate future decision and is not implied by DEMO_AUTO.

## Demo execution contract

`mcp/market/demo-auto-executor.mjs` prepares a bounded `demo-execution-v1` command:

```text
request_id              stable within one Risk decision + demo session
request_tag             short HRT8_* broker comment for dedupe evidence
risk_decision_id
proposal_id
demo_session_id
strategy
canonical_symbol        XAUUSD
side                    BUY | SELL
volume                  exactly Risk-approved volume
reference_price         current ask for BUY / bid for SELL
stop_loss
take_profit             TP1
max_deviation_points    copied from the Risk decision boundary
created_at
expires_at / expires_epoch
```

The V3 EA returns `execution_receipt v1` with `FILLED`, `REJECTED`, or `DUPLICATE`, plus retcode/ticket/fill evidence. A receipt that says live account is rejected by Hearth even if all local checks previously passed.

No renderer IPC or HTTP endpoint can submit an order. The only execution transport is the in-process bridge object owned by Hearth main.
## V1 closed-bar journal policy

The legacy V1 analysis monitor is informational only and now evaluates each confirmed H1 bar at most once.

- the bridge health status exposes both the newest received bar and the newest confirmed/closed bar;
- V1 deduplication keys use the closed H1 timestamp, not the EA snapshot push timestamp;
- V1 investment analysis removes the currently-forming H1 candle before the deterministic engine runs;
- repeated EA pushes inside the same H1 candle do not create new analysis entries;
- the Invest page shows only the newest V1 analysis card by default, with older saved entries available behind the History control.

This prevents several near-identical V1 cards from appearing during one H1 candle and keeps V1 visually separate from V2 setup/execution state.

## Live V2 coordinator policy

The coordinator is intentionally separate from the legacy V1 analysis monitor.

```text
V1:
H1 -> Search/Invest narrative -> local analysis journal
                               -> never execution

V2:
confirmed H1 context
 + confirmed M15 setup
 + confirmed M5 trigger
 -> SMC/IDM + Harmonic
 -> technical-signal-v1
 -> explicit demo Risk policy
 -> APPROVE / RESIZE
 -> DEMO_AUTO executor
```

The current forming H1/M15/M5 candle is excluded before either technical engine runs. This prevents close-confirmation rules from acting on an unfinished bar.

Risk configuration is stored separately as `demo-risk-config-v1`. Until the user explicitly saves every required risk boundary, DEMO_AUTO may be armed but the coordinator returns `risk_config_required` and does not submit an order.

The UI now separates:

- V1 Analysis — informational only;
- V2 Technical Setups — SMC/IDM and Harmonic states;
- Demo Risk Rules — explicit user-owned limits;
- Risk Decision — APPROVE / RESIZE / REJECT;
- Execution Journal — broker command/receipt evidence.

## Success criteria

V2 foundation is correct when:

- Search remains evidence-only;
- SMC and Harmonic can run independently;
- H1 is context rather than the only trigger timeframe;
- PRE_SIGNAL cannot execute;
- Risk is separate and has veto authority;
- no LLM chooses final position size;
- current V1 analysis behavior remains available; V2 execution is isolated behind the explicit session-scoped demo executor rather than reusing V1 signals;
- no live execution path appears accidentally.