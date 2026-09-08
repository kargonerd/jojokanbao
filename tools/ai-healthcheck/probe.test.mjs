import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectCompletion, probe } from './probe.mjs';
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
test('successful generation requires text and a normal terminal event', () => {
  assert.deepEqual(inspectCompletion(frame('text_delta', { delta: 'OK' }) + frame('done', { stopReason: 'stop', usage: { totalTokens: 12 } })), { tokens: 12 });
  assert.throws(() => inspectCompletion(frame('done', { stopReason: 'stop' })), /incomplete_generation/);
  assert.throws(() => inspectCompletion(frame('text_delta', { delta: 'OK' })), /incomplete_generation/);
});
test('HTTP 200 error streams identify quota and credential outages', () => {
  assert.throws(() => inspectCompletion(frame('error', { message: 'The usage limit has been reached' }) + frame('done', {})), /quota_exhausted/);
  assert.throws(() => inspectCompletion(frame('error', { message: 'OAuth refresh failed 401 refresh_token_reused' })), /provider_auth_failed/);
});
test('recoverable tool errors do not falsely mark a completed answer unavailable', () => {
  assert.deepEqual(inspectCompletion(frame('tool_end', { isError: true }) + frame('text_delta', { delta: 'OK' }) + frame('done', { stopReason: 'stop' })), { tokens: 0 });
});
test('aborted and truncated responses fail the probe', () => {
  for (const ending of [{ stopped: true }, { stopReason: 'length' }]) {
    assert.throws(() => inspectCompletion(frame('text_delta', { delta: 'partial' }) + frame('done', ending)), /incomplete_generation/);
  }
});

test('the probe authenticates, uses a valid Makers ID, reads SSE and logs out only its own session', async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/rag/health')) return Response.json({ ok: true, configured: true });
    if (url.includes('/token?')) return Response.json({ access_token: 'test-access-token' });
    if (url.endsWith('/rag')) {
      assert.ok(options.headers['Makers-Conversation-Id'].length <= 36);
      assert.equal(options.headers.Authorization, 'Bearer test-access-token');
      return new Response(frame('text_delta', { delta: 'OK' }) + frame('done', { stopReason: 'stop' }), { headers: { 'content-type': 'text/event-stream' } });
    }
    assert.ok(url.endsWith('/logout?scope=local'));
    return new Response(null, { status: 204 });
  };
  const result = await probe({ VITE_SUPABASE_URL: 'https://auth.example', VITE_SUPABASE_PUBLISHABLE_KEY: 'test-key', JOJO_AI_MONITOR_EMAIL: 'monitor@example.invalid', JOJO_AI_MONITOR_PASSWORD: 'test-password' }, fetcher);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 4);
});
