// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  DESKTOP_AGENT_SCHEME,
  handleDesktopAgentRequest,
  registerDesktopAgentScheme,
  resolveDesktopReaderOrigin,
} from '../../electron/agent-gateway.js';

describe('desktop Agent gateway', () => {
  it('allows only the speech GET/POST pair and accepts CDN descriptors', async () => {
    const fetch = vi.fn().mockImplementation(async () => Response.json({ providers: [] }));
    const options = { fetch, readerOrigin: 'https://beta.jojokanbao.cn' };
    expect((await handleDesktopAgentRequest(new Request('jojo-agent://reader/api/v1/speech/providers'), options)).status).toBe(200);
    expect(fetch.mock.calls[0]![1].method).toBe('GET');
    expect(fetch.mock.calls[0]![1].body).toBeUndefined();
    expect((await handleDesktopAgentRequest(new Request('jojo-agent://reader/api/v1/speech', { method: 'POST', body: '{"text":"正文"}' }), options)).status).toBe(200);
    expect((await handleDesktopAgentRequest(new Request('jojo-agent://reader/api/v1/speech'), options)).status).toBe(405);
    expect((await handleDesktopAgentRequest(new Request('jojo-agent://reader/api/v1/speech', { method: 'POST', body: 'x'.repeat(8193) }), options)).status).toBe(413);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('registers a fetch-capable secure streaming scheme', () => {
    const registerSchemesAsPrivileged = vi.fn();
    registerDesktopAgentScheme({ registerSchemesAsPrivileged });

    expect(registerSchemesAsPrivileged).toHaveBeenCalledWith([{
      scheme: DESKTOP_AGENT_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    }]);
  });

  it('only permits local loopback overrides in development', () => {
    expect(resolveDesktopReaderOrigin(undefined, false)).toBe('https://beta.jojokanbao.cn');
    expect(resolveDesktopReaderOrigin('http://127.0.0.1:8787', false)).toBe('http://127.0.0.1:8787');
    expect(resolveDesktopReaderOrigin('http://127.0.0.1:8787', true)).toBe('https://beta.jojokanbao.cn');
    expect(resolveDesktopReaderOrigin('https://reader.jojokanbao.cn', true)).toBe('https://reader.jojokanbao.cn');
    expect(resolveDesktopReaderOrigin('https://attacker.example', false)).toBe('https://beta.jojokanbao.cn');
  });

  it('forwards an allow-listed streaming request without renderer-only headers', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: done\ndata: {}\n\n'));
        controller.close();
      },
    });
    const fetch = vi.fn().mockResolvedValue(new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'x-request-id': 'request-1',
        'set-cookie': 'private=value',
      },
    }));
    const response = await handleDesktopAgentRequest(new Request(
      'jojo-agent://reader/gateway/ask?desktop=1',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer reader-token',
          'content-type': 'application/json',
          'makers-conversation-id': 'conversation-1',
          cookie: 'must-not-forward',
        },
        body: JSON.stringify({ message: '测试' }),
      },
    ), { fetch, readerOrigin: 'https://reader.jojokanbao.cn' });

    const [target, init] = fetch.mock.calls[0] as [URL, RequestInit];
    expect(String(target)).toBe('https://reader.jojokanbao.cn/gateway/ask?desktop=1');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer reader-token');
    expect(new Headers(init.headers).get('cookie')).toBeNull();
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe('{"message":"测试"}');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.text()).toContain('event: done');
  });

  it('answers preflight and rejects unlisted routes without touching the network', async () => {
    const fetch = vi.fn();
    const options = await handleDesktopAgentRequest(
      new Request('jojo-agent://reader/gateway/times/explain', { method: 'OPTIONS' }),
      { fetch, readerOrigin: 'https://reader.jojokanbao.cn' },
    );
    expect(options.status).toBe(204);
    expect(options.headers.get('access-control-allow-methods')).toContain('POST');

    const rejected = await handleDesktopAgentRequest(
      new Request('jojo-agent://reader/gateway/credentials', { method: 'POST' }),
      { fetch, readerOrigin: 'https://reader.jojokanbao.cn' },
    );
    expect(rejected.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects oversized requests before forwarding them', async () => {
    const fetch = vi.fn();
    const response = await handleDesktopAgentRequest(
      new Request('jojo-agent://reader/gateway/ask', {
        method: 'POST',
        body: 'x'.repeat(64 * 1024 + 1),
      }),
      { fetch, readerOrigin: 'https://reader.jojokanbao.cn' },
    );

    expect(response.status).toBe(413);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a successful HTML fallback instead of exposing a broken stream', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('<!doctype html><title>JOJO</title>', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }));
    const response = await handleDesktopAgentRequest(
      new Request('jojo-agent://reader/gateway/times/explain', {
        method: 'POST',
        body: JSON.stringify({ message: '测试' }),
      }),
      { fetch, readerOrigin: 'https://reader.jojokanbao.cn' },
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: '问答服务入口返回了无效响应' });
  });
});
