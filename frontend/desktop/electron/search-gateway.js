/**
 * Main-process transport for the unified content search API.
 *
 * Packaged desktop builds load the renderer through `loadFile`, so the page
 * origin serializes as `null` and the public search service's browser-origin
 * allowlist rejects the preflight. Sending the request from the main process
 * keeps it out of the Chromium network stack entirely: CORS never applies, and
 * `net.fetch` behaves the same in development and in packaged builds.
 */
export const DESKTOP_SEARCH_CHANNEL = 'jojo-search:query';
export const DEFAULT_SEARCH_ORIGIN = 'https://s1.jojokanbao.cn';

const TRUSTED_SEARCH_ORIGINS = new Set([DEFAULT_SEARCH_ORIGIN]);
const SEARCH_TIMEOUT_MS = 15000;
const MAX_BODY_BYTES = 8 * 1024;
const MAX_QUERY_LENGTH = 200;
const MAX_PAGE = 1000;
const MAX_SIZE = 50;
const MAX_LIST_ITEMS = 64;
const MAX_LIST_ITEM_LENGTH = 200;
const MAX_SORT_LENGTH = 32;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validates a renderer payload down to the fields the search API accepts, so a
 * compromised renderer cannot smuggle arbitrary keys through the transport.
 * Returns null when anything is out of range.
 */
export function normalizeDesktopSearchPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

  const query = typeof payload.query === 'string' ? payload.query.trim() : '';
  if (!query || query.length > MAX_QUERY_LENGTH) return null;
  const body = { query };

  if (payload.page !== undefined) {
    if (!Number.isInteger(payload.page) || payload.page < 1 || payload.page > MAX_PAGE) return null;
    body.page = payload.page;
  }
  if (payload.size !== undefined) {
    if (!Number.isInteger(payload.size) || payload.size < 1 || payload.size > MAX_SIZE) return null;
    body.size = payload.size;
  }
  if (payload.sort !== undefined) {
    if (typeof payload.sort !== 'string' || !payload.sort || payload.sort.length > MAX_SORT_LENGTH) return null;
    body.sort = payload.sort;
  }
  for (const name of ['startDate', 'endDate']) {
    const value = payload[name];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return null;
    body[name] = value;
  }
  for (const name of ['types', 'datasetIds', 'sources']) {
    const value = payload[name];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) return null;
    const items = value.map((item) => (typeof item === 'string' ? item.trim() : ''));
    if (items.some((item) => !item || item.length > MAX_LIST_ITEM_LENGTH)) return null;
    body[name] = items;
  }

  if (JSON.stringify(body).length > MAX_BODY_BYTES) return null;
  return body;
}

export function resolveDesktopSearchOrigin(configuredOrigin, isPackaged) {
  if (!configuredOrigin?.trim()) return DEFAULT_SEARCH_ORIGIN;
  try {
    const candidate = new URL(configuredOrigin.trim());
    const loopback = ['127.0.0.1', '::1', 'localhost'].includes(candidate.hostname);
    if (!isPackaged && candidate.protocol === 'http:' && loopback) return candidate.origin;
    if (candidate.protocol === 'https:' && TRUSTED_SEARCH_ORIGINS.has(candidate.origin)) {
      return candidate.origin;
    }
  } catch {
    // Invalid and unsafe overrides fall back to the public search service.
  }
  return DEFAULT_SEARCH_ORIGIN;
}

export async function handleDesktopSearchRequest(payload, { fetch, searchOrigin }) {
  const body = normalizeDesktopSearchPayload(payload);
  if (!body) return { ok: false, status: 400, error: '搜索请求无效' };

  try {
    const upstream = await fetch(new URL('/content/search', searchOrigin), {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    const contentType = upstream.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.includes('application/json')) {
      await upstream.body?.cancel().catch(() => undefined);
      return { ok: false, status: 502, error: '搜索服务入口返回了无效响应' };
    }
    if (!upstream.ok) {
      await upstream.body?.cancel().catch(() => undefined);
      return { ok: false, status: upstream.status, error: '搜索服务返回了异常状态' };
    }
    return { ok: true, status: upstream.status, data: await upstream.json() };
  } catch {
    return { ok: false, status: 502, error: '搜索服务暂时不可用' };
  }
}
