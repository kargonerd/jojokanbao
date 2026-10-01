// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SEARCH_ORIGIN,
  handleDesktopSearchRequest,
  normalizeDesktopSearchPayload,
  resolveDesktopSearchOrigin,
} from '../../electron/search-gateway.js';

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('desktop search gateway', () => {
  it('relays a validated payload to the unified search endpoint', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ data: { total: 3, results: [] } }));
    const result = await handleDesktopSearchRequest(
      { query: '大寨', page: 2, size: 20, types: ['book'], sources: ['陈永贵传'] },
      { fetch, searchOrigin: DEFAULT_SEARCH_ORIGIN },
    );

    expect(String(fetch.mock.calls[0]![0])).toBe('https://s1.jojokanbao.cn/content/search');
    const init = fetch.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({
      query: '大寨',
      page: 2,
      size: 20,
      types: ['book'],
      sources: ['陈永贵传'],
    });
    expect(result).toEqual({ ok: true, status: 200, data: { data: { total: 3, results: [] } } });
  });

  it('drops unknown keys so the renderer cannot smuggle arbitrary fields', () => {
    expect(normalizeDesktopSearchPayload({ query: '大寨', types: ['book'], callback: 'https://evil.example' }))
      .toEqual({ query: '大寨', types: ['book'] });
  });

  it('rejects malformed payloads without touching the network', async () => {
    const fetch = vi.fn();
    const invalid = [
      undefined,
      '大寨',
      [],
      {},
      { query: '   ' },
      { query: 42 },
      { query: '大寨', page: 0 },
      { query: '大寨', page: 1.5 },
      { query: '大寨', size: 51 },
      { query: '大寨', types: 'book' },
      { query: '大寨', types: [''] },
      { query: '大寨', startDate: '2026/01/01' },
      { query: '大'.repeat(201) },
    ];

    for (const payload of invalid) {
      expect(normalizeDesktopSearchPayload(payload)).toBeNull();
      await expect(handleDesktopSearchRequest(payload, { fetch, searchOrigin: DEFAULT_SEARCH_ORIGIN }))
        .resolves.toEqual({ ok: false, status: 400, error: '搜索请求无效' });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('accepts the date range shape the search page sends', () => {
    expect(normalizeDesktopSearchPayload({
      query: '大寨',
      startDate: '1946-05-15',
      endDate: '1949-09-30',
      sort: 'timeAsc',
      datasetIds: ['rmrb'],
    })).toEqual({
      query: '大寨',
      startDate: '1946-05-15',
      endDate: '1949-09-30',
      sort: 'timeAsc',
      datasetIds: ['rmrb'],
    });
  });

  it('refuses non-JSON fallbacks instead of exposing a broken payload', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('<!doctype html><title>JOJO</title>', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }));

    await expect(handleDesktopSearchRequest({ query: '大寨' }, { fetch, searchOrigin: DEFAULT_SEARCH_ORIGIN }))
      .resolves.toEqual({ ok: false, status: 502, error: '搜索服务入口返回了无效响应' });
  });

  it('reports upstream failures and network errors without leaking the body', async () => {
    const failing = vi.fn().mockResolvedValue(jsonResponse({ secret: 'internal' }, { status: 503 }));
    await expect(handleDesktopSearchRequest({ query: '大寨' }, { fetch: failing, searchOrigin: DEFAULT_SEARCH_ORIGIN }))
      .resolves.toEqual({ ok: false, status: 503, error: '搜索服务返回了异常状态' });

    const offline = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    await expect(handleDesktopSearchRequest({ query: '大寨' }, { fetch: offline, searchOrigin: DEFAULT_SEARCH_ORIGIN }))
      .resolves.toEqual({ ok: false, status: 502, error: '搜索服务暂时不可用' });
  });

  it('only permits local loopback overrides in development', () => {
    expect(resolveDesktopSearchOrigin(undefined, true)).toBe('https://s1.jojokanbao.cn');
    expect(resolveDesktopSearchOrigin('http://127.0.0.1:8787', false)).toBe('http://127.0.0.1:8787');
    expect(resolveDesktopSearchOrigin('http://127.0.0.1:8787', true)).toBe('https://s1.jojokanbao.cn');
    expect(resolveDesktopSearchOrigin('https://attacker.example', false)).toBe('https://s1.jojokanbao.cn');
    expect(resolveDesktopSearchOrigin('not a url', false)).toBe('https://s1.jojokanbao.cn');
  });
});
