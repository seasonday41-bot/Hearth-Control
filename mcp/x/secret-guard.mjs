/**
 * Pure, dependency-free content Secret Guard.
 *
 * Deliberately has zero imports and zero side effects so any Phase 5A
 * read-only module can use it without pulling in process or task lifecycle code.
 *
 * This is intentionally string-in/string-out with no knowledge of files,
 * tasks, or the network -- it only recognizes and masks secret-shaped text.
 */
export const redactSecretContent = (text) => {
  if (typeof text !== 'string') return '';
  return text
    // Bearer tokens
    .replace(/Bearer\s+[A-Za-z0-9_\-.]+/gi, 'Bearer [REDACTED]')
    // Google API keys (AIza...)
    .replace(/AIza[0-9A-Za-z\-_]{30,45}/g, '[REDACTED_API_KEY]')
    // PEM private key blocks
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
    // JSON credential-like fields: "password": "...", "token": "...", etc.
    .replace(/"(password|token|secret|access_token|client_secret|refresh_token|auth_token|api_key|apikey)"\s*:\s*"[^"]+"/gi, '"$1": "[REDACTED]"')
    // key=value / key: value credential assignments outside JSON
    .replace(/\b(?:api|secret)[-_]?key\s*[:=]\s*['"]?[A-Za-z0-9_\-]{16,}['"]?/gi, '[REDACTED_API_KEY]')
    // Common "sk-" style provider API key prefix
    .replace(/\bsk-[A-Za-z0-9]{20,}\b/g, '[REDACTED_API_KEY]')
    // Generic JWTs
    .replace(/eyJ[A-Za-z0-9\-_=]{10,}\.[A-Za-z0-9\-_=]{10,}\.?[A-Za-z0-9\-_.+/=]*/g, '[REDACTED_JWT]');
};
