---
schema: hearth-skill-v1
id: xau-smc-idm
name: XAU SMC IDM
version: 1
summary: Detect XAUUSD SMC plus inducement setups with higher-timeframe context, M15 setup formation, and M5 entry confirmation without deciding position size or bypassing risk controls.
agents: [invest]
mode: analysis-only
risk: medium
tools: []
---

# XAU SMC + IDM

Use this skill to produce a technical trade proposal for XAUUSD from market bars. The skill owns setup recognition only. It never owns account risk, lot size, broker execution, or permission to trade.

## Timeframe model

Use the minimum multi-timeframe stack:

- H4/H1: market context and directional structure.
- M15: setup detection and zone construction.
- M5: entry confirmation and trigger.

Do not require the complete setup to form on H1. H1 is context, not the default entry trigger.

## Use when

- XAUUSD market bars for the required timeframes are available and fresh;
- a 3-bar swing structure can be established;
- the system is evaluating a possible SMC/IDM continuation or pullback setup;
- the caller needs a deterministic technical proposal before the separate Risk Gate.

## Do not use when

- required bars are stale, missing, malformed, or out of order;
- the request is to choose lot size, account risk, daily-loss policy, leverage, or portfolio exposure;
- the setup needs invented order blocks, FVGs, swings, or liquidity events;
- the task asks the skill to execute an order;
- a higher-level safety or risk gate has rejected the trade.

## Core definitions

### 3-Bar Swing

A candidate Swing High has a center bar whose high is greater than the highs immediately to its left and right.

A candidate Swing Low has a center bar whose low is lower than the lows immediately to its left and right.

Only confirmed 3-bar swings may be used. Do not use the still-forming right bar as a confirmed swing.

### Inducement (IDM)

For a bullish context, IDM is the most recent valid minor Swing Low relevant to the current structure.

For a bearish context, IDM is the most recent valid minor Swing High relevant to the current structure.

IDM is a structure/liquidity reference, not an automatic entry.

### BOS

Bullish BOS requires price to break the relevant confirmed Swing High.

Bearish BOS requires price to break the relevant confirmed Swing Low.

A wick-only touch is not enough when the implementation policy requires a close-confirmed BOS. The runtime must use one explicit policy consistently and report it.

## Bullish workflow

1. Confirm bullish H4/H1 context or a valid bullish structure transition.
2. Identify confirmed Swing High, Swing Low, and relevant IDM.
3. Require a bullish BOS / New High.
4. Wait for price to retrace toward and sweep/take the IDM according to the configured sweep rule.
5. Evaluate the dealing range midpoint.
6. Prefer setup formation in Discount, below the 50% midpoint.
7. Detect relevant Demand / Order Block / FVG confluence on M15.
8. Move the setup to PRE_SIGNAL when structure is valid but the M5 trigger has not occurred.
9. On M5, require the configured confirmation such as micro BOS, rejection/reversal candle, or other explicitly implemented trigger.
10. Emit a BUY technical proposal. Do not size or execute the trade.

## Bearish workflow

Mirror the bullish workflow:

1. Confirm bearish H4/H1 context or valid bearish structure transition.
2. Identify confirmed Swing Low, Swing High, and relevant IDM.
3. Require bearish BOS / New Low.
4. Wait for retracement toward and sweep/take of IDM.
5. Evaluate the dealing range midpoint.
6. Prefer Premium, above the 50% midpoint.
7. Detect Supply / Order Block / FVG confluence on M15.
8. Use PRE_SIGNAL while waiting for the M5 trigger.
9. Require the configured M5 confirmation.
10. Emit a SELL technical proposal without sizing or execution.

## Waiting-time policy

Reduce waiting time by changing the observation structure, not by deleting setup requirements:

- keep H4/H1 for context;
- detect setup on M15;
- trigger on M5;
- preserve PRE_SIGNAL state for near-ready setups;
- evaluate on new-bar/zone/structure events when available instead of asking an AI to reason on every tick;
- run this strategy independently from Harmonic PRZ. Do not require both strategies to agree before a proposal is allowed.

## Proposal output

A proposal should contain at least:

```text
strategy: SMC_IDM
symbol: XAUUSD
direction: BUY | SELL
state: PRE_SIGNAL | READY | INVALID
context_timeframe: H1
setup_timeframe: M15
trigger_timeframe: M5
entry_zone: <deterministic zone or null>
invalidation: <deterministic level or null>
targets: <deterministic levels>
setup_score: <bounded deterministic score if implemented>
evidence:
  - swing structure
  - BOS
  - IDM sweep status
  - premium/discount status
  - OB/FVG or supply/demand confluence
  - M5 trigger status
as_of: <market timestamp>
```

A score is supporting evidence only. It must not override a failed mandatory condition.

## Evidence required

Do not emit READY unless current market evidence supports every mandatory configured condition.

At minimum record:

- exact bars/timestamps used for confirmed swings;
- BOS reference and confirmation policy;
- IDM reference and sweep status;
- dealing-range midpoint and premium/discount classification;
- detected OB/FVG or demand/supply zone evidence;
- M5 trigger evidence;
- entry, invalidation, and target derivation.

## Stop conditions

Return INVALID or insufficient-data instead of guessing when:

- required timeframe data is unavailable or stale;
- swing/BOS/IDM state is ambiguous under the configured deterministic rules;
- the candidate setup becomes structurally invalid before trigger;
- entry or invalidation cannot be derived deterministically;
- another subsystem requests lot sizing or order execution from this skill.

## Safety

This skill is a technical-analysis playbook only. It grants no broker access, order execution, account access, risk-budget authority, network permission, or approval bypass. The separate XAU Risk Gate remains authoritative over whether any technical proposal may proceed.
