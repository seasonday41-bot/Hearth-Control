import { redactSecretContent } from '../x/secret-guard.mjs';
import { isInvestCapability } from './capabilities.mjs';

export const XAU_RESEARCH_VERSION = 'xau-research-v1';

const BIAS = new Set(['bullish', 'bearish', 'neutral', 'mixed']);
const IMPACT = new Set(['low', 'medium', 'high']);
const FACT_TYPES = new Set(['fact', 'claim', 'interpretation']);
const HORIZONS = new Set(['intraday', 'swing', 'macro']);
const SOURCE_TYPES = new Set(['official', 'news', 'market_data', 'research', 'other']);
const CREDIBILITY = new Set(['primary', 'high', 'medium', 'unknown']);

const cleanText = (value, { required = false, max = 4000 } = {}) => {
  if (value == null) return required ? null : '';
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (required && !text) return null;
  if (text.length > max) return null;
  return redactSecretContent(text);
};

const validIso = (value) => {
  if (typeof value !== 'string' || !value.trim()) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
};

const plainObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const cleanUrl = (value) => {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
};

export const validateXauResearch = (input) => {
  const errors = [];
  if (!plainObject(input)) return { ok: false, errors: [{ path: '$', code: 'INVALID_TYPE' }] };

  const known = new Set(['version', 'symbol', 'generated_at', 'window', 'sources', 'items', 'macro']);
  for (const field of Object.keys(input)) if (!known.has(field)) errors.push({ path: field, code: 'UNKNOWN_FIELD' });

  if (input.version !== XAU_RESEARCH_VERSION) errors.push({ path: 'version', code: 'INVALID_VERSION' });
  if (String(input.symbol || '').toUpperCase().replace('/', '') !== 'XAUUSD') errors.push({ path: 'symbol', code: 'UNSUPPORTED_SYMBOL' });
  if (!validIso(input.generated_at)) errors.push({ path: 'generated_at', code: 'INVALID_ISO' });

  if (!plainObject(input.window)) {
    errors.push({ path: 'window', code: 'INVALID_TYPE' });
  } else {
    const knownWindow = new Set(['start', 'end']);
    for (const field of Object.keys(input.window)) if (!knownWindow.has(field)) errors.push({ path: `window.${field}`, code: 'UNKNOWN_FIELD' });
    if (!validIso(input.window.start)) errors.push({ path: 'window.start', code: 'INVALID_ISO' });
    if (!validIso(input.window.end)) errors.push({ path: 'window.end', code: 'INVALID_ISO' });
    if (validIso(input.window.start) && validIso(input.window.end) && input.window.start > input.window.end) {
      errors.push({ path: 'window', code: 'INVALID_RANGE' });
    }
  }

  const sourceIds = new Set();
  const sources = [];
  if (!Array.isArray(input.sources)) {
    errors.push({ path: 'sources', code: 'INVALID_TYPE' });
  } else if (input.sources.length > 200) {
    errors.push({ path: 'sources', code: 'OUT_OF_BOUNDS' });
  } else {
    input.sources.forEach((source, index) => {
      const path = `sources[${index}]`;
      if (!plainObject(source)) {
        errors.push({ path, code: 'INVALID_TYPE' });
        return;
      }
      const knownSource = new Set(['id', 'url', 'title', 'publisher', 'published_at', 'retrieved_at', 'source_type', 'credibility']);
      for (const field of Object.keys(source)) if (!knownSource.has(field)) errors.push({ path: `${path}.${field}`, code: 'UNKNOWN_FIELD' });
      const id = cleanText(source.id, { required: true, max: 128 });
      const url = cleanUrl(source.url);
      const title = cleanText(source.title, { required: true, max: 500 });
      const publisher = cleanText(source.publisher, { required: true, max: 200 });
      if (!id || sourceIds.has(id)) errors.push({ path: `${path}.id`, code: id ? 'DUPLICATE' : 'INVALID_VALUE' });
      if (!url) errors.push({ path: `${path}.url`, code: 'INVALID_URL' });
      if (!title) errors.push({ path: `${path}.title`, code: 'INVALID_VALUE' });
      if (!publisher) errors.push({ path: `${path}.publisher`, code: 'INVALID_VALUE' });
      if (!validIso(source.published_at)) errors.push({ path: `${path}.published_at`, code: 'INVALID_ISO' });
      if (!validIso(source.retrieved_at)) errors.push({ path: `${path}.retrieved_at`, code: 'INVALID_ISO' });
      if (!SOURCE_TYPES.has(source.source_type)) errors.push({ path: `${path}.source_type`, code: 'INVALID_VALUE' });
      if (!CREDIBILITY.has(source.credibility)) errors.push({ path: `${path}.credibility`, code: 'INVALID_VALUE' });
      if (id) sourceIds.add(id);
      sources.push({
        id: id || '',
        url: url || '',
        title: title || '',
        publisher: publisher || '',
        published_at: source.published_at,
        retrieved_at: source.retrieved_at,
        source_type: source.source_type,
        credibility: source.credibility,
      });
    });
  }

  const items = [];
  if (!Array.isArray(input.items)) {
    errors.push({ path: 'items', code: 'INVALID_TYPE' });
  } else if (input.items.length > 200) {
    errors.push({ path: 'items', code: 'OUT_OF_BOUNDS' });
  } else {
    const itemIds = new Set();
    input.items.forEach((item, index) => {
      const path = `items[${index}]`;
      if (!plainObject(item)) {
        errors.push({ path, code: 'INVALID_TYPE' });
        return;
      }
      const knownItem = new Set(['id', 'capability', 'topic', 'summary', 'fact_type', 'bias', 'impact', 'horizon', 'source_ids']);
      for (const field of Object.keys(item)) if (!knownItem.has(field)) errors.push({ path: `${path}.${field}`, code: 'UNKNOWN_FIELD' });
      const id = cleanText(item.id, { required: true, max: 128 });
      const topic = cleanText(item.topic, { required: true, max: 200 });
      const summary = cleanText(item.summary, { required: true, max: 2000 });
      if (!id || itemIds.has(id)) errors.push({ path: `${path}.id`, code: id ? 'DUPLICATE' : 'INVALID_VALUE' });
      if (!isInvestCapability(item.capability)) errors.push({ path: `${path}.capability`, code: 'INVALID_VALUE' });
      if (!topic) errors.push({ path: `${path}.topic`, code: 'INVALID_VALUE' });
      if (!summary) errors.push({ path: `${path}.summary`, code: 'INVALID_VALUE' });
      if (!FACT_TYPES.has(item.fact_type)) errors.push({ path: `${path}.fact_type`, code: 'INVALID_VALUE' });
      if (!BIAS.has(item.bias)) errors.push({ path: `${path}.bias`, code: 'INVALID_VALUE' });
      if (!IMPACT.has(item.impact)) errors.push({ path: `${path}.impact`, code: 'INVALID_VALUE' });
      if (!HORIZONS.has(item.horizon)) errors.push({ path: `${path}.horizon`, code: 'INVALID_VALUE' });
      if (!Array.isArray(item.source_ids) || item.source_ids.length === 0) {
        errors.push({ path: `${path}.source_ids`, code: 'REQUIRED' });
      } else {
        for (const sourceId of item.source_ids) if (!sourceIds.has(sourceId)) errors.push({ path: `${path}.source_ids`, code: 'UNKNOWN_SOURCE' });
      }
      if (id) itemIds.add(id);
      items.push({
        id: id || '',
        capability: item.capability,
        topic: topic || '',
        summary: summary || '',
        fact_type: item.fact_type,
        bias: item.bias,
        impact: item.impact,
        horizon: item.horizon,
        source_ids: Array.isArray(item.source_ids) ? [...item.source_ids] : [],
      });
    });
  }

  const macro = [];
  if (!Array.isArray(input.macro)) {
    errors.push({ path: 'macro', code: 'INVALID_TYPE' });
  } else if (input.macro.length > 100) {
    errors.push({ path: 'macro', code: 'OUT_OF_BOUNDS' });
  } else {
    input.macro.forEach((item, index) => {
      const path = `macro[${index}]`;
      if (!plainObject(item)) {
        errors.push({ path, code: 'INVALID_TYPE' });
        return;
      }
      const knownMacro = new Set(['name', 'value', 'previous', 'unit', 'observed_at', 'source_ids']);
      for (const field of Object.keys(item)) if (!knownMacro.has(field)) errors.push({ path: `${path}.${field}`, code: 'UNKNOWN_FIELD' });
      const name = cleanText(item.name, { required: true, max: 120 });
      const unit = cleanText(item.unit, { required: true, max: 40 });
      if (!name) errors.push({ path: `${path}.name`, code: 'INVALID_VALUE' });
      if (!Number.isFinite(item.value)) errors.push({ path: `${path}.value`, code: 'INVALID_NUMBER' });
      if (item.previous != null && !Number.isFinite(item.previous)) errors.push({ path: `${path}.previous`, code: 'INVALID_NUMBER' });
      if (!unit) errors.push({ path: `${path}.unit`, code: 'INVALID_VALUE' });
      if (!validIso(item.observed_at)) errors.push({ path: `${path}.observed_at`, code: 'INVALID_ISO' });
      if (!Array.isArray(item.source_ids) || item.source_ids.length === 0) errors.push({ path: `${path}.source_ids`, code: 'REQUIRED' });
      else for (const sourceId of item.source_ids) if (!sourceIds.has(sourceId)) errors.push({ path: `${path}.source_ids`, code: 'UNKNOWN_SOURCE' });
      macro.push({
        name: name || '',
        value: item.value,
        previous: item.previous ?? null,
        unit: unit || '',
        observed_at: item.observed_at,
        source_ids: Array.isArray(item.source_ids) ? [...item.source_ids] : [],
      });
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      version: XAU_RESEARCH_VERSION,
      symbol: 'XAUUSD',
      generated_at: input.generated_at,
      window: { start: input.window.start, end: input.window.end },
      sources,
      items,
      macro,
    },
  };
};

export const parseXauResearch = (input) => {
  const result = validateXauResearch(input);
  if (!result.ok) {
    const error = new Error(`Invalid ${XAU_RESEARCH_VERSION}: ${result.errors.map((item) => item.path).join(', ')}`);
    error.code = 'INVALID_XAU_RESEARCH';
    error.errors = result.errors;
    throw error;
  }
  return result.value;
};
