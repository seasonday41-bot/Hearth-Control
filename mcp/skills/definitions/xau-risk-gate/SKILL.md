---
schema: hearth-skill-v1
id: xau-risk-gate
name: XAU Risk Gate
version: 1
summary: Evaluate XAUUSD technical proposals independently from strategy logic and return APPROVE, RESIZE, or REJECT without altering the underlying technical signal.
agents: [invest]
mode: decision-gate
risk: high
tools: []
---

# XAU Risk Gate

Use this skill after a deterministic technical strategy has produced a proposal. Risk is independent from SMC/IDM, Harmonic PRZ, or any future entry strategy.

The Risk Gate may veto or reduce a proposal. A technical strategy may never override the Risk Gate.

## Use when

- a technical proposal is READY;
- account/demo state required by the configured policy is available;
- entry, invalidation, and target data are deterministic;
- the system needs a bounded decision before a demo executor.

## Do not use when

- the technical proposal is PRE_SIGNAL, INVALID, stale, malformed, or missing an invalidation level;
- account/risk state required by policy is unavailable;
- the request asks the Risk Gate to invent an entry signal;
- live-account execution is being requested before a separately approved live-trading design exists.

## Separation of responsibility

Technical strategy owns:

- setup detection;
- direction;
- entry zone;
- invalidation;
- targets;
- technical evidence.

Risk Gate owns:

- whether the proposal is allowed to proceed;
- maximum permitted risk;
- position-size ceiling;
- daily loss / drawdown boundary;
- concurrent position and exposure limits;
- spread/slippage acceptance;
- margin sufficiency;
- cooldown / circuit-breaker state;
- session execution safety.

Risk Gate must not rewrite the strategy's direction, pattern, BOS, PRZ, or technical evidence.

## Decision model

Return exactly one bounded decision:

- APPROVE: proposal may proceed within the approved risk budget.
- RESIZE: proposal is technically eligible but the requested/external size must be reduced to the approved maximum.
- REJECT: proposal must not be executed.

The implementation should include explicit reason codes.

## Minimum fail-closed checks

Reject or block when any configured mandatory check fails, including when applicable:

- stale technical signal;
- invalid or missing stop/invalidation;
- stop distance outside configured bounds;
- spread above configured maximum;
- slippage / execution-quality guard not satisfied;
- daily loss limit reached;
- maximum drawdown boundary reached;
- maximum concurrent risk reached;
- maximum position count reached;
- required margin unavailable;
- cooldown/circuit breaker active;
- session mode does not permit execution;
- DEMO_AUTO not explicitly enabled for the current session.

## Position sizing

Current implementation requires explicit validated demo broker/account metadata. HearthXauBridgeV2.mq5 plus the loopback /v1/risk-state adapter provides this read-only telemetry path. The original HearthXauBridge.mq5 remains market-only. Missing, stale, incomplete, or malformed contract/account fields must produce REJECT rather than assumed XAUUSD specifications.

Position sizing must be deterministic from configured inputs. Do not let an LLM choose lot size.

A typical implementation may derive size from:

```text
allowed_loss = reference_equity * configured_risk_fraction
position_size = allowed_loss / stop_value_per_position_unit
```

Exact broker contract size, tick value, volume step, min/max volume, and currency conversion must come from validated broker/demo metadata before executable sizing is trusted.

Do not hard-code live-account assumptions into this skill.

## Output contract

```text
decision: APPROVE | RESIZE | REJECT
strategy: <source strategy>
symbol: XAUUSD
proposal_id: <stable id>
approved_risk_fraction: <configured/deterministic value or null>
approved_volume: <deterministic broker-normalized value or null>
reason_codes: [<bounded codes>]
checks:
  stale: pass|fail
  stop: pass|fail
  spread: pass|fail|unavailable
  daily_loss: pass|fail|unavailable
  drawdown: pass|fail|unavailable
  exposure: pass|fail|unavailable
  margin: pass|fail|unavailable
  cooldown: pass|fail
  mode: pass|fail
as_of: <timestamp>
```

Unavailable data for a mandatory check must not be silently treated as pass.

## Evidence required

Before APPROVE or RESIZE, retain evidence for every mandatory configured check and the exact inputs used for any position-size calculation.

## Stop conditions

Return REJECT/BLOCKED rather than improvise when:

- required account/demo metadata is unavailable;
- broker sizing data cannot be validated;
- a mandatory risk check cannot be evaluated;
- a strategy tries to bypass the gate;
- the current execution mode is not authorized.

## Safety

This skill does not itself execute trades. It defines a deterministic decision boundary. Live-account trading remains out of scope until separately designed, reviewed, and explicitly enabled.