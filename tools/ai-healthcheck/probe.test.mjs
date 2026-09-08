import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectCompletion, probe, runHealthcheck } from './probe.mjs';
import { parseExecution } from '../maintenance-scheduler/src/monitor-events.ts';
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

const monitorEnv = {
  VITE_SUPABASE_URL: 'https://auth.example',
  VITE_SUPABASE_PUBLISHABLE_KEY: 'test-key',
  JOJO_AI_MONITOR_EMAIL: 'monitor@example.invalid',
  JOJO_AI_MONITOR_PASSWORD: 'test-password',
  JOJO_AI_HEALTHCHECK_PING_URL: 'https://hc-ping.com/00000000-0000-4000-8000-000000000001',
  HEALTHCHECKS_REPORT_MODE: 'buffered',
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_REPOSITORY: 'kargonerd/jojokanbao',
  GITHUB_RUN_ID: '123',
  GITHUB_RUN_ATTEMPT: '2',
};
const successStream = frame('text_delta', { delta: 'OK' }) + frame('done', { stopReason: 'stop', usage: { totalTokens: 12 } });

function fakeMonitor({ sse = successStream, logoutStatus = 204, reportStatus = 200, probeError, reportError } = {}) {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (url.startsWith(monitorEnv.JOJO_AI_HEALTHCHECK_PING_URL)) {
      if (reportError) throw reportError;
      return new Response(null, { status: reportStatus });
    }
    if (url.endsWith('/rag/health')) {
      if (probeError) throw probeError;
      return Response.json({ ok: true, configured: true });
    }
    if (url.includes('/token?')) return Response.json({ access_token: 'private-session-token' });
    if (url.endsWith('/rag')) return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
    assert.ok(url.endsWith('/logout?scope=local'), `Unexpected request: ${url}`);
    assert.equal(options.headers.Authorization, 'Bearer private-session-token');
    return new Response(null, { status: logoutStatus });
  };
  return { calls, fetcher };
}

test('buffered success logs a consumer-compatible execution only after full SSE and session cleanup', async () => {
  const { calls, fetcher } = fakeMonitor();
  const before = Date.now();
  const result = await runHealthcheck(monitorEnv, fetcher);
  assert.equal(result.ok, true);
  assert.equal(result.tokens, 12);
  assert.equal(calls.length, 5);
  assert.ok(calls[3].url.endsWith('/logout?scope=local'));
  assert.equal(calls[4].url, `${monitorEnv.JOJO_AI_HEALTHCHECK_PING_URL}/log`);
  const event = parseExecution(calls[4].options.body, 'jojo-ai-availability', Date.now());
  assert.equal(event.id, '123:2');
  assert.equal(event.outcome, 'success');
  assert.equal(event.permanent, false);
  assert.ok(event.at >= before && event.at <= Date.now());
  assert.equal(event.run, 'https://github.com/kargonerd/jojokanbao/actions/runs/123');
  assert.match(calls[4].options.body, /failure_class=unknown\n/);
  assert.doesNotMatch(calls[4].options.body, /test-password|private-session-token|delta|text_delta/);
});

test('buffered failures log sanitized execution categories after logging out', async (t) => {
  for (const [sse, reason, permanent] of [
    [frame('error', { message: 'Quota usage limit reached: private-provider-token' }), 'quota_exhausted', false],
    [frame('error', { message: 'OAuth refresh failed: private-provider-token' }), 'provider_auth_failed', true],
    [frame('text_delta', { delta: 'partial private text' }), 'incomplete_generation', false],
  ]) {
    await t.test(reason, async () => {
      const { calls, fetcher } = fakeMonitor({ sse });
      await assert.rejects(runHealthcheck(monitorEnv, fetcher), { message: reason });
      assert.ok(calls[3].url.endsWith('/logout?scope=local'));
      const report = calls[4];
      assert.equal(report.url, `${monitorEnv.JOJO_AI_HEALTHCHECK_PING_URL}/log`);
      const event = parseExecution(report.options.body, 'jojo-ai-availability', Date.now());
      assert.equal(event.outcome, 'failure');
      assert.equal(event.permanent, permanent);
      assert.match(report.options.body, new RegExp(`failure_type=${reason}\\n`));
      assert.doesNotMatch(report.options.body, /private-provider-token|private-session-token|partial private text/);
    });
  }
});

test('failed session cleanup cannot publish a successful buffered execution', async () => {
  const { calls, fetcher } = fakeMonitor({ logoutStatus: 503 });
  await assert.rejects(runHealthcheck(monitorEnv, fetcher), { message: 'monitor_logout_http_503' });
  assert.equal(parseExecution(calls.at(-1).options.body, 'jojo-ai-availability', Date.now()).outcome, 'failure');
});

test('buffered identity is required and validated before any network or model work', async (t) => {
  const identityKeys = ['GITHUB_SERVER_URL', 'GITHUB_REPOSITORY', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'];
  const invalidIdentities = [
    ...identityKeys.map(key => [key, undefined]),
    ['GITHUB_SERVER_URL', 'http://github.com'],
    ['GITHUB_SERVER_URL', 'https://github.com.evil.example'],
    ['GITHUB_REPOSITORY', 'owner/repo\noutcome=success'],
    ['GITHUB_REPOSITORY', 'owner/..'],
    ['GITHUB_REPOSITORY', 'owner/repo/extra'],
    ['GITHUB_RUN_ID', '0'],
    ['GITHUB_RUN_ID', '123\ntask=another-task'],
    ['GITHUB_RUN_ID', '123\n'],
    ['GITHUB_RUN_ATTEMPT', 2],
    ['GITHUB_RUN_ATTEMPT', '1.5'],
    ['GITHUB_RUN_ATTEMPT', '-1'],
  ];
  for (const [key, value] of invalidIdentities) {
    await t.test(`${key}=${JSON.stringify(value)}`, async () => {
      const { calls, fetcher } = fakeMonitor();
      await assert.rejects(runHealthcheck({ ...monitorEnv, [key]: value }, fetcher), { message: 'monitor_execution_identity_invalid' });
      assert.equal(calls.length, 0);
    });
  }
});

test('unexpected probe errors are redacted even when their message resembles a category', async () => {
  const { calls, fetcher } = fakeMonitor({ probeError: new Error('private_secret_password') });
  await assert.rejects(runHealthcheck(monitorEnv, fetcher), { message: 'probe_network_or_protocol_error' });
  assert.equal(calls.length, 2);
  assert.doesNotMatch(calls[1].options.body, /private_secret_password/);
  assert.match(calls[1].options.body, /failure_type=probe_network_or_protocol_error\n/);
});

test('missing monitor credentials are a permanent buffered execution failure without model work', async () => {
  const { calls, fetcher } = fakeMonitor();
  await assert.rejects(runHealthcheck({ ...monitorEnv, JOJO_AI_MONITOR_PASSWORD: undefined }, fetcher), { message: 'monitor_credentials_missing' });
  assert.equal(calls.length, 1);
  assert.equal(parseExecution(calls[0].options.body, 'jojo-ai-availability', Date.now()).permanent, true);
});

test('a failed execution report fails the run and never sends a direct status fallback', async (t) => {
  for (const [options, reason] of [
    [{ reportStatus: 503 }, 'healthcheck_ping_http_503'],
    [{ reportError: new Error(`Network failure at ${monitorEnv.JOJO_AI_HEALTHCHECK_PING_URL}`) }, 'healthcheck_ping_failed'],
    [{ sse: frame('error', { message: 'OAuth refresh failed' }), reportStatus: 500 }, 'healthcheck_ping_http_500'],
  ]) {
    await t.test(reason, async () => {
      const { calls, fetcher } = fakeMonitor(options);
      await assert.rejects(runHealthcheck(monitorEnv, fetcher), { message: reason });
      const reports = calls.filter(call => call.url.startsWith(monitorEnv.JOJO_AI_HEALTHCHECK_PING_URL));
      assert.equal(reports.length, 1);
      assert.equal(reports[0].url, `${monitorEnv.JOJO_AI_HEALTHCHECK_PING_URL}/log`);
    });
  }
});

test('default direct mode remains usable locally without GitHub identity', async () => {
  const { calls, fetcher } = fakeMonitor();
  const result = await runHealthcheck({ ...monitorEnv, HEALTHCHECKS_REPORT_MODE: undefined, GITHUB_RUN_ID: undefined }, fetcher);
  assert.equal(result.ok, true);
  assert.equal(calls.at(-1).url, monitorEnv.JOJO_AI_HEALTHCHECK_PING_URL);
  assert.equal(JSON.parse(calls.at(-1).options.body).ok, true);
});
