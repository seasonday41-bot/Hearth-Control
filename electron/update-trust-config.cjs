// Production-only trust authority for Hearth P2 remote updates.
// This module is main-process configuration. Renderer/MCP/Goal/X input must
// never override these values. Only PUBLIC verification material belongs here.

const RELEASE_OWNER = 'seasonday41-bot';
const RELEASE_REPOSITORY = 'Hearth-Control-Releases';
const RELEASE_REPOSITORY_URL = 'https://github.com/seasonday41-bot/Hearth-Control-Releases';
const MANIFEST_URL = 'https://github.com/seasonday41-bot/Hearth-Control-Releases/releases/latest/download/manifest.json';
const ARTIFACT_BASE_URL = 'https://github.com/seasonday41-bot/Hearth-Control-Releases/releases/latest/download/';

const SIGNING_KEY_ID = 'hearth-release-2026-01';
const TRUSTED_SIGNING_KEYS = Object.freeze({
  [SIGNING_KEY_ID]: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA1LzV11xeAgKlO+Z6s+Agh4gcAffL/evUKmcuuu6Qfq0=
-----END PUBLIC KEY-----`,
});

// Exact origins only. GitHub release assets currently redirect from github.com
// to release-assets.githubusercontent.com. No wildcard githubusercontent trust.
const TRUSTED_DELIVERY_ORIGINS = Object.freeze([
  'https://github.com',
  'https://release-assets.githubusercontent.com',
]);

module.exports = Object.freeze({
  RELEASE_OWNER,
  RELEASE_REPOSITORY,
  RELEASE_REPOSITORY_URL,
  MANIFEST_URL,
  ARTIFACT_BASE_URL,
  SIGNING_KEY_ID,
  TRUSTED_SIGNING_KEYS,
  TRUSTED_DELIVERY_ORIGINS,
});
