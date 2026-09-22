/** Redact credentials from persisted task evidence and user-visible diagnostics. */
export const redactSecrets = (text) => {
  if (typeof text !== 'string') return '';
  return text
    .replace(/Bearer\s+[A-Za-z0-9_\-\.]+/gi, 'Bearer [REDACTED]')
    .replace(/AIza[0-9A-Za-z-_]{30,45}/g, '[REDACTED_API_KEY]')
    .replace(/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
    .replace(/"(password|token|secret|access_token|client_secret|refresh_token|auth_token)"\s*:\s*"[^"]+"/gi, '"$1": "[REDACTED]"')
    .replace(/([A-Z][A-Z0-9_]*_(?:CSRF_TOKEN|SIDECAR_UI_TOKEN)\s*=\s*)[^\s]+/gi, '$1[REDACTED]')
    .replace(/eyJ[A-Za-z0-9-_=]{10,}\.[A-Za-z0-9-_=]{10,}\.?[A-Za-z0-9-_.+/=]*/g, '[REDACTED_JWT]');
};
