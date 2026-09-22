import type { Dispatch, ReactNode, RefObject, SetStateAction } from 'react';
import Icon from '../Icon';

export type ChatActivityItem = {
  type: string; skill: string; elapsedMs?: number; resultCount?: number; stage?: string;
  relativePath?: string; profile?: string; label?: string; timeoutMs?: number; pid?: number | null;
  status?: string; exitCode?: number | null; passedCount?: number; testCount?: number;
  outputTruncated?: boolean; processStillRunning?: boolean;
};
export type ChatTestApproval = { requestId: string; profile: string; label: string; timeoutMs: number };

type Props = {
  chatProvider: 'local' | 'external';
  chatModel: string;
  chatModels: string[];
  chatProfile: 'fast' | 'normal' | 'deep';
  chatPrompt: string;
  chatBusy: boolean;
  chatError: string;
  chatResult: any;
  chatStreaming: boolean;
  chatStreamText: string;
  chatElapsedMs: number;
  chatLongResponse: boolean;
  chatFollowOutput: boolean;
  chatHealth: any;
  chatActivity: ChatActivityItem[];
  chatTestApproval: ChatTestApproval | null;
  chatExpandedCode: { code: string; language: string } | null;
  chatContext: any;
  chatContextLoading: boolean;
  chatContextError: string;
  showChatContext: boolean;
  chatResponseRef: RefObject<HTMLDivElement | null>;
  setChatModel: Dispatch<SetStateAction<string>>;
  setChatProfile: Dispatch<SetStateAction<'fast' | 'normal' | 'deep'>>;
  setChatPrompt: Dispatch<SetStateAction<string>>;
  setChatLongResponse: Dispatch<SetStateAction<boolean>>;
  setChatFollowOutput: Dispatch<SetStateAction<boolean>>;
  setChatExpandedCode: Dispatch<SetStateAction<{ code: string; language: string } | null>>;
  setChatTestApproval: Dispatch<SetStateAction<ChatTestApproval | null>>;
  setShowChatContext: Dispatch<SetStateAction<boolean>>;
  handleChatProviderChange: (provider: 'local' | 'external') => void;
  handleChatResponseScroll: () => void;
  handleLocalChatSend: () => Promise<void>;
  handleLocalChatStop: () => void;
  toggleChatContext: () => Promise<void>;
  LocalChatResponse: (props: { text: string; onExpand: (code: string, language: string) => void }) => ReactNode;
};

export default function ChatPage({
  chatProvider,
  chatModel,
  chatModels,
  chatProfile,
  chatPrompt,
  chatBusy,
  chatError,
  chatResult,
  chatStreaming,
  chatStreamText,
  chatElapsedMs,
  chatLongResponse,
  chatFollowOutput,
  chatHealth,
  chatActivity,
  chatTestApproval,
  chatExpandedCode,
  chatContext,
  chatContextLoading,
  chatContextError,
  showChatContext,
  chatResponseRef,
  setChatModel,
  setChatProfile,
  setChatPrompt,
  setChatLongResponse,
  setChatFollowOutput,
  setChatExpandedCode,
  setChatTestApproval,
  setShowChatContext,
  handleChatProviderChange,
  handleChatResponseScroll,
  handleLocalChatSend,
  handleLocalChatStop,
  toggleChatContext,
  LocalChatResponse,
}: Props): ReactNode {
  return (
    <div className="local-chat-view">
      <header className="page-header">
        <div>
          <p className="kicker">EXPERIMENTAL LOCAL CHAT</p>
          <h1>Local Chat.</h1>
          <p className="intro">Choose a provider explicitly for this request. No task or durable job is created by Local Chat.</p>
        </div>
        <div className="local-chat-header-actions"><button type="button" className="context-button" aria-expanded={showChatContext} onClick={() => void toggleChatContext()}>Context</button><div className={`connection-pill ${chatProvider === 'local' && chatHealth?.ok ? 'online' : ''}`}><span /> {chatProvider === 'local' ? `Ollama · ${chatHealth?.ok ? 'Available' : 'Unavailable'}` : 'External provider'}</div></div>
      </header>

      <section className="local-chat-panel">
        <div className="local-chat-controls">
          <div className="local-chat-field">
            <label>Provider</label>
            <div className="local-chat-toggle" role="group" aria-label="Chat provider">
              <button type="button" className={chatProvider === 'local' ? 'selected' : ''} onClick={() => handleChatProviderChange('local')}>Local</button>
              <button type="button" className={chatProvider === 'external' ? 'selected' : ''} onClick={() => handleChatProviderChange('external')}>External</button>
            </div>
          </div>
          {chatProvider === 'local' ? (
            <>
              <div className="local-chat-field">
                <label htmlFor="local-chat-model">Model</label>
                <select id="local-chat-model" value={chatModel} onChange={(event) => setChatModel(event.target.value)} disabled={!chatHealth?.ok || chatModels.length === 0}>
                  {chatModels.length === 0 ? <option value={chatModel}>{chatHealth?.ok ? 'No local models found' : 'Ollama unavailable'}</option> : chatModels.map((model) => <option key={model} value={model}>{model}</option>)}
                </select>
              </div>
              <div className="local-chat-field">
                <label htmlFor="local-chat-profile">Profile</label>
                <select id="local-chat-profile" value={chatProfile} onChange={(event) => setChatProfile(event.target.value as 'fast' | 'normal' | 'deep')}>
                  <option value="fast">FAST</option>
                  <option value="normal">NORMAL</option>
                  <option value="deep">DEEP</option>
                </select>
              </div>
            </>
          ) : <p className="local-chat-external-note">External uses the existing provider path and its configured permission.</p>}
        </div>

        <div className="local-chat-field">
          <label htmlFor="local-chat-prompt">Prompt</label>
          <textarea id="local-chat-prompt" rows={6} value={chatPrompt} onChange={(event) => setChatPrompt(event.target.value)} placeholder="Write a message for the selected provider…" />
        </div>
        <div className="local-chat-actions">
          <span className={`local-chat-status ${chatProvider === 'local' && chatHealth?.ok ? 'available' : ''}`}>{chatProvider === 'local' ? (chatHealth?.ok ? 'Ollama available' : 'Ollama unavailable') : 'External selected'}</span>
          {chatStreaming ? <button type="button" className="local-chat-stop-button" onClick={handleLocalChatStop}>Stop</button> : <button type="button" className="run-task-button" disabled={chatBusy || !chatPrompt.trim() || (chatProvider === 'local' && !chatHealth?.ok)} onClick={() => void handleLocalChatSend()}>{chatBusy ? 'Sending…' : 'Send'}</button>}
        </div>
        {chatProvider === 'local' && <label className="local-chat-long-response"><input type="checkbox" checked={chatLongResponse} onChange={(event) => setChatLongResponse(event.target.checked)} /> Long response</label>}
        {chatStreaming && <div className="local-chat-generating" aria-live="polite">{chatTestApproval ? 'Waiting for test approval' : chatActivity.some((item) => item.type === 'test_running') ? 'Running test' : 'Generating…'} · {Math.round(chatElapsedMs / 1000)}s</div>}
        {chatTestApproval && <section className="local-chat-test-confirmation" aria-label="Run test confirmation"><div><strong>Run test?</strong><p>{chatTestApproval.label}</p><small>Profile: {chatTestApproval.profile} · Timeout: {Math.round(chatTestApproval.timeoutMs / 1000)}s</small></div><div className="local-chat-test-confirmation-actions"><button type="button" onClick={() => { window.controlApp.localChatTestApproval(chatTestApproval.requestId, false); setChatTestApproval(null); }}>Cancel</button><button type="button" onClick={() => { window.controlApp.localChatTestApproval(chatTestApproval.requestId, true); setChatTestApproval(null); }}>Run Test</button></div></section>}
        {chatActivity.length > 0 && <section className="local-chat-activity" aria-label="Local AI activity"><strong>{chatStreaming ? 'Working' : 'Activity'}</strong>{chatActivity.map((item, index) => <div key={`${item.skill}-${index}`} className="local-chat-activity-row"><span>{item.type === 'skill_completed' || item.type === 'evidence_complete' || item.type === 'test_finished' && item.status === 'passed' ? '✓' : item.type === 'skill_failed' || item.type === 'evidence_incomplete' || item.type === 'test_finished' && item.status !== 'passed' ? '!' : '●'}</span><span>{item.type === 'evidence_complete' ? 'Evidence trace complete' : item.type === 'evidence_incomplete' ? 'Evidence trace incomplete' : item.type === 'evidence_progress' ? `${item.stage || 'SOURCE'} · ${item.relativePath || item.skill}` : item.type === 'test_approval_requested' ? `Waiting for approval · ${item.label} · ${Math.round((item.elapsedMs || 0) / 1000)}s` : item.type === 'test_approval_cancelled' ? `Test not run · ${item.label}` : item.type === 'test_running' ? `Running ${item.label} · PID ${item.pid ?? 'pending'} · ${Math.round((item.elapsedMs || 0) / 1000)}s` : item.type === 'test_finished' ? `${item.label} ${item.status}${item.passedCount === undefined || item.testCount === undefined ? '' : ` · ${item.passedCount}/${item.testCount}`}${['cancelled', 'timed_out'].includes(item.status || '') || item.exitCode === null || item.exitCode === undefined ? '' : ` · exit ${item.exitCode}`}${item.processStillRunning ? ' · manual review required' : ''}` : item.type === 'skill_started' ? `Running ${item.skill}` : `${item.skill}${item.resultCount === undefined ? '' : ` · ${item.resultCount} results`}`}</span></div>)}</section>}
        {chatError && <div className="local-chat-error" role="alert">{chatError}</div>}
        {(chatStreamText || chatResult) && <section className="local-chat-result" aria-live="polite"><div className="local-chat-result-meta"><span>{chatResult?.provider || 'ollama'}</span><span>{chatResult?.model || chatModel}</span><span>{chatProvider === 'local' ? chatProfile.toUpperCase() : 'EXTERNAL'}</span><span>{chatStreaming ? `${Math.round(chatElapsedMs / 1000)}s` : `${chatResult?.elapsedMs || chatElapsedMs} ms`}</span></div><div ref={chatResponseRef} className="local-chat-response-viewer" onScroll={handleChatResponseScroll}><LocalChatResponse text={chatStreamText || chatResult?.response || ''} onExpand={(code, language) => setChatExpandedCode({ code, language })} /></div>{!chatFollowOutput && chatStreaming && <button type="button" className="local-chat-bottom-button" onClick={() => { setChatFollowOutput(true); if (chatResponseRef.current) chatResponseRef.current.scrollTop = chatResponseRef.current.scrollHeight; }}>↓ Bottom</button>}{chatResult?.doneReason === 'length' && <small className="local-chat-output-warning">Response reached the output limit.</small>}</section>}
        {showChatContext && <section className="local-chat-context-inspector" aria-label="Local AI context"><header><strong>Context supplied to Local AI</strong><button type="button" onClick={() => setShowChatContext(false)}>Close</button></header>{chatContextLoading ? <p>Loading current context…</p> : chatContextError ? <p role="alert">{chatContextError}</p> : chatContext && <div><h3>Runtime</h3><pre>{chatContext.runtime}</pre><h3>Capabilities</h3><p><strong>Available:</strong> {chatContext.capabilities.available.join('; ')}</p><p><strong>Not available:</strong> {chatContext.capabilities.unavailable.join('; ')}</p><h3>Project</h3><pre>{chatContext.project}</pre><h3>Safety</h3><p>{chatContext.safety}</p><h3>Response Style</h3><p>{chatContext.responseStyle}</p></div>}</section>}
        {chatExpandedCode && <div className="local-chat-code-modal" role="dialog" aria-modal="true"><div className="local-chat-code-modal-header"><span>{chatExpandedCode.language || 'code'}</span><button type="button" onClick={() => setChatExpandedCode(null)}>Close</button></div><pre><code>{chatExpandedCode.code}</code></pre></div>}
      </section>
    </div>
  );
}
