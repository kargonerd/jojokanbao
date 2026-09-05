export const DESKTOP_AGENT_SCHEME = 'jojo-agent';

const DEFAULT_READER_ORIGIN = 'https://beta.jojokanbao.cn';
const TRUSTED_READER_ORIGINS = new Set([
  DEFAULT_READER_ORIGIN,
  'https://reader.jojokanbao.cn',
]);
const DESKTOP_AGENT_HOST = 'reader';
const ROUTE_LIMITS = new Map([
  ['/gateway/ask', 64 * 1024],
  ['/gateway/times/explain', 6 * 1024 * 1024],
  ['/api/v1/speech/providers', 0],
  ['/api/v1/speech', 8 * 1024],
]);
const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'authorization',
  'content-type',
  'makers-conversation-id',
];
const FORWARDED_RESPONSE_HEADERS = [
  'cache-control',
  'content-type',
  'retry-after',
  'x-accel-buffering',
  'x-request-id',
];

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': FORWARDED_REQUEST_HEADERS.join(', '),
};

function responseHeaders(source) {
  const headers = new Headers(CORS_HEADERS);
  if (source) {
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = source.get(name);
      if (value) headers.set(name, value);
    }
  }
  return headers;
}

function jsonError(status, error, extraHeaders = {}) {
  return Response.json({ error }, {
    status,
    headers: { ...CORS_HEADERS, 'cache-control': 'no-store', ...extraHeaders },
  });
}

export function registerDesktopAgentScheme(protocolModule) {
  protocolModule.registerSchemesAsPrivileged([{
    scheme: DESKTOP_AGENT_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  }]);
}

export function resolveDesktopReaderOrigin(configuredOrigin, isPackaged) {
  if (!configuredOrigin?.trim()) return DEFAULT_READER_ORIGIN;
  try {
    const candidate = new URL(configuredOrigin.trim());
    const loopback = ['127.0.0.1', '::1', 'localhost'].includes(candidate.hostname);
    if (!isPackaged && candidate.protocol === 'http:' && loopback) return candidate.origin;
    if (candidate.protocol === 'https:' && TRUSTED_READER_ORIGINS.has(candidate.origin)) {
      return candidate.origin;
    }
  } catch {
    // Invalid and unsafe overrides fall back to the production Reader.
  }
  return DEFAULT_READER_ORIGIN;
}

export async function handleDesktopAgentRequest(request, { fetch, readerOrigin }) {
  let incoming;
  try {
    incoming = new URL(request.url);
  } catch {
    return jsonError(400, 'Invalid desktop Agent request');
  }
  const maxBytes = ROUTE_LIMITS.get(incoming.pathname);
  if (incoming.hostname !== DESKTOP_AGENT_HOST || maxBytes === undefined) {
    return jsonError(404, 'Not found');
  }
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: responseHeaders() });
  }
  const method = incoming.pathname === '/api/v1/speech/providers' ? 'GET' : 'POST';
  const speech = incoming.pathname.startsWith('/api/v1/speech');
  if (request.method !== method) {
    return jsonError(405, 'Method not allowed', { allow: `${method}, OPTIONS` });
  }

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const target = new URL(`${incoming.pathname}${incoming.search}`, readerOrigin);
  try {
    const declaredLength = Number(request.headers.get('content-length') ?? '0');
    if (declaredLength > maxBytes) return jsonError(413, '问答内容过长');
    const body = await request.arrayBuffer();
    if (body.byteLength > maxBytes) return jsonError(413, '问答内容过长');
    const upstream = await fetch(target, {
      method,
      headers,
      body: method === 'POST' ? body : undefined,
      redirect: 'manual',
    });
    const contentType = upstream.headers.get('content-type')?.toLowerCase() ?? '';
    const validType = speech
      ? contentType.startsWith('application/json') || (method === 'POST' && contentType.startsWith('audio/'))
      : contentType.includes('text/event-stream');
    if (upstream.ok && !validType) {
      await upstream.body?.cancel().catch(() => undefined);
      return jsonError(502, '问答服务入口返回了无效响应');
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders(upstream.headers),
    });
  } catch {
    return jsonError(502, '问答服务暂时不可用');
  }
}
