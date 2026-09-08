import { describe, expect, it } from 'vitest';
import { runHealthcheck } from '../../ai-healthcheck/probe.mjs';
import { parseExecution } from '../src/monitor-events';
import { configuredMonitor } from '../src/monitor-object';
import { applyExecution, initialState } from '../src/monitor-policy';

const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const env = {
  VITE_SUPABASE_URL: 'https://auth.example', VITE_SUPABASE_PUBLISHABLE_KEY: 'public-test',
  JOJO_AI_MONITOR_EMAIL: 'monitor@example.invalid', JOJO_AI_MONITOR_PASSWORD: 'test-password',
  JOJO_AI_HEALTHCHECK_PING_URL: 'https://hc-ping.com/11111111-1111-4111-8111-111111111111',
  HEALTHCHECKS_REPORT_MODE: 'buffered', GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1',
};

async function reportFixture(outcome, runId) {
  let body;
  const fetcher = async (input, options) => {
    const url = String(input);
    if (url.endsWith('/rag/health')) return Response.json({ ok: true, configured: true });
    if (url.includes('/token?')) return Response.json({ access_token: 'session-test' });
    if (url.endsWith('/rag')) return new Response(outcome === 'failure'
      ? frame('error', { message: 'OAuth refresh failed 401' })
      : frame('text_delta', { delta: 'OK' }) + frame('done', { stopReason: 'stop' }),
    { headers: { 'content-type': 'text/event-stream' } });
    if (url.endsWith('/logout?scope=local')) return new Response(null, { status: 204 });
    expect(url).toBe(`${env.JOJO_AI_HEALTHCHECK_PING_URL}/log`);
    body = options.body;
    return new Response(null, { status: 200 });
  };
  const operation = runHealthcheck({ ...env, GITHUB_RUN_ID: runId }, fetcher);
  if (outcome === 'failure') await expect(operation).rejects.toThrow('provider_auth_failed');
  else await expect(operation).resolves.toMatchObject({ ok: true });
  expect(typeof body).toBe('string');
  return parseExecution(body, 'jojo-ai-availability', Date.now());
}

describe('AI probe and scheduler monitoring integration', () => {
  it('consumes real producer events, alerts once on failure, and recovers only on a successful probe', async () => {
    const { check, policy } = configuredMonitor('jojo-ai-availability');
    expect(policy.executionFailures).toBe(1);
    const state = initialState(check, '11111111-1111-4111-8111-111111111111', Date.now());
    const failure = await reportFixture('failure', '123');
    expect(failure).toMatchObject({ id: '123:1', outcome: 'failure' });
    applyExecution(state, check, policy, failure);
    expect(state).toMatchObject({ down: true, executionFailures: 1, pending: { signal: 'fail' } });
    applyExecution(state, check, policy, failure);
    expect(state.executionFailures).toBe(1);

    const success = await reportFixture('success', '124');
    expect(success).toMatchObject({ id: '124:1', outcome: 'success' });
    applyExecution(state, check, policy, success);
    expect(state).toMatchObject({ down: false, executionFailures: 0, pending: { signal: 'success' } });
    expect(state.lastSuccessAt).toBe(success.at);
  });
});
