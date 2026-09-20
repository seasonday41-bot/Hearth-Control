---
schema: hearth-skill-v1
id: xau-harmonic-prz
name: XAU Harmonic PRZ
version: 1
summary: Detect XAUUSD harmonic potential reversal zones with deterministic Fibonacci confluence and lower-timeframe confirmation before emitting a technical proposal.
agents: [invest]
mode: analysis-only
risk: medium
tools: []
---

# XAU Harmonic PRZ

Use this skill to detect and validate Harmonic reversal opportunities for XAUUSD. The skill owns pattern geometry, PRZ construction, and technical confirmation only. It does not own account risk, lot sizing, or execution.

## Timeframe model

Use:

- H4/H1: directional context and major swing environment;
- M15: harmonic pattern / PRZ construction;
- M5: reversal confirmation and entry trigger.

The pattern may be detected on M15 while H1 supplies context. Do not force the complete entry sequence to wait for an H1 close when a valid lower-timeframe trigger is configured.

## Use when

- sufficient fresh XAUUSD swing data is available;
- a deterministic X-A-B-C-D candidate can be constructed;
- Fibonacci ratios and PRZ confluence can be computed from actual swing prices;
- the caller needs a technical reversal proposal before the separate Risk Gate.

## Do not use when

- swing pivots or Fibonacci anchors are ambiguous under the configured rules;
- ratios must be guessed or rounded so aggressively that multiple incompatible patterns become equivalent;
- price has not reached a valid PRZ;
- the request is for lot size, account risk, leverage, or direct order execution;
- a higher-level safety/risk gate has rejected the trade.

## PRZ construction

Initial engine support is intentionally bounded to **Gartley** and **Bat**. Additional harmonic families require separate ratio definitions and tests rather than being inferred dynamically.

Build the Potential Reversal Zone only from deterministic confluence. The supported implementation may use:

- Fibonacci retracement of XA;
- Fibonacci extension/projection of BC;
- AB = CD projection;
- pattern-specific ratio tolerances explicitly configured in code.

Do not emit a valid PRZ from a single arbitrary Fibonacci level.

## Bullish workflow

1. Confirm or construct a bullish harmonic X-A-B-C-D candidate from confirmed swings.
2. Validate the configured ratio rules for the selected pattern.
3. Compute the PRZ from overlapping Fibonacci projections.
4. Wait for price to enter the PRZ.
5. Move the candidate to PRE_SIGNAL while waiting for lower-timeframe confirmation.
6. On M5, require the configured reversal evidence, such as:
   - bullish reversal candle;
   - bullish divergence when available and explicitly implemented;
   - micro structure reversal / micro BOS.
7. Derive a deterministic invalidation behind the structural extreme / configured D-X boundary with the configured ATR or Fibonacci buffer.
8. Derive targets from the configured retracement framework, such as AD retracement levels.
9. Emit a BUY technical proposal without sizing or execution.

## Bearish workflow

Mirror the bullish workflow:

1. Construct bearish X-A-B-C-D.
2. Validate pattern ratios.
3. Compute overlapping PRZ.
4. Wait for price to enter PRZ.
5. Use PRE_SIGNAL while waiting for M5 confirmation.
6. Require bearish reversal evidence.
7. Derive invalidation beyond the structural extreme with the configured buffer.
8. Derive deterministic retracement targets.
9. Emit a SELL technical proposal without sizing or execution.

## Waiting-time policy

Do not reduce waiting time by removing the PRZ or confirmation requirements. Reduce latency structurally:

- use H4/H1 for context;
- build the pattern/PRZ on M15;
- confirm on M5;
- keep PRE_SIGNAL state once price approaches or enters PRZ;
- evaluate on new-bar / PRZ-touch / trigger events when available;
- run independently from SMC/IDM. Agreement between both strategies is optional confluence, not a mandatory prerequisite.

## Proposal output

A proposal should contain at least:

```text
strategy: HARMONIC_PRZ
symbol: XAUUSD
direction: BUY | SELL
state: PRE_SIGNAL | READY | INVALID
pattern: <implemented harmonic pattern id>
context_timeframe: H1
setup_timeframe: M15
trigger_timeframe: M5
prz: <lower, upper>
entry_zone: <deterministic zone or null>
invalidation: <deterministic level or null>
targets: <deterministic levels>
ratio_evidence: <actual measured ratios>
trigger_evidence: <M5 confirmation>
as_of: <market timestamp>
```

## Evidence required

Do not emit READY unless current evidence contains:

- confirmed swing anchors X, A, B, C, D;
- actual measured pattern ratios;
- PRZ boundaries and the components that created the confluence;
- proof price entered/touched the configured PRZ condition;
- M5 reversal/structure confirmation;
- deterministic invalidation and target derivation.

## Stop conditions

Return INVALID or insufficient-data rather than guessing when:

- required swing points are not confirmed;
- no configured harmonic pattern fits within tolerance;
- the PRZ is not a real confluence;
- confirmation has not occurred;
- the setup has already invalidated;
- requested behavior crosses into account risk or order execution.

## Safety

This skill is a technical-analysis playbook only. It grants no broker execution, account access, risk authority, network access, or approval bypass. The XAU Risk Gate is authoritative after a technical proposal is emitted.
