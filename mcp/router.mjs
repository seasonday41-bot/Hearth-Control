import { redactSecrets } from './executors/antigravity.mjs';

export const ROUTE_TYPES = Object.freeze({
  AUTO: 'auto',
  MCP: 'mcp',
  ANTIGRAVITY: 'antigravity',
  MANUAL: 'manual',
});

/**
 * Sanitizes route metadata and transitions to ensure no tokens, passwords,
 * or raw prompt bodies are leaked into logs or persistent state.
 * @param {string} text
 * @returns {string}
 */
export const sanitizeRouteReason = (text) => {
  if (typeof text !== 'string') return '';
  return redactSecrets(text).slice(0, 300);
};

/**
 * Extracts candidate file path from prompt for read_file.
 * @param {string} prompt
 * @returns {string | null}
 */
export const extractFilePath = (prompt) => {
  if (typeof prompt !== 'string') return null;
  // Match quotes first: "path/to/file.ext" or 'path/to/file.ext'
  const quotedMatch = prompt.match(/["']([^"'\n\r]+\.[a-zA-Z0-9]+)["']/);
  if (quotedMatch && quotedMatch[1]) {
    return quotedMatch[1].trim();
  }
  // Match common patterns: (read|view|cat|inspect|display|show) (?:file )?([^\s,;]+\.[a-zA-Z0-9]+)
  const pathMatch = prompt.match(/(?:read|view|cat|inspect|display|show)\s+(?:file\s+)?([^\s,;]+\.[a-zA-Z0-9]+)/i);
  if (pathMatch && pathMatch[1]) {
    return pathMatch[1].trim();
  }
  // Match well-known files like package.json, README.md, tsconfig.json, etc.
  const wellKnownMatch = prompt.match(/\b(package\.json|package-lock\.json|README\.md|tsconfig\.json|vite\.config\.ts|\.gitignore)\b/i);
  if (wellKnownMatch && wellKnownMatch[1]) {
    return wellKnownMatch[1].trim();
  }
  return null;
};

/**
 * Extracts candidate search query from prompt for search_files.
 * @param {string} prompt
 * @returns {string | null}
 */
export const extractSearchQuery = (prompt) => {
  if (typeof prompt !== 'string') return null;
  // Quoted query: search for "hello world"
  const quotedMatch = prompt.match(/(?:search|find|grep)\s+(?:for\s+)?["']([^"'\n\r]+)["']/i);
  if (quotedMatch && quotedMatch[1]) {
    return quotedMatch[1].trim();
  }
  // Unquoted: search for <word>
  const unquotedMatch = prompt.match(/(?:search|find|grep)\s+(?:for\s+)?([a-zA-Z0-9_-]+)/i);
  if (unquotedMatch && unquotedMatch[1]) {
    return unquotedMatch[1].trim();
  }
  return null;
};

/**
 * Checks if prompt involves destructive, privileged, or blocked operations.
 * @param {string} prompt
 * @returns {{ isDestructive: boolean, reason: string | null }}
 */
export const checkDestructiveOrBlocked = (prompt) => {
  const lower = prompt.toLowerCase();

  // Browser check (strictly blocked in Hearth)
  if (/\b(browser|browse|web\s*page|website|open\s+url|https?:\/\/)\b/i.test(lower)) {
    return {
      isDestructive: true,
      reason: 'Manual · browser capability is blocked',
    };
  }

  // Privilege escalation & destructive system commands
  const blockedPatterns = [
    { pattern: /\b(sudo|su|doas)\b/i, reason: 'Manual · privilege escalation command is blocked' },
    { pattern: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: 'Manual · system lifecycle command is blocked' },
    { pattern: /\b(mkfs|mke2fs|mkswap)\b/i, reason: 'Manual · disk formatting is blocked' },
    { pattern: /\bdd\s+if=/i, reason: 'Manual · raw disk I/O is blocked' },
    { pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f*|--recursive)\b/i, reason: 'Manual · recursive deletion is blocked' },
    { pattern: /\bdiskutil\s+(erase|erasedisk|erasevolume|reformat|zerodisk)\b/i, reason: 'Manual · destructive disk operation is blocked' },
    { pattern: /\b(delete\s+everything|wipe\s+(?:disk|drive|workspace)|drop\s+database)\b/i, reason: 'Manual · destructive operation requires confirmation' },
  ];

  for (const item of blockedPatterns) {
    if (item.pattern.test(lower)) {
      return { isDestructive: true, reason: item.reason };
    }
  }

  // Ambiguous or unclear high-risk instructions
  const trimmed = prompt.trim();
  if (/^(delete|destroy|wipe|kill|format)$/i.test(trimmed)) {
    return {
      isDestructive: true,
      reason: 'Manual · ambiguous operation requires confirmation',
    };
  }

  return { isDestructive: false, reason: null };
};

/**
 * Checks if prompt matches Antigravity patterns (code editing, refactoring, build/test, etc.).
 * @param {string} prompt
 * @returns {{ matches: boolean, reason: string | null }}
 */
export const checkAntigravityPreferred = (prompt) => {
  const lower = prompt.toLowerCase();

  // Code modifications / refactor / implementation
  const editPatterns = [
    /\b(refactor|refactoring|rewrite|redesign)\b/i,
    /\b(implement|implementation|add\s+feature|create\s+feature)\b/i,
    /\b(fix\s+bug|debug|patch|fix\s+issue|troubleshoot)\b/i,
    /\b(modify|update|edit|alter|replace)\s+(?:file|files|code|component|function|class)\b/i,
    /\b(create|add|write)\s+(?:new\s+)?(?:file|files|module|script|test)\b/i,
    /\b(delete|remove)\s+(?:file|files|folder|directory)\b/i,
    /\b(multi-file|across\s+files|all\s+files)\b/i,
  ];

  for (const p of editPatterns) {
    if (p.test(lower)) {
      return { matches: true, reason: 'Antigravity · multi-step code change' };
    }
  }

  // Build, test, package orchestration, terminal execution
  const buildTestPatterns = [
    /\b(npm\s+run|npm\s+test|npm\s+build|npm\s+install|npx)\b/i,
    /\b(run\s+tests?|run\s+test\s+suite|run\s+build|test\s+orchestration)\b/i,
    /\b(cargo\s+build|cargo\s+test|go\s+test|mvn\s+test|gradle\s+test)\b/i,
    /\b(build\s+project|package\s+project|bundle|compile)\b/i,
    /\b(git\s+commit|git\s+push|git\s+merge|git\s+rebase|git\s+checkout)\b/i,
    /\b(terminal\s+workflow|run\s+script|execute\s+script)\b/i,
  ];

  for (const p of buildTestPatterns) {
    if (p.test(lower)) {
      return { matches: true, reason: 'Antigravity · build/test workflow' };
    }
  }

  // Multi-step complex reasoning (numbered lists, sequential clauses)
  if (/(?:1\.\s+.*\n2\.\s+|first\b.*\bthen\b.*\bfinally\b)/i.test(prompt)) {
    return { matches: true, reason: 'Antigravity · multi-step engineering work' };
  }

  return { matches: false, reason: null };
};

/**
 * Checks if prompt matches read-only MCP patterns (workspace info, files, search, git).
 * @param {string} prompt
 * @returns {{ matches: boolean, toolHint: string | null, reason: string | null, params: Record<string, any> }}
 */
export const checkMcpPreferred = (prompt) => {
  const lower = prompt.toLowerCase().trim();

  // 1. Workspace info
  if (/\b(workspace\s*info|workspace\s*information|workspace\s*root|current\s*workspace|show\s*workspace|view\s*workspace|check\s*workspace)\b/i.test(lower)) {
    return {
      matches: true,
      toolHint: 'workspace_info',
      reason: 'MCP · workspace inspection',
      params: {},
    };
  }

  // 2. Git status
  if (/\b(git\s+status|git\s+branch|repo\s+status|working\s+tree\s+status|git\s+state)\b/i.test(lower)) {
    return {
      matches: true,
      toolHint: 'git_status',
      reason: 'MCP · git status inspection',
      params: {},
    };
  }

  // 3. Git diff
  if (/\b(git\s+diff|show\s+diff|view\s+diff|unstaged\s+changes|staged\s+changes|inspect\s+diff)\b/i.test(lower)) {
    const staged = /\bstaged\b/i.test(lower);
    return {
      matches: true,
      toolHint: 'git_diff',
      reason: 'MCP · git diff inspection',
      params: { staged },
    };
  }

  // 4. Read specific file (must not be an edit request)
  const isReadVerb = /\b(read|view|cat|inspect|display|show|open)\b/i.test(lower);
  const isEditVerb = /\b(edit|write|modify|update|change|create|delete)\b/i.test(lower);
  const filePath = extractFilePath(prompt);

  if (isReadVerb && !isEditVerb && filePath) {
    return {
      matches: true,
      toolHint: 'read_file',
      reason: 'MCP · read-only file inspection',
      params: { path: filePath },
    };
  }

  // 5. Search files / text search
  if (/\b(search\s+for|search\s+text|search\s+files|grep|find\s+in\s+files|find\s+occurrences)\b/i.test(lower)) {
    const query = extractSearchQuery(prompt) || '';
    return {
      matches: true,
      toolHint: 'search_files',
      reason: 'MCP · text/file search',
      params: { query },
    };
  }

  // 6. List files / directory
  if (/\b(list\s+files|list\s+directory|list\s+folder|show\s+files|ls\b|dir\b)\b/i.test(lower)) {
    return {
      matches: true,
      toolHint: 'list_files',
      reason: 'MCP · file listing',
      params: { path: '.' },
    };
  }

  return { matches: false, toolHint: null, reason: null, params: {} };
};

/**
 * Classifies task execution route deterministically without any LLM or external model calls.
 *
 * @param {object} options
 * @param {string} options.prompt - Natural language task instruction.
 * @param {string} [options.requestedRoute='auto'] - User route selection: 'auto' | 'mcp' | 'antigravity' | 'manual'.
 * @param {Record<string, string>} [options.permissions={}] - Hearth permissions.
 * @param {string} [options.workspace=''] - Workspace root path.
 * @returns {{
 *   requestedRoute: string,
 *   resolvedRoute: string,
 *   routeReason: string,
 *   toolHint: string | null,
 *   params: Record<string, any>,
 *   isUnsupportedMcp?: boolean,
 *   unsupportedReason?: string,
 * }}
 */
export const classifyTask = ({
  prompt,
  requestedRoute = 'auto',
  permissions = {},
  workspace = '',
}) => {
  const cleanPrompt = typeof prompt === 'string' ? prompt.trim() : '';
  const cleanRequested = ['auto', 'mcp', 'antigravity', 'manual'].includes(requestedRoute)
    ? requestedRoute
    : 'auto';

  // 1. Manual override: Antigravity
  if (cleanRequested === 'antigravity') {
    return {
      requestedRoute: 'antigravity',
      resolvedRoute: 'antigravity',
      routeReason: 'Antigravity · manual override',
      toolHint: null,
      params: {},
    };
  }

  // 2. Manual override: Manual / Ask
  if (cleanRequested === 'manual') {
    return {
      requestedRoute: 'manual',
      resolvedRoute: 'manual',
      routeReason: 'Manual · user sign-off required',
      toolHint: null,
      params: {},
    };
  }

  // 3. Manual override: MCP
  if (cleanRequested === 'mcp') {
    // Check if task is valid for MCP or unsupported
    const destructive = checkDestructiveOrBlocked(cleanPrompt);
    const agy = checkAntigravityPreferred(cleanPrompt);
    const mcp = checkMcpPreferred(cleanPrompt);

    if (destructive.isDestructive) {
      return {
        requestedRoute: 'mcp',
        resolvedRoute: 'mcp',
        routeReason: 'MCP · manual override (blocked/destructive)',
        toolHint: null,
        params: {},
        isUnsupportedMcp: true,
        unsupportedReason: destructive.reason,
      };
    }

    if (agy.matches && !mcp.matches) {
      return {
        requestedRoute: 'mcp',
        resolvedRoute: 'mcp',
        routeReason: 'MCP · manual override',
        toolHint: null,
        params: {},
        isUnsupportedMcp: true,
        unsupportedReason: 'Capability insufficient: requested operation requires code modification or orchestration not supported by MCP read-only tools.',
      };
    }

    return {
      requestedRoute: 'mcp',
      resolvedRoute: 'mcp',
      routeReason: sanitizeRouteReason(mcp.reason || 'MCP · manual override'),
      toolHint: mcp.toolHint || 'workspace_info',
      params: mcp.params || {},
      isUnsupportedMcp: false,
    };
  }

  // 4. Automatic Classification (requestedRoute === 'auto')
  // A. Check destructive / blocked / unclear high-risk operations first
  const destructiveCheck = checkDestructiveOrBlocked(cleanPrompt);
  if (destructiveCheck.isDestructive) {
    return {
      requestedRoute: 'auto',
      resolvedRoute: 'manual',
      routeReason: sanitizeRouteReason(destructiveCheck.reason),
      toolHint: null,
      params: {},
    };
  }

  // B. Check if task clearly prefers Antigravity (code edits, refactor, build, test orchestration)
  const agyCheck = checkAntigravityPreferred(cleanPrompt);
  if (agyCheck.matches) {
    return {
      requestedRoute: 'auto',
      resolvedRoute: 'antigravity',
      routeReason: sanitizeRouteReason(agyCheck.reason),
      toolHint: null,
      params: {},
    };
  }

  // C. Check if task clearly matches read-only MCP tools
  const mcpCheck = checkMcpPreferred(cleanPrompt);
  if (mcpCheck.matches) {
    return {
      requestedRoute: 'auto',
      resolvedRoute: 'mcp',
      routeReason: sanitizeRouteReason(mcpCheck.reason),
      toolHint: mcpCheck.toolHint,
      params: mcpCheck.params,
    };
  }

  // D. Safe Fallback: when Router is not confident, route to Antigravity per policy
  // "7. ถ้า Router ไม่มั่นใจ ให้เลือก safe fallback = Antigravity หรือ Manual/Ask ตาม policy ห้ามเดา execution ที่เสี่ยง"
  return {
    requestedRoute: 'auto',
    resolvedRoute: 'antigravity',
    routeReason: 'Antigravity · ambiguous multi-step engineering work',
    toolHint: null,
    params: {},
  };
};
