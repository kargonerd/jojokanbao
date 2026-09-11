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

const egress = {
  processId: '00000000-0000-4000-8000-000000000001',
  observedAt: '2026-09-10T00:00:00.000Z', durationMs: 10,
  observations: [
    { source: 'ipify', status: 'ok', ip: '2001:db8::1', family: 6 },
    { source: 'cloudflare', status: 'ok', ip: '192.0.2.1', family: 4, country: 'SG' },
  ],
};

test('diagnostics survive a location rejection and strip unexpected fields', () => {
  const diagnostics = frame('diagnostics', { egress: { ...egress, token: 'private-token',
    observations: egress.observations.map(item => ({ ...item, raw: 'private-body' })) } });
  assert.deepEqual(inspectCompletion(diagnostics + frame('text_delta', { delta: 'OK' })
    + frame('done', { stopReason: 'stop' })), { tokens: 0, egress });
  assert.throws(() => inspectCompletion(frame('error', { message: 'Antigravity API error (400): User location is not supported for the API use.' }) + diagnostics),
    error => error.message === 'provider_region_unsupported' && assert.deepEqual(error.details, { egress }) === undefined);
});

test('missing, timed out, or malformed diagnostics cannot mark successful generation down', () => {
  const success = frame('text_delta', { delta: 'OK' }) + frame('done', { stopReason: 'stop' });
  const failed = { ...egress, observations: egress.observations.map(({ source }) => ({ source, status: 'timeout' })) };
  assert.deepEqual(inspectCompletion(frame('diagnostics', { egress: failed }) + success), { tokens: 0, egress: failed });
  for (const payload of ['not-json', JSON.stringify({ egress: { ...egress, processId: 'private-secret' } }),
    JSON.stringify({ egress: { ...egress, observations: [{ ...egress.observations[0], ip: 'private-secret' }] } })]) {
    assert.deepEqual(inspectCompletion(`event: diagnostics\ndata: ${payload}\n\n` + success), { tokens: 0 });
  }
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

function fakeMonitor({ sse = successStream, logoutStatus = 204, logoutResponses, reportStatus = 200, probeError, reportError } = {}) {
  const calls = [];
  let logoutIndex = 0;
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
    assert.equal(options.redirect, 'manual');
    const response = logoutResponses?.[logoutIndex++];
    if (response instanceof Error) throw response;
    if (typeof response === 'function') return response(options);
    if (response) return response;
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

test('location failures keep the conversation and egress in CLI output with a valid buffered failure event', async () => {
  const { calls, fetcher } = fakeMonitor({ sse: frame('diagnostics', { egress })
    + frame('error', { message: 'User location is not supported for the API use. private-provider-token' }) });
  await assert.rejects(runHealthcheck(monitorEnv, fetcher), error => {
    assert.equal(error.message, 'provider_region_unsupported');
    assert.deepEqual(error.details.egress, egress);
    assert.match(error.details.conversationId, /^jojo-ai-health-[a-f0-9]{20}$/);
    assert.doesNotMatch(JSON.stringify(error.details), /private-provider-token/);
    return true;
  });
  const report = calls.at(-1).options.body;
  assert.equal(parseExecution(report, 'jojo-ai-availability', Date.now()).outcome, 'failure');
  assert.match(report, /failure_type=provider_region_unsupported\n/);
  assert.match(report, /conversation_id=jojo-ai-health-[a-f0-9]{20}\n/);
  assert.doesNotMatch(report, /private-provider-token/);
});

test('failed session cleanup cannot publish a successful buffered execution', async () => {
  const { calls, fetcher } = fakeMonitor({ logoutStatus: 503 });
  await assert.rejects(runHealthcheck(monitorEnv, fetcher), error => {
    assert.equal(error.message, 'monitor_logout_http_503');
    assert.equal(error.details.generationOk, true);
    assert.equal(error.details.tokens, 12);
    assert.equal(error.details.cleanup.ok, false);
    assert.deepEqual(error.details.cleanup.attempts.map(attempt => attempt.httpStatus), [503, 503, 503]);
    return true;
  });
  assert.equal(parseExecution(calls.at(-1).options.body, 'jojo-ai-availability', Date.now()).outcome, 'failure');
  assert.match(calls.at(-1).options.body, /generation_ok=true\ncleanup_ok=false\ncleanup_attempts=3\n/);
});

test('logout 409 retries only the same session and preserves safe diagnostics when it recovers', async () => {
  const requestId = '01a090f0-2605-70d7-baad-06a5394c0c69';
  const { calls, fetcher } = fakeMonitor({ logoutResponses: [
    Response.json({ code: 'conflict', message: 'private-session-token monitor@example.invalid', token: 'test-password' }, {
      status: 409, headers: { 'sb-request-id': requestId, 'cf-ray': '0123456789abcdef-SIN', server: 'cloudflare' },
    }),
    new Response(null, { status: 204 }),
  ] });
  const result = await runHealthcheck(monitorEnv, fetcher);
  assert.equal(result.ok, true);
  assert.deepEqual(result.cleanup.attempts[0], {
    httpStatus: 409, contentType: 'json', requestId, cfRay: '0123456789abcdef-SIN',
    server: 'cloudflare', errorCode: 'conflict', bodyStatus: 'json',
  });
  assert.equal(result.cleanup.attempts.length, 2);
  assert.ok(result.cleanup.durationMs >= 200, 'retry must back off');
  assert.equal(calls.filter(call => call.url.includes('/token?')).length, 1);
  assert.equal(calls.filter(call => call.url.endsWith('/rag')).length, 1);
  assert.equal(calls.filter(call => call.url.endsWith('/logout?scope=local')).length, 2);
  assert.equal(parseExecution(calls.at(-1).options.body, 'jojo-ai-availability', Date.now()).outcome, 'success');
  assert.match(calls.at(-1).options.body, /cleanup_ok=true\ncleanup_attempts=2\n/);
  assert.doesNotMatch(JSON.stringify(result), /private-session-token|monitor@example.invalid|test-password/);
});

test('a real model outage stays the primary failure even when logout also exhausts retries', async () => {
  const { calls, fetcher } = fakeMonitor({ logoutStatus: 409,
    sse: frame('diagnostics', { egress }) + frame('error', { message: 'OAuth refresh failed private-provider-token' }) });
  await assert.rejects(runHealthcheck(monitorEnv, fetcher), error => {
    assert.equal(error.message, 'provider_auth_failed');
    assert.equal(error.details.generationOk, false);
    assert.deepEqual(error.details.egress, egress);
    assert.match(error.details.conversationId, /^jojo-ai-health-[a-f0-9]{20}$/);
    assert.equal(error.details.cleanup.reason, 'monitor_logout_http_409');
    assert.equal(error.details.cleanup.attempts.length, 3);
    assert.doesNotMatch(JSON.stringify(error.details), /private-provider-token|private-session-token/);
    return true;
  });
  const report = calls.at(-1).options.body;
  assert.equal(parseExecution(report, 'jojo-ai-availability', Date.now()).permanent, true);
  assert.match(report, /failure_type=provider_auth_failed\n/);
  assert.match(report, /generation_ok=false\ncleanup_ok=false\ncleanup_attempts=3\ncleanup_failure_type=monitor_logout_http_409\n/);
});

test('network failures retry without exposing error messages and recognize an already revoked session', async () => {
  const { fetcher } = fakeMonitor({ logoutResponses: [
    new Error('private-session-token at https://auth.example'),
    Response.json({ error_code: 'session_not_found' }, { status: 403 }),
  ] });
  const result = await runHealthcheck(monitorEnv, fetcher);
  assert.equal(result.ok, true);
  assert.deepEqual(result.cleanup.attempts[0], { status: 'network_error' });
  assert.equal(result.cleanup.attempts[1].alreadyRevoked, true);
  assert.doesNotMatch(JSON.stringify(result), /private-session-token|auth.example/);
});

test('permanent HTTP errors and redirects fail cleanup without retry or credential forwarding', async (t) => {
  for (const status of [302, 400, 401, 403, 404]) {
    await t.test(String(status), async () => {
      const { calls, fetcher } = fakeMonitor({ logoutStatus: status });
      await assert.rejects(runHealthcheck(monitorEnv, fetcher), error => {
        assert.equal(error.message, `monitor_logout_http_${status}`);
        assert.equal(error.details.cleanup.attempts.length, 1);
        return true;
      });
      assert.equal(calls.length, 5);
    });
  }
});

test('untrusted response fields, HTML and oversized JSON cannot leak secrets or prevent cleanup retries', async (t) => {
  for (const [name, response, expected] of [
    ['untrusted fields', Response.json({ code: 'private_secret', message: 'private_message' }, {
      status: 409, headers: { 'sb-request-id': 'private_secret', 'x-request-id': 'private_secret',
        'cf-ray': 'private_secret', 'x-sb-error-code': 'private_secret', server: 'private_secret' },
    }), { httpStatus: 409, contentType: 'json', bodyStatus: 'json' }],
    ['HTML', new Response('<html>private_secret</html>', { status: 409, headers: { 'content-type': 'text/html' } }),
      { httpStatus: 409, contentType: 'html' }],
    ['large JSON', new Response(JSON.stringify({ message: 'private_secret'.repeat(500) }), {
      status: 409, headers: { 'content-type': 'application/json' },
    }), { httpStatus: 409, contentType: 'json', bodyStatus: 'too_large' }],
    ['invalid JSON', new Response('private_secret', { status: 409, headers: { 'content-type': 'application/json' } }),
      { httpStatus: 409, contentType: 'json', bodyStatus: 'unreadable' }],
  ]) {
    await t.test(name, async () => {
      const { fetcher } = fakeMonitor({ logoutResponses: [response] });
      const result = await runHealthcheck(monitorEnv, fetcher);
      assert.equal(result.ok, true);
      assert.deepEqual(result.cleanup.attempts[0], expected);
      assert.doesNotMatch(JSON.stringify(result), /private_secret|private_message/);
    });
  }
});

test('hung logout requests are aborted within the shared ten-second budget', async () => {
  const pending = ({ signal }) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('request was not aborted')), 20_000);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
  const { calls, fetcher } = fakeMonitor({ logoutResponses: [pending, pending, pending] });
  const started = Date.now();
  await assert.rejects(runHealthcheck(monitorEnv, fetcher), error => {
    assert.equal(error.message, 'monitor_logout_timeout');
    assert.equal(error.details.generationOk, true);
    assert.deepEqual(error.details.cleanup.attempts, Array(3).fill({ status: 'timeout' }));
    return true;
  });
  assert.ok(Date.now() - started < 11_000, 'cleanup must not allocate ten seconds per attempt');
  assert.equal(calls.filter(call => call.url.endsWith('/rag')).length, 1);
  assert.match(calls.at(-1).options.body, /failure_type=monitor_logout_timeout\n/);
});

test('a stalled error body times out and a stalled cancellation does not delay the next logout attempt', async () => {
  let bodyCancelled = false;
  const { fetcher } = fakeMonitor({ logoutResponses: [({ signal }) => new Response(new ReadableStream({
    start(controller) {
      const timer = setTimeout(() => controller.error(new Error('body was not aborted')), 20_000);
      signal.addEventListener('abort', () => { clearTimeout(timer); controller.error(signal.reason); }, { once: true });
    },
  }), { status: 409, headers: { 'content-type': 'application/json' } }),
  new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(4_097)); },
    cancel() { bodyCancelled = true; return new Promise(() => {}); },
  }), { status: 409, headers: { 'content-type': 'application/json' } }),
  ] });
  const result = await runHealthcheck(monitorEnv, fetcher);
  assert.equal(result.ok, true);
  assert.equal(result.cleanup.attempts.length, 3);
  assert.equal(result.cleanup.attempts[0].bodyStatus, 'unreadable');
  assert.equal(result.cleanup.attempts[1].bodyStatus, 'too_large');
  assert.ok(bodyCancelled);
  assert.ok(result.cleanup.durationMs < 5_000);
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
