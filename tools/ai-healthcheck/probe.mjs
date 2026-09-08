import { randomUUID } from 'node:crypto';

export function inspectCompletion(sse) {
  let text = '';
  let completed = false;
  let tokens = 0;
  for (const frame of sse.split(/\r?\n\r?\n/)) {
    const event = frame.match(/^event:\s*(.+)$/m)?.[1]?.trim();
    const payload = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
    if (!event || !payload) continue;
    const data = JSON.parse(payload);
    if (event === 'error') {
      const message = String(data.message ?? '').toLowerCase();
      const reason = /usage limit|quota|rate.limit/.test(message) ? 'quota_exhausted'
        : /refresh|oauth|unauthorized|401/.test(message) ? 'provider_auth_failed' : 'generation_failed';
      throw new Error(reason);
    }
    if (event === 'text_delta') text += String(data.delta ?? '');
    if (event === 'done') {
      completed = data.stopReason === 'stop' && !data.stopped;
      tokens = data.usage?.totalTokens ?? 0;
    }
  }
  if (!completed || !text.trim()) throw new Error('incomplete_generation');
  return { tokens };
}

export async function probe(env, fetcher = fetch) {
  const started = Date.now();
  const base = env.JOJO_AGENT_BASE_URL || 'https://agent-global.jojokanbao.cn';
  const auth = env.VITE_SUPABASE_URL?.replace(/\/$/, '');
  const key = env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!auth || !key || !env.JOJO_AI_MONITOR_EMAIL || !env.JOJO_AI_MONITOR_PASSWORD) throw new Error('monitor_credentials_missing');
  // Makers accepts at most 36 characters in this header.
  const conversationId = `jojo-ai-health-${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const headers = { 'Makers-Conversation-Id': conversationId, 'Content-Type': 'application/json' };
  const signal = AbortSignal.timeout(60_000);
  const health = await fetcher(`${base}/rag/health`, { headers, signal });
  if (!health.ok) throw new Error(`health_http_${health.status}`);
  const config = await health.json();
  if (!config.ok || !config.configured) throw new Error('provider_not_configured');
  const login = await fetcher(`${auth}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: key, 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ email: env.JOJO_AI_MONITOR_EMAIL, password: env.JOJO_AI_MONITOR_PASSWORD }),
  });
  if (!login.ok) throw new Error(`monitor_login_http_${login.status}`);
  const session = await login.json();
  if (!session.access_token) throw new Error('monitor_session_missing');
  try {
    const response = await fetcher(`${base}/rag`, {
      method: 'POST', headers: { ...headers, Authorization: `Bearer ${session.access_token}` }, signal,
      body: JSON.stringify({ message: '这是服务可用性探测。不要调用任何工具，不要检索资料，只回复 OK。' }),
    });
    if (!response.ok) throw new Error(`agent_http_${response.status}`);
    if (!response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('invalid_stream_type');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let sse = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sse += decoder.decode(value, { stream: true });
        if (sse.length > 64_000) throw new Error('probe_response_too_large');
      }
      sse += decoder.decode();
    } finally {
      await reader.cancel().catch(() => {});
    }
    return { ok: true, conversationId, durationMs: Date.now() - started, ...inspectCompletion(sse) };
  } finally {
    // Revoke only this probe's session, never another user's or another run's.
    const logout = await fetcher(`${auth}/auth/v1/logout?scope=local`, {
      method: 'POST', headers: { apikey: key, Authorization: `Bearer ${session.access_token}` }, signal: AbortSignal.timeout(10_000),
    });
    if (!logout.ok) throw new Error(`monitor_logout_http_${logout.status}`);
  }
}

export async function runHealthcheck(env, fetcher = fetch) {
  if (!env.JOJO_AI_HEALTHCHECK_PING_URL) throw new Error('healthcheck_ping_missing');
  const ping = async (suffix, result) => {
    const response = await fetcher(`${env.JOJO_AI_HEALTHCHECK_PING_URL.replace(/\/$/, '')}${suffix}`, {
      method: 'POST', body: JSON.stringify(result), signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`healthcheck_ping_http_${response.status}`);
  };
  let result;
  try {
    result = await probe(env, fetcher);
  } catch (error) {
    // Only structured categories leave the process; never log prompts or tokens.
    const reason = /^[a-z_]+(?:\d+)?$/.test(error.message) ? error.message : 'probe_network_or_protocol_error';
    await ping('/fail', { ok: false, reason });
    throw new Error(reason);
  }
  await ping('', result);
  return result;
}
