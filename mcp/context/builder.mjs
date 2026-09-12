const CAPABILITIES = Object.freeze({
  available: ['receive user text', 'generate conversational responses', 'reason about provided text/code', 'write and explain code in the response', 'brainstorm and plan', 'stream responses', 'stop generation', 'use Hearth runtime context'],
  unavailable: ['read arbitrary Mac files', 'write or edit files', 'run Terminal commands', 'run tests or execute code', 'browse the web or control a browser', 'GitHub or Supabase actions', 'macOS computer control', 'Hearth MCP tools', 'image analysis through Local Chat', 'persistent personal memory', 'automatic task execution or delegation', 'change Hearth task state', 'delete or move files', 'Storage Audit actions'],
});

const value = (input) => input === undefined || input === null || input === '' ? 'unknown' : String(input);
const offset = (date) => {
  const minutes = -date.getTimezoneOffset();
  const sign = minutes >= 0 ? '+' : '-';
  const absolute = Math.abs(minutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
};

export const buildLocalContext = ({ now = new Date(), version, buildId, timezone, model, profile, longResponse = false, ollamaAvailable, workspace, projectName, gitBranch, gitCommit, gitState } = {}) => {
  const localTimezone = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
  const localDate = now.toLocaleDateString('en-CA', { timeZone: localTimezone });
  const localTime = now.toLocaleTimeString('en-GB', { timeZone: localTimezone, hour12: false });
  const sections = [
    ['Identity', 'You are Hearth Local AI running locally on this Mac.'],
    ['Runtime Context', [`Current local date: ${localDate}`, `Current local time: ${localTime}`, `Timezone: ${localTimezone} (UTC${offset(now)})`, `Hearth version: ${value(version)}`, `Hearth build: ${value(buildId)}`, `Ollama: ${ollamaAvailable === true ? 'available' : ollamaAvailable === false ? 'unavailable' : 'unknown'}`, `Selected model: ${value(model)}`, `Selected profile: ${value(profile).toUpperCase()}`, `Long response: ${longResponse ? 'on' : 'off'}`].join('\n')],
    ['Capability Manifest', `Available: ${CAPABILITIES.available.join('; ')}.\nNot available: ${CAPABILITIES.unavailable.join('; ')}. Never claim an unavailable action was performed.`],
    ['Hearth Core Safety', 'Hearth Core owns lifecycle and task state; Local AI does not own JobManager, durable jobs, continuation, or completion. Progress is not completion. Do not expose credentials, tokens, sessions, or private provider data. Storage Audit v0.1 is read-only. Keep unknown state unknown.'],
    ['Project / Workspace', [`Workspace: ${value(workspace)}`, `Project: ${value(projectName)}`, `Git branch: ${value(gitBranch)}`, `Git commit: ${value(gitCommit)}`, `Working tree: ${value(gitState)}`].join('\n')],
    ['Current Hearth Project State', 'Completed: stable v0.4.3 durable runtime baseline; Local Chat with Ollama; streaming, Stop, and bounded response viewer; Context Builder v0.1; Storage Audit v0.1 implemented and READ ONLY. Next: Local AI Skills / Tool Gateway, starting with read-only Repo Reader, File Search, Git Inspector, and Test Runner.'],
    ['Response Style', 'Answer in the user’s language with a concise conversational tone. Use short paragraphs, minimal preamble, direct answers, code first for coding requests, brief explanation after code, explicit uncertainty, and no hidden reasoning. Do not repeat the request or claim unavailable capabilities. When a requested capability is unavailable, state that briefly, do not invent unseen file contents or assume a framework/library/project structure, and offer the safest next step. Provide generic example code only when the user explicitly asks for an example.'],
  ];
  return sections.map(([title, body]) => `## ${title}\n${body}`).join('\n\n');
};

export const buildContextPreview = (options = {}) => ({
  runtime: buildLocalContext(options).split('\n\n').find((section) => section.startsWith('## Runtime Context'))?.replace(/^## Runtime Context\n/, '') || '',
  capabilities: CAPABILITIES,
  project: buildLocalContext(options).split('\n\n').find((section) => section.startsWith('## Project / Workspace'))?.replace(/^## Project \/ Workspace\n/, '') || '',
  safety: buildLocalContext(options).split('\n\n').find((section) => section.startsWith('## Hearth Core Safety'))?.replace(/^## Hearth Core Safety\n/, '') || '',
  responseStyle: buildLocalContext(options).split('\n\n').find((section) => section.startsWith('## Response Style'))?.replace(/^## Response Style\n/, '') || '',
});

export const CONTEXT_CAPABILITIES = CAPABILITIES;
