const GDELT_ORIGIN = 'https://api.gdeltproject.org';
const FED_ORIGIN = 'https://www.federalreserve.gov';
const BLS_ORIGIN = 'https://www.bls.gov';
const FED_MONETARY_RSS = `${FED_ORIGIN}/feeds/press_monetary.xml`;
const BLS_LATEST_RSS = `${BLS_ORIGIN}/feed/bls_latest.rss`;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const stripTags = (value) => String(value || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'")
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/\s+/g, ' ')
  .trim();

const toIso = (value) => {
  const text = String(value || '').trim();
  if (!text) return null;
  const gdelt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(text);
  if (gdelt) {
    const [, y, m, d, hh, mm, ss] = gdelt;
    return new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}.000Z`).toISOString();
  }
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

const delay = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(new Error('market_search_cancelled'));
    return;
  }
  const timer = setTimeout(resolve, ms);
  const onAbort = () => {
    clearTimeout(timer);
    reject(new Error('market_search_cancelled'));
  };
  signal?.addEventListener('abort', onAbort, { once: true });
});

const readBoundedText = async (response) => {
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('market_search_response_too_large');
  return text;
};

const fetchText = async (fetchFn, url, { signal, timeoutMs = 15_000, retries = 1 } = {}) => {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const response = await fetchFn(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json, application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.1',
          'User-Agent': 'Hearth-Control-Market/1.0',
        },
        redirect: 'error',
        signal: controller.signal,
      });
      if (response.ok) return await readBoundedText(response);
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= retries) throw new Error(`market_search_http_${response.status}`);
      const retryAfter = Number(response.headers.get('retry-after'));
      await delay(Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, 5000) : 750 * (attempt + 1), signal);
    } catch (error) {
      if (signal?.aborted) throw new Error('market_search_cancelled');
      if (error?.name === 'AbortError') lastError = new Error('market_search_timeout');
      else lastError = error;
      if (attempt >= retries || /market_search_http_(?!429|5\d\d)/.test(String(error?.message || ''))) throw lastError;
      await delay(750 * (attempt + 1), signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  throw lastError || new Error('market_search_failed');
};

const parseGdelt = (payload, retrievedAt) => {
  if (!payload || typeof payload !== 'object') throw new Error('gdelt_malformed_response');
  const articles = Array.isArray(payload.articles) ? payload.articles : [];
  return articles.map((article) => {
    const url = typeof article?.url === 'string' ? article.url.trim() : '';
    let parsed;
    try { parsed = new URL(url); } catch { return null; }
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    const title = stripTags(article?.title).slice(0, 500);
    if (!title) return null;
    return {
      title,
      url: parsed.toString(),
      publisher: String(article?.domain || parsed.hostname || 'Unknown').slice(0, 200),
      published_at: toIso(article?.seendate) || retrievedAt,
      retrieved_at: retrievedAt,
      snippet: '',
    };
  }).filter(Boolean);
};

const xmlValue = (block, tag) => {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(block);
  return match ? stripTags(match[1]) : '';
};

const parseRss = (xml, retrievedAt, { origin, publisher, maxItems = 20 } = {}) => {
  const rows = [];
  const items = String(xml || '').match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || [];
  for (const item of items.slice(0, maxItems)) {
    const title = xmlValue(item, 'title').slice(0, 500);
    const link = xmlValue(item, 'link');
    const published = toIso(xmlValue(item, 'pubDate')) || retrievedAt;
    const snippet = xmlValue(item, 'description').slice(0, 1200);
    let parsed;
    try { parsed = new URL(link); } catch { continue; }
    if (origin && parsed.origin !== origin) continue;
    if (!title) continue;
    rows.push({
      title,
      url: parsed.toString(),
      publisher,
      published_at: published,
      retrieved_at: retrievedAt,
      snippet,
    });
  }
  return rows;
};

const topicForText = (row) => {
  const text = `${row.title} ${row.snippet}`.toLowerCase();
  if (/\b(fomc|federal reserve|fed |interest rate|policy rate|powell|warsh)\b/.test(text)) return 'fed_rates';
  if (/\b(cpi|pce|inflation|payroll|nonfarm|employment|unemployment|jobs report|labor market)\b/.test(text)) return 'us_macro';
  if (/\b(dxy|dollar index|u\.s\. dollar|treasury|yield|real yield|bond yield)\b/.test(text)) return 'dollar_yields';
  if (/\b(positioning|sentiment|etf flow|fund flow|speculative|commitment of traders|cot)\b/.test(text)) return 'sentiment';
  if (/\b(war|conflict|geopolit|sanction|crisis|attack|invasion|ceasefire)\b/.test(text)) return 'global_risk';
  return 'gold_market';
};

const dedupeAndLimit = (rows, limitPerTopic) => {
  const seen = new Set();
  const counts = new Map();
  const result = [];
  for (const row of rows) {
    const key = `${row.topic_id}\0${row.url}`;
    if (seen.has(key)) continue;
    const count = counts.get(row.topic_id) || 0;
    if (count >= limitPerTopic) continue;
    seen.add(key);
    counts.set(row.topic_id, count + 1);
    result.push(row);
  }
  return result;
};

export class PublicMarketSearchProvider {
  constructor({ fetchFn = globalThis.fetch, gdeltTimespan = '2d' } = {}) {
    if (typeof fetchFn !== 'function') throw new TypeError('PublicMarketSearchProvider requires fetch');
    this.fetchFn = fetchFn;
    this.gdeltTimespan = gdeltTimespan;
  }

  async fetchGdelt(query, limit, signal) {
    const retrievedAt = new Date().toISOString();
    const url = new URL('/api/v2/doc/doc', GDELT_ORIGIN);
    url.searchParams.set('query', query);
    url.searchParams.set('mode', 'ArtList');
    url.searchParams.set('format', 'json');
    url.searchParams.set('maxrecords', String(Math.max(1, Math.min(50, limit))));
    url.searchParams.set('sort', 'HybridRel');
    url.searchParams.set('timespan', this.gdeltTimespan);
    const text = await fetchText(this.fetchFn, url.toString(), { signal, retries: 1 });
    let payload;
    try { payload = JSON.parse(text); }
    catch { throw new Error('gdelt_invalid_json'); }
    return parseGdelt(payload, retrievedAt);
  }

  async fetchFed(signal) {
    const retrievedAt = new Date().toISOString();
    const feed = await fetchText(this.fetchFn, FED_MONETARY_RSS, { signal, retries: 1 });
    return parseRss(feed, retrievedAt, {
      origin: FED_ORIGIN,
      publisher: 'Federal Reserve Board',
      maxItems: 20,
    });
  }

  async fetchBls(signal) {
    const retrievedAt = new Date().toISOString();
    const feed = await fetchText(this.fetchFn, BLS_LATEST_RSS, { signal, retries: 1 });
    return parseRss(feed, retrievedAt, {
      origin: BLS_ORIGIN,
      publisher: 'U.S. Bureau of Labor Statistics',
      maxItems: 20,
    });
  }

  async searchBatch({ topics = [], limitPerTopic = 6, signal } = {}) {
    const boundedLimit = Math.max(1, Math.min(12, Number(limitPerTopic) || 6));
    const rows = [];

    try {
      const gdelt = await this.fetchGdelt(
        'gold OR XAUUSD OR "Federal Reserve" OR inflation OR "Treasury yield" OR DXY OR geopolitical',
        Math.min(50, Math.max(18, boundedLimit * 6)),
        signal,
      );
      rows.push(...gdelt.map((row) => ({ ...row, topic_id: topicForText(row) })));
    } catch (error) {
      if (/cancelled/.test(String(error?.message || ''))) throw error;
    }

    try {
      const fed = await this.fetchFed(signal);
      rows.push(...fed.map((row) => ({ ...row, topic_id: 'fed_rates' })));
    } catch (error) {
      if (/cancelled/.test(String(error?.message || ''))) throw error;
    }

    try {
      const bls = await this.fetchBls(signal);
      rows.push(...bls.map((row) => ({ ...row, topic_id: 'us_macro' })));
    } catch (error) {
      if (/cancelled/.test(String(error?.message || ''))) throw error;
    }

    const allowedTopics = new Set(topics.map((topic) => topic.id));
    const filtered = rows.filter((row) => allowedTopics.size === 0 || allowedTopics.has(row.topic_id));
    return dedupeAndLimit(filtered, boundedLimit);
  }

  async search({ query, topicId, limit = 6, signal } = {}) {
    const cleanQuery = String(query || '').trim();
    if (!cleanQuery) throw new Error('market_search_query_required');
    const boundedLimit = Math.max(1, Math.min(12, Number(limit) || 6));
    const rows = [];

    try {
      rows.push(...await this.fetchGdelt(cleanQuery, boundedLimit, signal));
    } catch (error) {
      if (/cancelled/.test(String(error?.message || ''))) throw error;
    }

    if (topicId === 'fed_rates') {
      try { rows.unshift(...await this.fetchFed(signal)); }
      catch (error) { if (/cancelled/.test(String(error?.message || ''))) throw error; }
    }
    if (topicId === 'us_macro') {
      try { rows.unshift(...await this.fetchBls(signal)); }
      catch (error) { if (/cancelled/.test(String(error?.message || ''))) throw error; }
    }

    return dedupeAndLimit(rows.map((row) => ({ ...row, topic_id: topicId })), boundedLimit)
      .map(({ topic_id, ...row }) => row);
  }
}

export const createPublicMarketSearchProvider = (options = {}) => new PublicMarketSearchProvider(options);
export const MARKET_SEARCH_FIXED_ORIGINS = Object.freeze([GDELT_ORIGIN, FED_ORIGIN, BLS_ORIGIN]);
