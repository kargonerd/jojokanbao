import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { probe } from '../../email-healthcheck/probe.mjs';
import { runHealthcheck } from '../../email-healthcheck/run.mjs';
import { parseEmailObservation } from '../src/email-events';
import { applyEmailObservation, initialEmailState } from '../src/email-policy';

const NOW = Date.parse('2026-09-09T00:08:01.000Z');
const uuid = (value) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const env = {
  RESEND_MONITOR_API_KEY: 'private-resend-key',
  JOJO_EMAIL_SENDER: 'auth@example.com',
  JOJO_EMAIL_MONITOR_ADDRESS: 'delivered+jojo-monitor@resend.dev',
  VITE_SUPABASE_URL: 'https://testproject.supabase.co',
  VITE_SUPABASE_PUBLISHABLE_KEY: 'private-publishable-key',
  JOJO_EMAIL_HEALTHCHECK_PING_URL: `https://hc-ping.com/${uuid(999)}`,
  GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'kargonerd/jojokanbao',
  GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1',
};
const check = {
  name: 'Email delivery', slug: 'jojo-email-delivery', schedule: '8,23,38,53 * * * *',
  timeZone: 'UTC', graceSeconds: 1200, tags: 'test', description: 'Offline protocol fixture',
};
const message = (value, status = 'delivered', createdAt = Date.now() - 1000) => ({
  id: uuid(value), created_at: new Date(createdAt).toISOString(), last_event: status,
  from: `JOJO <${env.JOJO_EMAIL_SENDER}>`, to: ['private-recipient@example.net'],
  subject: 'private-subject', html: '<p>private-OTP</p>',
});
const page = (messages, more = false) => Response.json({ object: 'list', has_more: more, data: messages });

// Use both real production functions. Only external HTTP and time are replaced.
async function observe({ records = [], scanStatus = 200, partialStatus, transportStatus, transportId = 88, unexpected = false, runId = '123' } = {}) {
  let recovered = false;
  let pages = 0;
  let body;
  const calls = [];
  const input = { ...env, GITHUB_RUN_ID: runId, ...(transportStatus ? { JOJO_EMAIL_VERIFY_TRANSPORT: 'true' } : {}) };
  const fetcher = async (url, options) => {
    calls.push({ url, method: options.method });
    if (url === `${env.JOJO_EMAIL_HEALTHCHECK_PING_URL}/log`) {
      body = options.body;
      return new Response('OK');
    }
    if (url === `${env.VITE_SUPABASE_URL}/auth/v1/recover`) {
      expect(options.method).toBe('POST');
      expect(JSON.parse(options.body)).toEqual({ email: env.JOJO_EMAIL_MONITOR_ADDRESS });
      recovered = true;
      return Response.json({ private: 'private-OTP' });
    }
    expect(url).toBe(`https://api.resend.com/emails?limit=100${partialStatus && pages > 0 ? `&after=${records.at(-1).id}` : ''}`);
    expect(options.method).toBe('GET');
    pages += 1;
    if (scanStatus !== 200) return new Response('private-provider-body private-recipient@example.net', { status: scanStatus });
    if (partialStatus) return pages === 1 ? page(records, true) : new Response('private-provider-body', { status: partialStatus });
    if (recovered) return page([{ ...message(transportId, transportStatus, Date.now()), to: [env.JOJO_EMAIL_MONITOR_ADDRESS] }]);
    return page(records);
  };
  const actualProbe = (value, network) => probe(value, network, {
    now: () => Date.now(), sleep: async (ms) => { vi.setSystemTime(Date.now() + ms); },
  });
  const summary = await runHealthcheck(input, fetcher, unexpected
    ? async () => { throw new Error('private-resend-key private-recipient@example.net private-OTP'); }
    : actualProbe);
  expect(typeof body).toBe('string');
  for (const privateValue of [env.RESEND_MONITOR_API_KEY, env.VITE_SUPABASE_PUBLISHABLE_KEY,
    env.JOJO_EMAIL_MONITOR_ADDRESS, env.JOJO_EMAIL_SENDER, 'private-recipient', 'private-subject', 'private-OTP', 'private-provider-body']) {
    expect(body).not.toContain(privateValue);
  }
  expect(calls.filter((call) => call.url.startsWith('https://hc-ping.com/'))).toEqual([
    { url: `${env.JOJO_EMAIL_HEALTHCHECK_PING_URL}/log`, method: 'POST' },
  ]);
  return { summary, observation: parseEmailObservation(body, Date.now()), calls };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => vi.useRealTimers());

describe('email producer and scheduler consumer protocol', () => {
  it('accepts a real empty scan without declaring SMTP healthy', async () => {
    const { summary, observation } = await observe();
    expect(summary).toMatchObject({ ok: true, scannedMessages: 0, transport: 'not_run' });
    const state = initialEmailState(check, uuid(999), NOW);
    applyEmailObservation(state, check, observation);
    expect(state.status).toBe('unknown');
    expect(state.transport.lastSuccessAt).toBe(0);
    expect(state.pending).toBeUndefined();
  });

  it('accepts sanitized API failures as collector incidents', async () => {
    const { summary, observation } = await observe({ scanStatus: 401 });
    expect(summary.ok).toBe(false);
    const state = initialEmailState(check, uuid(999), NOW);
    applyEmailObservation(state, check, observation);
    expect(state).toMatchObject({ status: 'down', collector: { incident: { reason: 'resend_http_401' } }, pending: { signal: 'fail' } });
  });

  it('keeps a delivery failure down across duplicate and later empty scans', async () => {
    const state = initialEmailState(check, uuid(999), NOW);
    const failed = await observe({ records: [message(1, 'failed')] });
    applyEmailObservation(state, check, failed.observation);
    expect(state).toMatchObject({ status: 'down', delivery: { incident: { reason: 'email_failed' } } });
    const snapshot = JSON.stringify(state);
    applyEmailObservation(state, check, failed.observation);
    expect(JSON.stringify(state)).toBe(snapshot);
    vi.setSystemTime(NOW + 60_000);
    const empty = await observe({ runId: '124' });
    applyEmailObservation(state, check, empty.observation);
    expect(state).toMatchObject({ status: 'down', delivery: { incident: { reason: 'email_failed' } } });
  });

  it('accepts the actual failed transport event including its message ID', async () => {
    const { summary, observation, calls } = await observe({ transportStatus: 'suppressed' });
    expect(summary.ok).toBe(false);
    expect(observation.transportProbe).toMatchObject({ outcome: 'failure', reason: 'transport_delivery_failed', messageId: uuid(88) });
    expect(calls.filter((call) => call.url.endsWith('/recover'))).toHaveLength(1);
    const state = initialEmailState(check, uuid(999), NOW);
    applyEmailObservation(state, check, observation);
    expect(state).toMatchObject({ status: 'down', transport: { incident: { reason: 'transport_delivery_failed' } }, pending: { signal: 'fail' } });
  });

  it('keeps a failure observed before a pagination error when the next complete scan is empty', async () => {
    const state = initialEmailState(check, uuid(999), NOW);
    const healthy = await observe({ transportStatus: 'delivered' });
    applyEmailObservation(state, check, healthy.observation);
    expect(state.status).toBe('up');
    vi.setSystemTime(NOW + 60_000);
    const partial = await observe({ records: [message(1, 'failed', NOW - 86_400_000 + 90_000)], partialStatus: 429, runId: '124' });
    expect(partial.observation).toMatchObject({ scanComplete: false, scanError: 'resend_http_429', messages: [{ id: uuid(1), status: 'failed' }] });
    applyEmailObservation(state, check, partial.observation);
    vi.setSystemTime(NOW + 120_000);
    const empty = await observe({ runId: '125' });
    applyEmailObservation(state, check, empty.observation);
    expect(state).toMatchObject({ status: 'down', delivery: { incident: { reason: 'email_failed' } } });
  });

  it('keeps a transport failure through an empty scan and recovers with fresh verified delivery', async () => {
    const state = initialEmailState(check, uuid(999), NOW);
    const failure = await observe({ transportStatus: 'failed' });
    applyEmailObservation(state, check, failure.observation);
    vi.setSystemTime(NOW + 60_000);
    const empty = await observe({ runId: '124' });
    applyEmailObservation(state, check, empty.observation);
    expect(state).toMatchObject({ status: 'down', transport: { incident: { reason: 'transport_delivery_failed' } } });
    vi.setSystemTime(NOW + 120_000);
    const success = await observe({ transportStatus: 'delivered', transportId: 89, runId: '125' });
    applyEmailObservation(state, check, success.observation);
    expect(state).toMatchObject({ status: 'up', transport: { lastSuccessAt: NOW + 120_000 }, pending: { signal: 'success' } });
    expect(state.transport.incident).toBeUndefined();
  });

  it('requires a new business delivery to recover a business failure, not synthetic or old mail', async () => {
    const state = initialEmailState(check, uuid(999), NOW);
    const failed = await observe({ records: [message(1, 'failed')] });
    applyEmailObservation(state, check, failed.observation);
    vi.setSystemTime(NOW + 60_000);
    const synthetic = await observe({ transportStatus: 'delivered', runId: '124' });
    expect(synthetic.observation.messages).toEqual([]);
    applyEmailObservation(state, check, synthetic.observation);
    expect(state).toMatchObject({ status: 'down', delivery: { incident: { reason: 'email_failed' } } });
    vi.setSystemTime(NOW + 120_000);
    const oldDelivery = await observe({ records: [message(2, 'delivered', NOW - 1000)], runId: '125' });
    applyEmailObservation(state, check, oldDelivery.observation);
    expect(state).toMatchObject({ status: 'down', delivery: { incident: { reason: 'email_failed' } } });
    vi.setSystemTime(NOW + 180_000);
    const newDelivery = await observe({ records: [message(3, 'delivered', NOW + 120_000)], runId: '126' });
    applyEmailObservation(state, check, newDelivery.observation);
    expect(state).toMatchObject({ status: 'up', pending: { signal: 'success' } });
    expect(state.delivery.incident).toBeUndefined();
  });

  it('retains an unresolved delayed email through empty scans until that email is delivered', async () => {
    const state = initialEmailState(check, uuid(999), NOW);
    const createdAt = NOW - 11 * 60_000;
    const delayed = await observe({ records: [message(1, 'sent', createdAt)] });
    applyEmailObservation(state, check, delayed.observation);
    expect(state).toMatchObject({ status: 'down', pending: { signal: 'fail', reason: 'email_delivery_delayed' } });
    vi.setSystemTime(NOW + 60_000);
    const synthetic = await observe({ transportStatus: 'delivered', runId: '124' });
    applyEmailObservation(state, check, synthetic.observation);
    expect(state).toMatchObject({ status: 'down', pending: { signal: 'fail', reason: 'email_delivery_delayed' } });
    vi.setSystemTime(NOW + 120_000);
    const partialDelivery = await observe({ records: [message(1, 'delivered', createdAt)], partialStatus: 429, runId: '125' });
    applyEmailObservation(state, check, partialDelivery.observation);
    vi.setSystemTime(NOW + 180_000);
    const empty = await observe({ runId: '126' });
    applyEmailObservation(state, check, empty.observation);
    expect(state).toMatchObject({ status: 'down', pending: { signal: 'fail', reason: 'email_delivery_delayed' } });
    vi.setSystemTime(NOW + 240_000);
    const resolved = await observe({ records: [message(1, 'delivered', createdAt)], runId: '127' });
    applyEmailObservation(state, check, resolved.observation);
    expect(state).toMatchObject({ status: 'up', pending: { signal: 'success' } });
  });

  it('accepts the real runner fallback without leaking unexpected exception details', async () => {
    const { summary, observation } = await observe({ unexpected: true });
    expect(summary.ok).toBe(false);
    const state = initialEmailState(check, uuid(999), NOW);
    applyEmailObservation(state, check, observation);
    expect(state).toMatchObject({ status: 'down', collector: { incident: { reason: 'probe_internal_error' } }, pending: { signal: 'fail' } });
  });
});
