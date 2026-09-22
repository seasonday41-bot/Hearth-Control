import { useEffect, useState } from 'react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import Icon from '../Icon';
import { freshness, setupSteps, setupSummary, timeLeft } from '../invest-setup-progress';
import type { V2CoordinatorDisplay } from '../invest-coordinator-status';

type Permission = PermissionValue;

export type DemoRiskForm = {
  riskPerTradePct: string;
  maxDailyLossPct: string;
  maxDrawdownPct: string;
  maxOpenRiskPct: string;
  maxPositions: string;
  maxSpreadPoints: string;
  maxSlippagePoints: string;
  minStopPoints: string;
  maxStopPoints: string;
  requestedVolume: string;
};

type Props = {
  investStatus: InvestStatus | null;
  investBusy: boolean;
  investError: string;
  demoRiskForm: DemoRiskForm;
  setDemoRiskForm: Dispatch<SetStateAction<DemoRiskForm>>;
  setDemoRiskDirty: Dispatch<SetStateAction<boolean>>;
  showV1History: boolean;
  setShowV1History: Dispatch<SetStateAction<boolean>>;
  saveDemoRiskConfig: () => Promise<void>;
  setInvestMode: (mode: InvestModeName) => Promise<void>;
  setMarketResearchPermission: (value: Permission) => void;
  useInvestKillSwitch: () => Promise<void>;
  v2CoordinatorDisplay: V2CoordinatorDisplay;
};

export default function InvestPage({
  investStatus,
  investBusy,
  investError,
  demoRiskForm,
  setDemoRiskForm,
  setDemoRiskDirty,
  showV1History,
  setShowV1History,
  saveDemoRiskConfig,
  setInvestMode,
  setMarketResearchPermission,
  useInvestKillSwitch,
  v2CoordinatorDisplay,
}: Props): ReactNode {
  // A display-only tick so a waiting setup's countdown moves between status
  // pushes. It reads nothing and decides nothing.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const bridge = investStatus?.mt5_bridge;
  const barFeed = freshness(bridge?.snapshots.length ? Math.max(...bridge.snapshots.map((item) => item.age_ms)) : null);
  const riskFeed = freshness(bridge?.risk_snapshot?.age_ms);
  const executorLive = Boolean(bridge?.executor_ready) && bridge?.executor_account_type === 'demo';
  const waiting = investStatus?.v2.waiting_for_entry ?? [];

  return (
    <div className="invest-view">
      <header className="page-header">
        <div>
          <p className="kicker">XAU/USD INVEST</p>
          <h1>Invest control.</h1>
          <p className="intro">Monitor XAU/USD, keep evidence, and control the demo-only execution boundary. Live-account execution is blocked.</p>
        </div>
        <div className={`connection-pill ${investStatus?.mode.mode !== 'OFF' ? 'online' : ''}`}><span /> {investStatus?.mode.mode.replace('_', ' ') || 'Loading'}</div>
      </header>

      <section className="invest-status-grid" aria-label="Invest services">
        <article><span className={`invest-status-dot ${barFeed.tone === 'live' ? 'ready' : barFeed.tone === 'absent' ? '' : 'warn'}`} /><div><small>MT5 PRICE FEED</small><strong>{barFeed.tone === 'live' ? 'Live' : barFeed.tone === 'absent' ? (bridge?.running ? 'Waiting for the EA' : 'Offline') : barFeed.label}</strong><p>{barFeed.tone === 'live' ? `${bridge?.snapshots[0]?.broker_symbol} · ${bridge?.snapshots.map((item) => item.timeframe).join(', ')}` : barFeed.tone === 'absent' ? 'Attach the MT5 EA to a XAUUSD chart to stream prices.' : 'Too old for the Risk Gate. Nothing will trade until it is live again.'}</p></div></article>
        <article><span className={`invest-status-dot ${investStatus?.search_ai.ready ? 'ready' : ''}`} /><div><small>SEARCH AI</small><strong>{investStatus?.search_ai.ready ? investStatus.search_ai.approval_required ? 'Ask before research' : 'Ready' : 'Blocked'}</strong><p>Uses fixed-origin market sources. It does not require Browser automation.</p></div></article>
        <article><span className={`invest-status-dot ${investStatus?.invest_ai.ready ? 'ready' : ''}`} /><div><small>INVEST AI</small><strong>{investStatus?.monitor.state === 'analyzing' ? 'Analyzing' : investStatus?.invest_ai.ready ? 'Ready' : 'Unavailable'}</strong><p>AI narrative cannot change direction, confidence, entry, stop loss, or take profit.</p></div></article>
        <article><span className={`invest-status-dot ${investStatus?.execution.transport_ready && investStatus?.execution.enabled && investStatus?.execution.executor_account_type === 'demo' ? 'ready' : ''}`} /><div><small>DEMO EXECUTOR</small><strong>{investStatus?.execution.enabled ? investStatus.execution.transport_ready ? investStatus.execution.executor_account_type === 'demo' ? 'Armed' : 'Blocked: live account' : 'Waiting for V3 EA' : 'Inactive'}</strong><p>{executorLive ? `Account telemetry ${riskFeed.label.toLowerCase()}. Only a READY setup that Risk approves may use this channel.` : 'Only internal READY + Risk-approved V2 signals may use the demo command channel. No renderer order button exists.'}</p></div></article>
      </section>

      <section className="soft-panel invest-controller" aria-labelledby="invest-mode-title">
        <div className="panel-title"><div><p className="section-kicker">MODE CONTROLLER</p><h2 id="invest-mode-title">Operating mode</h2></div><span className="invest-session-label">Startup: {investStatus?.mode.startup_mode || 'OFF'}</span></div>
        <div className="invest-mode-buttons" role="group" aria-label="Invest operating mode">
          {(['OFF', 'MONITOR', 'DEMO_AUTO'] as InvestModeName[]).map((mode) => <button type="button" key={mode} className={investStatus?.mode.mode === mode ? 'selected' : ''} aria-pressed={investStatus?.mode.mode === mode} disabled={investBusy || !investStatus} onClick={() => void setInvestMode(mode)}>{mode === 'DEMO_AUTO' ? 'DEMO AUTO' : mode}</button>)}
        </div>
        <div className="invest-mode-explanation">
          <strong>{investStatus?.mode.mode === 'MONITOR' ? 'Monitor selected' : investStatus?.mode.mode === 'DEMO_AUTO' ? 'Demo Auto selected for this session' : 'Invest is off'}</strong>
          <p>{investStatus?.mode.mode === 'MONITOR' ? `Watching ${investStatus.monitor.timeframe} for a new MT5 bar. ${investStatus.monitor.state === 'waiting_for_permission' ? 'Waiting for Market Research approval.' : investStatus.monitor.state === 'permission_denied' ? 'Research was denied for this bar.' : investStatus.monitor.state === 'permission_blocked' ? 'Market Research is blocked.' : investStatus.monitor.state === 'waiting_for_price' ? 'Waiting for MT5 price data.' : investStatus.monitor.state === 'analyzing' ? 'Search AI and Invest AI are analyzing now.' : 'A Mac notification will appear after a new signal is saved.'}` : investStatus?.mode.mode === 'DEMO_AUTO' ? 'The demo execution latch is enabled only for this session. V2 watches confirmed H1/M15/M5 bars and only a READY setup may continue to Risk and the demo-only executor.' : 'Market data may still arrive, but Invest will not start analysis or trading.'}</p>
        </div>

        <div className="invest-permission-control">
          <div><strong>Market Research permission</strong><small>Separate from the unavailable Browser automation tool.</small></div>
          <div role="group" aria-label="Market Research permission">
            {(['Allow', 'Ask', 'Blocked'] as Permission[]).map((value) => <button type="button" key={value} className={investStatus?.search_ai.permission === value ? 'selected' : ''} aria-pressed={investStatus?.search_ai.permission === value} onClick={() => setMarketResearchPermission(value)}>{value}</button>)}
          </div>
        </div>

        <div className="invest-safety-row">
          <div><strong>Startup safety is active</strong><p>DEMO AUTO always falls back to OFF after restart. KILL SWITCH blocks new demo orders but does not close an already-open position. Live accounts are rejected.</p></div>
          <button type="button" className="invest-kill-switch" disabled={investBusy || investStatus?.mode.mode === 'OFF'} onClick={() => void useInvestKillSwitch()}>KILL SWITCH</button>
        </div>
        {investError && <p className="invest-error" role="alert">{investError}</p>}
      </section>

      <section className="soft-panel invest-journal" aria-labelledby="invest-v2-title">
        <div className="panel-title"><div><p className="section-kicker">V2 TECHNICAL SETUPS</p><h2 id="invest-v2-title">H1 context · M15 setup · M5 trigger</h2></div><span className="invest-session-label">{investStatus?.v2.last_closed_m5 ? `M5 ${new Date(investStatus.v2.last_closed_m5).toLocaleTimeString()}` : 'Waiting for M5'}</span></div>
        <div className="invest-v2-grid">
          {(['SMC_IDM', 'HARMONIC_PRZ'] as const).map((key) => {
            const setup = investStatus?.v2.strategies[key];
            const steps = setupSteps(key, setup?.state, setup?.reason_codes ?? []);
            const hasLevels = Boolean(setup?.entry_zone);
            return <article key={key} className="invest-v2-card">
              <div className="invest-signal-heading"><span className={`invest-v2-state state-${(setup?.state || 'NO_SETUP').toLowerCase()}`}>{setup?.state || 'NO SETUP'}</span><strong>{key === 'SMC_IDM' ? 'SMC + IDM' : 'Harmonic PRZ'}</strong><span className={`invest-direction direction-${setup?.direction === 'BUY' ? 'up' : setup?.direction === 'SELL' ? 'down' : 'neutral'}`}>{setup?.direction || '—'}</span></div>
              {hasLevels && <div className="invest-signal-levels"><span>Entry zone <strong>{setup?.entry_zone?.join('–')}</strong><em>{setup?.direction === 'BUY' ? 'ask must be inside' : 'bid must be inside'}</em></span><span>Stop <strong>{setup?.invalidation ?? '—'}</strong><em>cancels the setup</em></span><span>Target <strong>{setup?.targets[0] ?? '—'}</strong><em>first take profit</em></span><span>Signal <strong>{setup?.signal_id ? setup.signal_id.slice(-8) : '—'}</strong></span></div>}
              <ol className="invest-setup-steps">
                {steps.map((step) => <li key={step.label} className={`step-${step.state}`}><span aria-hidden="true">{step.state === 'done' ? '✓' : step.state === 'failed' ? '✕' : step.state === 'waiting' ? '•' : '·'}</span>{step.label}</li>)}
              </ol>
              <small>{setupSummary(setup?.state, setup?.reason_codes ?? [])}</small>
            </article>;
          })}
        </div>
        {waiting.length > 0 && <div className="invest-waiting-entry">
          <p className="section-kicker">WAITING FOR ENTRY</p>
          {waiting.map((item) => {
            const left = timeLeft(item.expires_at, nowMs);
            return <div key={item.signal_id} className="invest-waiting-row">
              <strong>{item.strategy === 'SMC_IDM' ? 'SMC + IDM' : 'Harmonic PRZ'} {item.direction}</strong>
              <span>Zone {item.entry_zone.join('–')}</span>
              <span>{left ? `Expires in ${left}` : 'Expired'}</span>
            </div>;
          })}
          <small>These keep their original zone and stop. They enter only if the price comes back inside the zone before the time runs out, and Risk approves again.</small>
        </div>}

        <div className="invest-v2-risk-summary">
          <div><small>V2 COORDINATOR</small><strong className={`invest-v2-coordinator-status status-${v2CoordinatorDisplay.tone}`}>{v2CoordinatorDisplay.label}</strong><p>{investStatus?.v2.execution_blocked_reason ? `Execution: ${investStatus.v2.execution_blocked_reason.replaceAll('_', ' ')}` : 'Execution path has no active blocker.'}</p></div>
          <div><small>RISK DECISION</small><strong>{investStatus?.v2.risk.decision || (investStatus?.risk_config.configured ? 'Waiting for READY' : 'Not configured')}</strong><p>{investStatus?.v2.risk.approved_volume != null ? `Approved volume: ${investStatus.v2.risk.approved_volume}` : 'No lot size is selected unless Risk approves a READY setup.'}</p></div>
        </div>
      </section>

      <section className="soft-panel invest-journal" aria-labelledby="invest-risk-title">
        <div className="panel-title"><div><p className="section-kicker">DEMO RISK RULES</p><h2 id="invest-risk-title">Explicit execution limits</h2></div><span className="invest-session-label">{investStatus?.risk_config.configured ? 'CONFIGURED' : 'EXECUTION BLOCKED'}</span></div>
        <p className="invest-risk-help">These values are yours. Hearth does not create hidden risk defaults. Until every required field is saved, V2 can analyze setups but cannot submit a demo order.</p>
        <div className="invest-risk-grid">
          {[
            ['riskPerTradePct', 'Risk / trade (%)'],
            ['maxDailyLossPct', 'Max daily loss (%)'],
            ['maxDrawdownPct', 'Max drawdown (%)'],
            ['maxOpenRiskPct', 'Max total open risk (%)'],
            ['maxPositions', 'Max positions'],
            ['maxSpreadPoints', 'Max spread (points)'],
            ['maxSlippagePoints', 'Max slippage (points)'],
            ['minStopPoints', 'Min stop (points)'],
            ['maxStopPoints', 'Max stop (points)'],
            ['requestedVolume', 'Requested volume (optional)'],
          ].map(([field, label]) => <label key={field}><span>{label}</span><input type="number" min="0" step="any" value={demoRiskForm[field as keyof typeof demoRiskForm]} placeholder={field === 'requestedVolume' ? 'Calculated by Risk' : 'Required'} onChange={(event) => { setDemoRiskDirty(true); setDemoRiskForm((current) => ({ ...current, [field]: event.target.value })); }} /></label>)}
        </div>
        <div className="invest-risk-actions"><span>{investStatus?.risk_config.error ? `Stored config error: ${investStatus.risk_config.error}` : investStatus?.risk_config.configured ? 'Saved risk rules are active for DEMO_AUTO only.' : 'No demo risk rules saved yet.'}</span><button type="button" className="subtle-action" disabled={investBusy} onClick={() => void saveDemoRiskConfig()}>Save Demo Risk Rules</button></div>
      </section>

      <section className="soft-panel invest-journal" aria-labelledby="invest-journal-title">
        <div className="panel-title"><div><p className="section-kicker">V1 ANALYSIS · INFORMATION ONLY</p><h2 id="invest-journal-title">Latest analysis</h2></div><div className="invest-journal-actions"><span className="invest-session-label">{investStatus?.signals.length || 0} saved</span>{(investStatus?.signals.length || 0) > 1 && <button type="button" className="subtle-action" onClick={() => setShowV1History((value) => !value)}>{showV1History ? 'Hide history' : `History (${(investStatus?.signals.length || 0) - 1})`}</button>}</div></div>
        {investStatus?.signals.length ? <div className="invest-signal-list">{(showV1History ? investStatus.signals : investStatus.signals.slice(0, 1)).map((signal) => <article key={signal.id}>
          <div className="invest-signal-heading"><span className={`invest-direction direction-${signal.direction.toLowerCase()}`}>{signal.direction}</span><strong>{signal.confidence}%</strong><time>{new Date(signal.created_at).toLocaleString()}</time></div>
          <div className="invest-signal-levels"><span>Entry <strong>{signal.entry_zone.length ? signal.entry_zone.join('–') : '—'}</strong></span><span>SL <strong>{signal.stop_loss ?? '—'}</strong></span><span>TP <strong>{signal.targets[0] ?? '—'}</strong></span><span>Risk <strong>{signal.risk_level}</strong></span></div>
          {signal.summary && <p>{signal.summary}</p>}
          {signal.risks[0] && <small>Risk: {signal.risks[0]}</small>}
        </article>)}</div> : <div className="invest-journal-empty"><strong>No signals yet</strong><p>Set Market Research to Allow or approve the request, select MONITOR, and keep the MT5 EA streaming XAUUSD H1 data.</p></div>}
      </section>

      <section className="soft-panel invest-journal" aria-labelledby="invest-execution-title">
        <div className="panel-title"><div><p className="section-kicker">EXECUTION JOURNAL</p><h2 id="invest-execution-title">Demo execution evidence</h2></div><span className="invest-session-label">{investStatus?.executions.length || 0} saved</span></div>
        {investStatus?.executions.length ? <div className="invest-signal-list">{investStatus.executions.map((execution) => <article key={execution.request_id}>
          <div className="invest-signal-heading"><span className={`invest-direction direction-${execution.side === 'BUY' ? 'up' : 'down'}`}>{execution.side}</span><strong>{execution.state}</strong><time>{new Date(execution.updated_at).toLocaleString()}</time></div>
          <div className="invest-signal-levels"><span>Strategy <strong>{execution.strategy}</strong></span><span>Volume <strong>{execution.request.volume}</strong></span><span>SL <strong>{execution.request.stop_loss}</strong></span><span>TP <strong>{execution.request.take_profit}</strong></span></div>
          <small>{execution.receipt?.reason || execution.error || execution.request_id}</small>
        </article>)}</div> : <div className="invest-journal-empty"><strong>No demo executions yet</strong><p>Execution evidence appears here only after the internal V2 coordinator submits a READY, Risk-approved signal to the demo-only executor.</p></div>}
      </section>
    </div>
  );
}
