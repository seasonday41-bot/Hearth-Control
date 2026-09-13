const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export const authoritativeLocalFacts = ({ version, buildId, model, profile, localEndpoint, gateway } = {}) => {
  let localOllamaEndpoint = null;
  try {
    const endpoint = new URL(localEndpoint);
    if (LOCAL_HOSTS.has(endpoint.hostname) && ['http:', 'https:'].includes(endpoint.protocol)) localOllamaEndpoint = endpoint.origin;
  } catch {}
  return Object.freeze({
    version: typeof version === 'string' && version.trim() ? version.trim() : null,
    buildId: typeof buildId === 'string' && buildId.trim() ? buildId.trim() : null,
    provider: 'ollama',
    localOllamaEndpoint,
    model: typeof model === 'string' && model.trim() ? model.trim() : null,
    profile: typeof profile === 'string' && profile.trim() ? profile.trim() : null,
    streaming: true,
    stop: true,
    contextBuilder: true,
    storageAuditReadOnly: true,
    readOnlyWorkspaceSkills: gateway ? ['repo_list', 'repo_read_file', 'file_search', 'git_inspect'] : [],
    globalRetentionPolicy: 'unknown',
    allHearthDataLocal: 'unknown',
    allFeaturesOffline: 'unknown',
    trainingPrivacyGuarantee: 'unknown',
  });
};

export const groundingMode = (prompt = '') => {
  const text = String(prompt);
  if (/(?:รัน|ทดสอบ|\b(?:run|execute)\b)/i.test(text) && /(?:test|ทดสอบ|suite|regression|เช็ก|ตรวจ)/i.test(text)) return 'test';
  if (/(?:branch|working tree|git|commit|สาขา)/i.test(text) && /(?:what|am i on|อะไร|ไหน|status|สถานะ|clean|current|ตอนนี้|show|ดู)/i.test(text)) return 'git';
  if (/(?:inspect|search|find|ไฟล์ไหน|ดูโค้ด|หา logic|ค้น.*(?:ไฟล์|โค้ด)|source|code|repository|repo|where.*(?:file|logic|calculated|computed|implemented|defined|come from)|which (?:file|symbol|logic)|trace|ดูหน่อย)/i.test(text)) {
    return /(?:UI|display|render|output|summary|count|areas?|หน้าจอ|แสดง|จำนวน|นับ|คำนวณ|สรุป)/i.test(text) ? 'ui' : 'repo';
  }
  if (/(?:Local Chat|Local AI|Hearth|Ollama|ฮาร์ธ|โลคอลแชต|โลคอลเอไอ)/i.test(text) && /(?:คืออะไร|อธิบาย|explain|privacy|offline|ข้อมูล|version|เวอร์ชัน|ปลอดภัย|ส่วนตัว|ทำอะไรได้|capabilit|feature|internet|local|เซิร์ฟเวอร์|อินเทอร์เน็ต|เครื่อง)/i.test(text)) return 'product';
  if (/(?:ทำงาน\s*offline\s*ไหม|ข้อมูลออกจากเครื่องไหม|ข้อมูล.*(?:ส่วนตัว|ปลอดภัย)|ไม่ต้อง.*อินเทอร์เน็ต|privacy|retention|training)/i.test(text)) return 'product';
  return 'conversation';
};

const UNKNOWN_PRODUCT_FACT_IDS = Object.freeze([
  'ALL_DATA_STAYS_LOCAL', 'NO_EXTERNAL_CONNECTIONS', 'FULL_OFFLINE_OPERATION',
  'PRIVACY_GUARANTEE', 'RETENTION_POLICY', 'TRAINING_POLICY', 'ALL_PROCESSING_LOCAL',
]);

export const createProductFactPacket = (facts) => Object.freeze({
  available: Object.freeze({
    LOCAL_CHAT_AVAILABLE: true,
    ...(facts.version ? { HEARTH_VERSION: facts.version } : {}),
    ...(facts.buildId ? { HEARTH_BUILD: facts.buildId } : {}),
    LOCAL_PROVIDER: facts.provider,
    ...(facts.model ? { LOCAL_MODEL: facts.model } : {}),
    ...(facts.profile ? { LOCAL_PROFILE: facts.profile } : {}),
    ...(facts.localOllamaEndpoint ? { OLLAMA_ENDPOINT: facts.localOllamaEndpoint, OLLAMA_ENDPOINT_IS_LOOPBACK: true } : {}),
    STREAMING_AVAILABLE: facts.streaming,
    STOP_AVAILABLE: facts.stop,
    CONTEXT_BUILDER_AVAILABLE: facts.contextBuilder,
    ...(facts.readOnlyWorkspaceSkills.length ? { WORKSPACE_READONLY_SKILLS_AVAILABLE: facts.readOnlyWorkspaceSkills } : {}),
    STORAGE_AUDIT_READONLY: facts.storageAuditReadOnly,
  }),
  unknown: UNKNOWN_PRODUCT_FACT_IDS,
});

// Model prose is never displayed in product fact mode. Only a strict list of
// known IDs may select sentences from Hearth-owned, localized templates.
export const validateProductClaims = (response, packet) => {
  let parsed;
  try { parsed = JSON.parse(String(response || '')); } catch { return { ok: false, reason: 'invalid_fact_contract' }; }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' || Object.keys(parsed).length !== 1 || !Array.isArray(parsed.claims) || parsed.claims.length === 0 || parsed.claims.length > 12) return { ok: false, reason: 'invalid_fact_contract' };
  const factIds = [];
  for (const claim of parsed.claims) {
    if (!claim || Array.isArray(claim) || Object.keys(claim).length !== 1 || typeof claim.factId !== 'string' || !Object.hasOwn(packet.available, claim.factId) || packet.available[claim.factId] == null || packet.available[claim.factId] === false) return { ok: false, reason: 'unavailable_fact_id' };
    if (!factIds.includes(claim.factId)) factIds.push(claim.factId);
  }
  return { ok: true, factIds };
};

export const renderProductFacts = (packet, factIds, prompt = '') => {
  const thai = /[\u0E00-\u0E7F]/u.test(prompt);
  const selected = new Set(factIds);
  const value = packet.available;
  const lines = [];
  if (selected.has('LOCAL_CHAT_AVAILABLE')) lines.push(thai ? 'Local Chat คือช่องสนทนาใน Hearth' : 'Local Chat is a conversation feature in Hearth.');
  if (selected.has('HEARTH_VERSION')) lines.push(thai ? `Hearth เวอร์ชัน ${value.HEARTH_VERSION}` : `Hearth version: ${value.HEARTH_VERSION}.`);
  if (selected.has('HEARTH_BUILD')) lines.push(thai ? `บิลด์ ${value.HEARTH_BUILD}` : `Build: ${value.HEARTH_BUILD}.`);
  if (selected.has('LOCAL_PROVIDER')) lines.push(thai ? `ผู้ให้บริการที่เลือกคือ ${value.LOCAL_PROVIDER}` : `The selected provider is ${value.LOCAL_PROVIDER}.`);
  if (selected.has('LOCAL_MODEL')) lines.push(thai ? `โมเดลที่เลือกคือ ${value.LOCAL_MODEL}` : `The selected model is ${value.LOCAL_MODEL}.`);
  if (selected.has('LOCAL_PROFILE')) lines.push(thai ? `โหมดที่เลือกคือ ${value.LOCAL_PROFILE}` : `The selected mode is ${value.LOCAL_PROFILE}.`);
  if (selected.has('OLLAMA_ENDPOINT') || selected.has('OLLAMA_ENDPOINT_IS_LOOPBACK')) lines.push(thai ? `Ollama endpoint สำหรับแชตนี้คือ ${value.OLLAMA_ENDPOINT} ซึ่งเป็น loopback` : `The Ollama endpoint for this chat is ${value.OLLAMA_ENDPOINT}, a loopback address.`);
  if (selected.has('STREAMING_AVAILABLE')) lines.push(thai ? 'Local Chat รองรับการแสดงคำตอบแบบ streaming' : 'Local Chat supports streaming responses.');
  if (selected.has('STOP_AVAILABLE')) lines.push(thai ? 'Local Chat มีปุ่ม Stop' : 'Local Chat has a Stop control.');
  if (selected.has('CONTEXT_BUILDER_AVAILABLE')) lines.push(thai ? 'มี Context Builder สำหรับบริบทของแชต' : 'A Context Builder supplies chat context.');
  if (selected.has('WORKSPACE_READONLY_SKILLS_AVAILABLE')) lines.push(thai ? 'มีทักษะอ่านข้อมูลใน workspace ที่เลือก โดยไม่แก้ไฟล์' : 'Read-only skills can inspect the selected workspace.');
  if (selected.has('STORAGE_AUDIT_READONLY')) lines.push(thai ? 'Storage Audit ใช้ตรวจข้อมูลแบบอ่านอย่างเดียว' : 'Storage Audit is read-only.');
  lines.push(thai ? 'ข้อมูล runtime นี้ยังไม่ยืนยันนโยบายการเก็บข้อมูล ความเป็นส่วนตัว หรือการทำงานออฟไลน์ของ Hearth ทั้งแอป' : 'This runtime information does not establish Hearth-wide retention, privacy, or offline guarantees.');
  return lines.join(thai ? '\n' : ' ');
};

export const safeGroundingResponse = (mode, facts, prompt = '') => {
  const thai = /[\u0E00-\u0E7F]/u.test(prompt);
  if (mode === 'product') {
    const packet = createProductFactPacket(facts);
    return renderProductFacts(packet, Object.keys(packet.available), prompt);
  }
  return thai ? 'หลักฐานจากการตรวจที่ทำได้ยังไม่ครบพอจะยืนยันคำตอบ ต้องตรวจเส้นทางข้อมูลเพิ่มเติม' : 'The inspected evidence is incomplete; more read-only inspection is needed before confirming the answer.';
};

export const createEvidenceTrace = (prompt, mode) => {
  const records = [];
  const add = (tool, args, result) => {
    if (!result?.ok || !result.result || result.result.protected || result.result.skipped) return;
    if (tool === 'file_search') {
      for (const match of result.result.matches || []) if (typeof match.path === 'string' && Number.isInteger(match.line)) records.push({ tool, path: match.path, line: match.line, query: String(args?.query || ''), stage: /^scripts\/test-|\.test\.|\.spec\./i.test(match.path) ? 'TEST_EVIDENCE' : 'SOURCE', excerpt: String(match.excerpt || '') });
    } else if (tool === 'repo_read_file' && !result.result.partial) {
      const file = result.result;
      if (typeof file.path !== 'string' || typeof file.content !== 'string') return;
      for (const row of file.content.split('\n').slice(0, 8000)) {
        const match = /^(\d+): (.*)$/.exec(row);
        if (!match) continue;
        const line = match[2];
        if (!line.trim()) continue;
        const isTest = /^scripts\/test-|\.test\.|\.spec\./i.test(file.path);
        const stage = isTest ? 'TEST_EVIDENCE' : /<\w[^>]*>|<\/[a-z]/i.test(line) && /(?:\{[^}]+\}|partial|count|total|summary)/i.test(line) ? 'OUTPUT'
          : /(?:filter\s*\(|reduce\s*\(|group|Object\.fromEntries|total|count|summary)/i.test(line) ? 'TRANSFORM' : 'SOURCE';
        records.push({ tool, path: file.path, line: Number(match[1]), stage, excerpt: line.slice(0, 240) });
      }
    } else if (tool === 'git_inspect') records.push({ tool, operation: result.result.operation, stage: 'OUTPUT', excerpt: String(result.result.output || '').slice(0, 200) });
  };
  const check = (response) => {
    if (mode === 'conversation' || mode === 'product') return { ok: true, reason: null, records };
    if (mode === 'git') {
      const inspected = records.filter((item) => item.tool === 'git_inspect');
      const identity = inspected.filter((item) => ['branch', 'head'].includes(item.operation));
      const ok = inspected.length > 0 && (identity.length === 0 || identity.some((item) => item.excerpt && String(response).includes(item.excerpt)));
      return { ok, reason: ok ? null : 'git_evidence_missing', records };
    }
    const citations = [...String(response || '').matchAll(/(?:^|[\s([`])([\w.-]+(?:\/[\w.-]+)*):([1-9]\d*)(?:\b|$)/gm)].map((match) => ({ path: match[1], line: Number(match[2]) }));
    if (citations.length === 0) return { ok: false, reason: 'citation_missing', records };
    if (citations.some((citation) => !records.some((item) => item.path === citation.path && item.line === citation.line))) return { ok: false, reason: 'citation_unverified', records };
    if (!citations.some((citation) => records.some((item) => item.path === citation.path && item.line === citation.line && item.tool === 'repo_read_file'))) return { ok: false, reason: 'source_not_read', records };
    if (mode === 'ui') {
      const cited = (stage) => citations.some((citation) => records.some((item) => item.tool === 'repo_read_file' && item.path === citation.path && item.line === citation.line && item.stage === stage));
      const source = records.some((item) => item.stage === 'SOURCE');
      const linked = citations.some((transform) => citations.some((output) => {
        const from = records.find((item) => item.tool === 'repo_read_file' && item.path === transform.path && item.line === transform.line && item.stage === 'TRANSFORM');
        const to = records.find((item) => item.tool === 'repo_read_file' && item.path === output.path && item.line === output.line && item.stage === 'OUTPUT');
        if (!from || !to || from.path !== to.path) return false;
        const identifiers = [...(from.excerpt.match(/[A-Za-z_][A-Za-z_0-9]{3,}/g) || [])].map((value) => value.toLowerCase());
        return identifiers.some((identifier) => !['const', 'return', 'filter', 'category', 'items', 'length', 'class', 'name'].includes(identifier) && new RegExp(`\\b${identifier}\\b`, 'i').test(to.excerpt));
      }));
      if (!source || !cited('TRANSFORM') || !cited('OUTPUT') || !linked) return { ok: false, reason: 'ui_trace_incomplete', records };
      const outputText = citations.flatMap((citation) => records.filter((item) => item.tool === 'repo_read_file' && item.path === citation.path && item.line === citation.line && item.stage === 'OUTPUT').map((item) => item.excerpt)).join(' ');
      const transformText = citations.flatMap((citation) => records.filter((item) => item.tool === 'repo_read_file' && item.path === citation.path && item.line === citation.line && item.stage === 'TRANSFORM').map((item) => item.excerpt)).join(' ');
      const unsupportedAlias = records.some((item) => {
        if (item.stage !== 'SOURCE' || !citations.some((citation) => citation.path === item.path && citation.line === item.line)) return false;
        return (item.excerpt.match(/[A-Za-z_][A-Za-z_0-9]{3,}/g) || []).some((symbol) => {
          if (new RegExp(`\\b${symbol}\\b`, 'i').test(`${outputText} ${transformText}`)) return false;
          return new RegExp(`\\b${symbol}\\b\\s+(?:is|equals|represents|calculates|produces)\\s+(?!not\\b)[^.!?]{0,80}\\b(?:count|summary|areas?)\\b`, 'i').test(response);
        });
      });
      if (unsupportedAlias) return { ok: false, reason: 'unsupported_semantic_match', records };
    }
    return { ok: true, reason: null, records };
  };
  return { records, add, check };
};
